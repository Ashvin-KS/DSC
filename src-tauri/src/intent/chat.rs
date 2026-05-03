use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;
use keyring::Entry;

use crate::services::query_engine::{
    run_agentic_search_with_steps_and_history_and_scope, AgentResult, AgentStep, ChatMessage as QEMessage,
    cancel_chat_stream, reset_chat_cancel,
};
use crate::models::{Settings, AISettings};

#[tauri::command]
pub fn cancel_chat() -> Result<bool, String> {
    cancel_chat_stream();
    Ok(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageResponse {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<Vec<AgentStep>>,
    pub activities: Option<Vec<serde_json::Value>>,
    pub created_at: i64,
    pub metadata: Option<String>,
}

// AgentStep is imported from query_engine module



// ─── blocking DB helpers (no async, conn safe) ────────────────────────────────

fn db_create_session(conn: &rusqlite::Connection) -> Result<ChatSession, String> {
    let s = ChatSession {
        id:         Uuid::new_v4().to_string(),
        title:      "New Chat".to_string(),
        created_at: Utc::now().timestamp(),
        updated_at: Utc::now().timestamp(),
    };
    conn.execute(
        "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![s.id, s.title, s.created_at, s.updated_at],
    ).map_err(|e| e.to_string())?;
    Ok(s)
}

fn db_get_sessions(conn: &rusqlite::Connection) -> Result<Vec<ChatSession>, String> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.title, s.created_at, s.updated_at
         FROM chat_sessions s
         WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id)
         ORDER BY s.updated_at DESC
         LIMIT 200",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ChatSession {
        id:         row.get(0)?,
        title:      row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.map_err(|e| eprintln!("[db] chat session row error: {e}")).ok()).collect())
}

fn db_get_messages(conn: &rusqlite::Connection, session_id: &str) -> Result<Vec<ChatMessageResponse>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at, agent_steps, activities, metadata
         FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([session_id], |row| Ok(ChatMessageResponse {
        id:         row.get(0)?,
        session_id: row.get(1)?,
        role:       row.get(2)?,
        content:    row.get(3)?,
        created_at: row.get(4)?,
        tool_calls: row.get::<_, Option<String>>(5)?.and_then(|s| serde_json::from_str::<Vec<AgentStep>>(&s).ok()),
        activities: row.get::<_, Option<String>>(6)?.and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok()),
        metadata:   row.get(7)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.map_err(|e| eprintln!("[db] chat message row error: {e}")).ok()).collect())
}

fn db_store_user_msg(conn: &rusqlite::Connection, session_id: &str, message: &str, now: i64) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![session_id, "user", message, now],
    ).map_err(|e| e.to_string())?;
    let msg_id = conn.last_insert_rowid();

    let summary = format!("User chat message in session {}", session_id);
    let _ = crate::intent::retrieval::upsert_retrieval_chunk(
        conn,
        crate::intent::retrieval::ChunkInput {
            entity_type: "chat_message",
            entity_id: &msg_id.to_string(),
            source_type: "chat_user",
            chunk_text: message,
            chunk_summary: Some(summary),
            project_root: None,
            source_ts: Some(now),
        },
    );

    let msg_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chat_messages WHERE session_id = ?1",
        [session_id], |row| row.get(0),
    ).unwrap_or(0);

    if msg_count <= 1 {
        let title = if message.len() > 50 {
            let end = message.char_indices().nth(50).map(|(i, _)| i).unwrap_or(message.len());
            format!("{}…", &message[..end])
        } else { message.to_string() };
        let _ = conn.execute(
            "UPDATE chat_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, now, session_id],
        );
    } else {
        let _ = conn.execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, session_id],
        );
    }
    Ok(msg_id)
}

/// FIXED: API keys are stored in the OS keyring after settings_save (deleted from SQLite).
/// Read from keyring first, then fall back to SQLite (legacy) and finally env vars.
fn infer_provider_from_model(model: &str) -> String {
    let lower = model.trim().to_lowercase();
    if lower.starts_with("gemini") || lower.starts_with("models/gemini") {
        "gemini".to_string()
    } else if lower.starts_with("gpt-") || lower.starts_with('o') {
        "openai".to_string()
    } else if lower.starts_with("claude") {
        "anthropic".to_string()
    } else if lower.contains("groq") || lower.starts_with("llama-3.3") || lower.starts_with("mixtral") {
        "groq".to_string()
    } else {
        "nvidia".to_string()
    }
}

fn db_get_api_keys(conn: &rusqlite::Connection) -> Option<String> {
    let model = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'default_model'",
        [], |row| row.get::<_, String>(0),
    ).unwrap_or_default();
    let provider = infer_provider_from_model(&model);

    let key_name = match provider.to_lowercase().as_str() {
        "openai" => "openai_api_key",
        "anthropic" => "anthropic_api_key",
        "groq" => "groq_api_key",
        "gemini" => "gemini_api_key",
        _ => "nvidia_api_key",
    };

    // Try OS keyring first (primary storage after settings_save)
    if let Ok(entry) = Entry::new("Atheletia", key_name) {
        if let Ok(pwd) = entry.get_password() {
            if !pwd.trim().is_empty() {
                return Some(pwd);
            }
        }
    }

    // Fallback: SQLite (legacy path, before keyring migration)
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key_name], |row| row.get::<_, String>(0),
    ).ok().filter(|s| !s.is_empty())
    .or_else(|| {
        // Last resort: environment variables
        let env_key = match provider.to_lowercase().as_str() {
            "openai" => "OPENAI_API_KEY",
            "anthropic" => "ANTHROPIC_API_KEY",
            "groq" => "GROQ_API_KEY",
            "gemini" => "GEMINI_API_KEY",
            _ => "NVIDIA_API_KEY",
        };
        std::env::var(env_key).ok().filter(|s| !s.is_empty())
    })
}

fn db_store_assistant_msg(
    conn: &rusqlite::Connection,
    session_id: &str,
    content: &str,
    tool_calls: Option<&str>,
    activities: Option<&str>,
    metadata: Option<&str>,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, created_at, agent_steps, activities, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![session_id, "assistant", content, now, tool_calls, activities, metadata],
    ).map_err(|e| e.to_string())?;
    let msg_id = conn.last_insert_rowid();
    let summary = format!("Assistant reply in session {}", session_id);
    let _ = crate::intent::retrieval::upsert_retrieval_chunk(
        conn,
        crate::intent::retrieval::ChunkInput {
            entity_type: "chat_message",
            entity_id: &msg_id.to_string(),
            source_type: "chat_assistant",
            chunk_text: content,
            chunk_summary: Some(summary),
            project_root: None,
            source_ts: Some(now),
        },
    );
    Ok(msg_id)
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_chat_session(app_handle: AppHandle) -> Result<ChatSession, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    db_create_session(&conn)
}

#[tauri::command]
pub async fn get_chat_sessions(app_handle: AppHandle) -> Result<Vec<ChatSession>, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    db_get_sessions(&conn)
}

#[tauri::command]
pub async fn delete_chat_session(app_handle: AppHandle, session_id: String) -> Result<bool, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    let mut stmt = conn.prepare("SELECT id FROM chat_messages WHERE session_id = ?1").map_err(|e| e.to_string())?;
    let message_ids: Vec<i64> = stmt
        .query_map([&session_id], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for message_id in message_ids {
        crate::intent::retrieval::delete_retrieval_chunks_for_entity(&conn, "chat_message", &message_id.to_string())?;
    }
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", [&session_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [&session_id]).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn get_chat_messages(app_handle: AppHandle, session_id: String) -> Result<Vec<ChatMessageResponse>, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    db_get_messages(&conn, &session_id)
}

#[tauri::command]
pub async fn send_chat_message(
    app_handle: AppHandle,
    session_id: String,
    message: String,
    model: Option<String>,
    provider: Option<String>,
    time_range: Option<String>,
    selected_sources: Option<Vec<String>>,
    sources: Option<Vec<String>>,
    api_key: Option<String>,
) -> Result<ChatMessageResponse, String> {
    reset_chat_cancel();
    let now = Utc::now().timestamp();
    let effective_sources = if sources.is_some() { sources } else { selected_sources };

    // Store user message in database
    tokio::task::spawn_blocking({
        let app2 = app_handle.clone();
        let sid   = session_id.clone();
        let msg   = message.clone();
        move || {
            if let Ok(conn) = crate::intent::db::open(&app2) {
                let _ = db_store_user_msg(&conn, &sid, &msg, now);
            }
        }
    }).await.map_err(|e| e.to_string())?;

    // Use passed api_key if provided, otherwise fetch from database
    let effective_api_key = if api_key.as_ref().filter(|k| !k.is_empty()).is_some() {
        api_key
    } else {
        tokio::task::spawn_blocking({
            let app2 = app_handle.clone();
            move || -> Option<String> {
                let Ok(conn) = crate::intent::db::open(&app2) else {
                    return None;
                };
                db_get_api_keys(&conn)
            }
        }).await.map_err(|e| e.to_string())?
    };

    // Fetch prior messages
    let prior_messages: Vec<ChatMessageResponse> = tokio::task::spawn_blocking({
        let app2 = app_handle.clone();
        let sid   = session_id.clone();
        move || -> Vec<ChatMessageResponse> {
            let Ok(conn) = crate::intent::db::open(&app2) else {
                return Vec::new();
            };
            db_get_messages(&conn, &sid).unwrap_or_default()
        }
    }).await.map_err(|e| e.to_string())?;

    // Convert prior messages to query engine format (exclude the one we just added)
    // Truncate to last 20 messages to avoid unbounded context growth
    let prior_qe_messages: Vec<QEMessage> = prior_messages
        .iter()
        .filter(|m| m.created_at < now)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(20)
        .rev()
        .map(|m| QEMessage {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect();

    // Build settings from stored API key and model
    let settings = Settings {
        version: "1.0.0".to_string(),
        general: crate::models::GeneralSettings::default(),
        tracking: crate::models::TrackingSettings::default(),
        storage: crate::models::StorageSettings::default(),
        ai: {
            let prov = provider.as_deref().unwrap_or("nvidia").to_lowercase();
            let is_local = prov == "local" || prov == "lmstudio";
            AISettings {
                enabled: true,
                provider: prov.clone(),
                api_key: effective_api_key.unwrap_or_default(),
                model: model.unwrap_or_else(|| "meta/llama-3.3-70b-instruct".to_string()),
                local_only: is_local,
                fallback_to_local: true,
                lmstudio_url: None,
            }
        },
        privacy: crate::models::PrivacySettings::default(),
        notifications: crate::models::NotificationSettings::default(),
    };

    // Use the agentic query engine from intent-flow-main
    let agent_result: AgentResult = run_agentic_search_with_steps_and_history_and_scope(
        &app_handle,
        &message,
        &settings,
        &prior_qe_messages,
        time_range.as_deref(),
        effective_sources.as_deref(),
    ).await?;

    // Use agent_result directly (same as intent-flow-main)
    let steps_json = serde_json::to_string(&agent_result.steps).ok();
    let activities_json = serde_json::to_string(&agent_result.activities_referenced).ok();
    
    // metadata_json is not currently generated from agent_result - set to None
    let metadata_json: Option<String> = None;

    // Ensure we have a non-empty answer
    let answer = if agent_result.answer.trim().is_empty() {
        "I processed your request but couldn't generate a detailed response. Please try asking in a different way or check your activity data.".to_string()
    } else {
        agent_result.answer
    };

    // Phase 3: sync store assistant reply
    let metadata_json_for_closure = metadata_json.clone();
    let (msg_id, response_time) = tokio::task::spawn_blocking({
        let app2   = app_handle.clone();
        let sid    = session_id.clone();
        let reply  = answer.clone();
        let tool_calls = steps_json.clone();
        let activities = activities_json.clone();
        let metadata = metadata_json_for_closure;
        move || -> Result<(i64, i64), String> {
            let rt = Utc::now().timestamp();
            let conn = crate::intent::db::open(&app2)?;
            let id = db_store_assistant_msg(
                &conn,
                &sid,
                &reply,
                tool_calls.as_deref(),
                activities.as_deref(),
                metadata.as_deref(),
                rt,
            )?;
            Ok((id, rt))
        }
    }).await.map_err(|e| e.to_string())??;

    Ok(ChatMessageResponse {
        id:         msg_id,
        session_id,
        role:       "assistant".to_string(),
        content:    answer,
        tool_calls: Some(agent_result.steps),
        activities: Some(agent_result.activities_referenced),
        created_at: response_time,
        metadata:   metadata_json,
    })
}
