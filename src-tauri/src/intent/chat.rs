use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use uuid::Uuid;

use crate::services::query_engine::{
    run_agentic_search_with_steps_and_history_and_scope, AgentResult, AgentStep, ChatMessage as QEMessage,
};
use crate::models::{Settings, AISettings};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConfirmActionPayload {
    kind: String,
    reason: String,
    suggested_time_range: Option<String>,
    enable_sources: Vec<String>,
    retry_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReferencedActivity {
    title: String,
    subtitle: String,
    source: String,
    timestamp: Option<i64>,
}

#[derive(Debug, Clone)]
struct ActivityContext {
    prompt_context: String,
    references: Vec<ReferencedActivity>,
}

fn time_range_start(now: i64, time_range: Option<&str>) -> i64 {
    match time_range.unwrap_or("today") {
        "yesterday" => now - 86400,
        "last_3_days" => now - 3 * 86400,
        "last_7_days" => now - 7 * 86400,
        "last_30_days" => now - 30 * 86400,
        "all_time" => 0,
        _ => now - 86400,
    }
}

fn needs_scope_or_source_confirmation(
    message: &str,
    selected_time_range: Option<&str>,
    selected_sources: Option<&[String]>,
) -> Option<ConfirmActionPayload> {
    let text = message.to_lowercase();
    let range = selected_time_range.unwrap_or("today");
    let sources = selected_sources.unwrap_or(&[]);

    let asks_broad_history = [
        "this week", "last week", "past week", "whole week", "all time", "ever", "history",
        "across", "over time", "rank", "focus", "patterns", "whom did i love", "who did i love",
    ].iter().any(|k| text.contains(k));

    let suggested_time = if asks_broad_history && !matches!(range, "last_7_days" | "last_30_days" | "all_time") {
        Some("last_7_days".to_string())
    } else {
        None
    };

    let mut enable_sources: Vec<String> = Vec::new();
    let asks_browser = ["browser", "website", "url", "search", "google"].iter().any(|k| text.contains(k));
    let asks_files = ["file", "code", "project", "document", "repo"].iter().any(|k| text.contains(k));
    let asks_chat = ["chat", "texted", "message", "whatsapp", "instagram", "telegram"].iter().any(|k| text.contains(k));

    if asks_browser && !sources.iter().any(|s| s == "browser") {
        enable_sources.push("browser".to_string());
    }
    if asks_files && !sources.iter().any(|s| s == "files") {
        enable_sources.push("files".to_string());
    }
    if asks_chat && !sources.iter().any(|s| s == "screen") {
        enable_sources.push("screen".to_string());
    }

    if suggested_time.is_none() && enable_sources.is_empty() {
        return None;
    }

    Some(ConfirmActionPayload {
        kind: "confirm_scope_or_sources".to_string(),
        reason: "This question likely needs a broader time range and/or additional data sources for reliable evidence.".to_string(),
        suggested_time_range: suggested_time,
        enable_sources,
        retry_message: message.to_string(),
    })
}

fn refs_to_activities(refs: &[ReferencedActivity]) -> Vec<serde_json::Value> {
    refs.iter()
        .map(|r| {
            json!({
                "app": r.subtitle,
                "title": r.title,
                "time": r.timestamp,
                "duration_seconds": 0,
                "category": r.source,
            })
        })
        .collect()
}

fn dedupe_activities(items: &mut Vec<serde_json::Value>) {
    let mut seen = std::collections::HashSet::new();
    items.retain(|v| {
        let app = v.get("app").and_then(|x| x.as_str()).unwrap_or("");
        let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let time = v.get("time").and_then(|x| x.as_i64()).unwrap_or(0);
        let key = format!("{}|{}|{}", app, title, time);
        seen.insert(key)
    });
}

fn collect_source_evidence(
    app_handle: &tauri::AppHandle,
    time_range: Option<&str>,
    sources: Option<&[String]>,
) -> (Vec<AgentStep>, Vec<serde_json::Value>, String) {
    let mut steps: Vec<AgentStep> = Vec::new();
    let mut activities: Vec<serde_json::Value> = Vec::new();
    let mut context_sections: Vec<String> = Vec::new();

    let now = chrono::Utc::now().timestamp();
    let start = time_range_start(now, time_range);

    let selected: Vec<String> = if let Some(src) = sources {
        src.to_vec()
    } else {
        vec!["apps".to_string(), "screen".to_string(), "media".to_string()]
    };

    let Ok(conn) = crate::intent::db::open(app_handle) else {
        return (steps, activities, String::new());
    };

    if selected.iter().any(|s| s == "screen") {
        let mut snippets: Vec<String> = Vec::new();
        let mut found = 0;
        if let Ok(mut stmt) = conn.prepare(
            "SELECT app_name, window_title, start_time, metadata FROM activities WHERE start_time >= ?1 AND metadata IS NOT NULL ORDER BY start_time DESC LIMIT 80"
        ) {
            if let Ok(rows) = stmt.query_map([start], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                ))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    if let Some(blob) = row.3 {
                        if let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&blob) {
                            if let Some(text) = meta.get("screen_text").and_then(|v| v.as_str()) {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    found += 1;
                                    snippets.push(format!("- {} | {}", row.0, trimmed.chars().take(120).collect::<String>()));
                                    activities.push(json!({
                                        "app": row.0,
                                        "title": row.1,
                                        "time": row.2,
                                        "duration_seconds": 0,
                                        "category": "screen",
                                        "ocr_snippet": trimmed.chars().take(200).collect::<String>(),
                                    }));
                                    if snippets.len() >= 8 { break; }
                                }
                            }
                        }
                    }
                }
            }
        }
        steps.push(AgentStep {
            turn: steps.len() + 1,
            tool_name: "get_recent_ocr".to_string(),
            tool_args: json!({ "time_range": time_range.unwrap_or("today"), "scope_label": time_range.unwrap_or("today"), "limit": 80 }),
            tool_result: format!("Collected {} OCR-backed activity entries.", found),
            reasoning: "Screen/OCR source enabled; gather text evidence".to_string(),
        });
        if !snippets.is_empty() {
            context_sections.push(format!("OCR HIGHLIGHTS:\n{}", snippets.join("\n")));
        }
    }

    if selected.iter().any(|s| s == "browser") {
        let mut urls: Vec<String> = Vec::new();
        let mut found = 0;
        if let Ok(mut stmt) = conn.prepare(
            "SELECT app_name, window_title, start_time, metadata FROM activities WHERE start_time >= ?1 AND metadata IS NOT NULL ORDER BY start_time DESC LIMIT 120"
        ) {
            if let Ok(rows) = stmt.query_map([start], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                ))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    if let Some(blob) = row.3 {
                        if let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&blob) {
                            if let Some(url) = meta.get("url").and_then(|v| v.as_str()) {
                                let trimmed = url.trim();
                                if !trimmed.is_empty() {
                                    found += 1;
                                    urls.push(format!("- {}", trimmed));
                                    activities.push(json!({
                                        "app": row.0,
                                        "title": row.1,
                                        "time": row.2,
                                        "duration_seconds": 0,
                                        "category": "browser",
                                        "url": trimmed,
                                    }));
                                    if urls.len() >= 8 { break; }
                                }
                            }
                        }
                    }
                }
            }
        }
        steps.push(AgentStep {
            turn: steps.len() + 1,
            tool_name: "get_browser_history".to_string(),
            tool_args: json!({ "time_range": time_range.unwrap_or("today"), "scope_label": time_range.unwrap_or("today"), "limit": 120 }),
            tool_result: format!("Collected {} browser URL entries.", found),
            reasoning: "Browser source enabled; gather URL evidence".to_string(),
        });
        if !urls.is_empty() {
            context_sections.push(format!("RECENT URLS:\n{}", urls.join("\n")));
        }
    }

    if selected.iter().any(|s| s == "media") {
        let mut media_lines: Vec<String> = Vec::new();
        let mut found = 0;
        if let Ok(mut stmt) = conn.prepare(
            "SELECT app_name, window_title, start_time, metadata FROM activities WHERE start_time >= ?1 AND metadata IS NOT NULL ORDER BY start_time DESC LIMIT 100"
        ) {
            if let Ok(rows) = stmt.query_map([start], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<Vec<u8>>>(3)?,
                ))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    if let Some(blob) = row.3 {
                        if let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&blob) {
                            if let Some(mi) = meta.get("media_info") {
                                let title = mi.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
                                let artist = mi.get("artist").and_then(|v| v.as_str()).unwrap_or("").trim();
                                if !title.is_empty() || !artist.is_empty() {
                                    found += 1;
                                    media_lines.push(format!("- {} — {}", title, artist));
                                    activities.push(json!({
                                        "app": row.0,
                                        "title": if row.1.trim().is_empty() { title } else { &row.1 },
                                        "time": row.2,
                                        "duration_seconds": 0,
                                        "category": "media",
                                        "media": { "title": title, "artist": artist, "status": mi.get("status").and_then(|v| v.as_str()).unwrap_or("") },
                                    }));
                                    if media_lines.len() >= 8 { break; }
                                }
                            }
                        }
                    }
                }
            }
        }
        steps.push(AgentStep {
            turn: steps.len() + 1,
            tool_name: "get_music_history".to_string(),
            tool_args: json!({ "time_range": time_range.unwrap_or("today"), "scope_label": time_range.unwrap_or("today"), "limit": 100 }),
            tool_result: format!("Collected {} media entries.", found),
            reasoning: "Media source enabled; gather music/media evidence".to_string(),
        });
        if !media_lines.is_empty() {
            context_sections.push(format!("MEDIA SNAPSHOTS:\n{}", media_lines.join("\n")));
        }
    }

    if selected.iter().any(|s| s == "files") {
        let mut file_lines: Vec<String> = Vec::new();
        let mut found = 0;
        if let Ok(mut stmt) = conn.prepare(
            "SELECT path, change_type, detected_at FROM code_file_events WHERE detected_at >= ?1 ORDER BY detected_at DESC LIMIT 60"
        ) {
            if let Ok(rows) = stmt.query_map([start], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            }) {
                for row in rows.filter_map(|r| r.ok()) {
                    found += 1;
                    file_lines.push(format!("- {} ({})", row.0, row.1));
                    activities.push(json!({
                        "app": "File Monitor",
                        "title": row.0,
                        "time": row.2,
                        "duration_seconds": 0,
                        "category": "files",
                    }));
                    if file_lines.len() >= 10 { break; }
                }
            }
        }
        steps.push(AgentStep {
            turn: steps.len() + 1,
            tool_name: "get_recent_file_changes".to_string(),
            tool_args: json!({ "time_range": time_range.unwrap_or("today"), "scope_label": time_range.unwrap_or("today"), "limit": 60 }),
            tool_result: format!("Collected {} file-change events.", found),
            reasoning: "Files source enabled; gather file activity evidence".to_string(),
        });
        if !file_lines.is_empty() {
            context_sections.push(format!("FILE EVENTS:\n{}", file_lines.join("\n")));
        }
    }

    (steps, activities, context_sections.join("\n\n"))
}

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

fn db_get_api_keys(conn: &rusqlite::Connection) -> Option<String> {
    // Respect the user's configured ai_provider setting
    let provider = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'ai_provider'",
        [], |row| row.get::<_, String>(0),
    ).unwrap_or_else(|_| "nvidia".to_string());

    let setting_key = match provider.to_lowercase().as_str() {
        "openai" => "openai_api_key",
        "anthropic" => "anthropic_api_key",
        "groq" => "groq_api_key",
        _ => "nvidia_api_key",
    };

    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [setting_key], |row| row.get::<_, String>(0),
    ).ok().filter(|s| !s.is_empty())
    .or_else(|| {
        // Fallback to env var for the selected provider
        let env_key = match provider.to_lowercase().as_str() {
            "openai" => "OPENAI_API_KEY",
            "anthropic" => "ANTHROPIC_API_KEY",
            "groq" => "GROQ_API_KEY",
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
) -> Result<ChatMessageResponse, String> {
    let now = Utc::now().timestamp();
    let effective_sources = if sources.is_some() { sources } else { selected_sources };

    // Phase 1: sync DB work — collect everything into owned values, then conn is dropped
    let (nvidia_api_key, prior_messages): (Option<String>, Vec<ChatMessageResponse>) = tokio::task::spawn_blocking({
        let app2 = app_handle.clone();
        let sid   = session_id.clone();
        let msg   = message.clone();
        move || -> (Option<String>, Vec<ChatMessageResponse>) {
            let Ok(conn) = crate::intent::db::open(&app2) else {
                return (None, Vec::new());
            };
            let _ = db_store_user_msg(&conn, &sid, &msg, now);
            let key = db_get_api_keys(&conn);
            let msgs = db_get_messages(&conn, &sid).unwrap_or_default();
            (key, msgs)
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
                api_key: nvidia_api_key.unwrap_or_default(),
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

// ─── AI API helper ────────────────────────────────────────────────────────────

async fn call_ai_api(
    api_key: &str,
    endpoint: &str,
    model_id: &str,
    message: &str,
    activity_context: &str,
    time_range: Option<&str>,
    sources: Option<&[String]>,
) -> Result<String, String> {
    let system = format!(
        "You are a personal AI assistant inside Allentire, a productivity app. \
         You have direct access to the user's real activity data tracked by the app. \
         Use the following activity context to answer questions accurately.\n\n\
         {}\n\n\
         {}{}Be concise and specific. Reference actual apps and window titles from the data.",
        activity_context,
        time_range.map(|t| format!("Time range: {}. ", t)).unwrap_or_default(),
        sources.map(|s| format!("Sources: {}. ", s.join(", "))).unwrap_or_default()
    );

    #[derive(Serialize)] struct Msg  { role: String, content: String }
    #[derive(Serialize)] struct Req  { model: String, messages: Vec<Msg>, max_tokens: u32, temperature: f32 }
    #[derive(Deserialize)] struct Resp { choices: Vec<Ch> }
    #[derive(Deserialize)] struct Ch { message: Mc }
    #[derive(Deserialize)] struct Mc { content: String }

    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&Req {
            model: model_id.to_string(),
            messages: vec![
                Msg { role: "system".into(), content: system },
                Msg { role: "user".into(),   content: message.to_string() },
            ],
            max_tokens: 1024,
            temperature: 0.7,
        })
        .send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI {} — {}", status, &text[..text.len().min(300)]));
    }

    let parsed: Resp = resp.json().await.map_err(|e| e.to_string())?;
    parsed.choices.into_iter().next()
        .map(|c| c.message.content)
        .ok_or_else(|| "Empty AI response".to_string())
}

fn build_activity_context(app_handle: &tauri::AppHandle, time_range: Option<&str>) -> ActivityContext {
    let conn = match crate::intent::db::open(app_handle) {
        Ok(c) => c,
        Err(_) => return ActivityContext {
            prompt_context: "No activity data available yet.".to_string(),
            references: Vec::new(),
        },
    };

    let now = chrono::Utc::now().timestamp();
    let start = time_range_start(now, time_range);

    // Recent activities and references
    let (activities_text, references) = match conn.prepare(
        "SELECT app_name, window_title, duration_seconds, start_time FROM activities \
         WHERE start_time >= ?1 ORDER BY start_time DESC LIMIT 50"
    ) {
        Ok(mut stmt) => {
            let rows_raw: Vec<(String, String, i64, i64)> = stmt.query_map([start], |row| {
                let app: String = row.get(0)?;
                let title: String = row.get(1)?;
                let dur: i64 = row.get(2)?;
                let ts: i64 = row.get(3)?;
                Ok((app, title, dur, ts))
            }).ok()
            .map(|r| r.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();

            if rows_raw.is_empty() {
                (
                    "No activity data recorded yet. Activity tracking will start collecting data in the background.".to_string(),
                    Vec::new(),
                )
            } else {
                let rows = rows_raw.iter().map(|(app, title, dur, ts)| {
                    let time = chrono::DateTime::from_timestamp(*ts, 0)
                        .map(|d| d.format("%H:%M").to_string())
                        .unwrap_or_default();
                    format!("- {} | {} | {}s | {}", app, title, dur, time)
                }).collect::<Vec<_>>();

                let refs = rows_raw.into_iter().take(12).map(|(app, title, _dur, ts)| ReferencedActivity {
                    title: if title.trim().is_empty() { app.clone() } else { title },
                    subtitle: app,
                    source: "activity".to_string(),
                    timestamp: Some(ts),
                }).collect::<Vec<_>>();

                (format!("RECENT ACTIVITY ({} events):\n{}", rows.len(), rows.join("\n")), refs)
            }
        },
        Err(_) => ("No activity data available.".to_string(), Vec::new()),
    };

    // Top apps summary
    let top_apps = match conn.prepare(
        "SELECT app_name, SUM(duration_seconds) as total FROM activities \
         WHERE start_time >= ?1 GROUP BY app_name ORDER BY total DESC LIMIT 10"
    ) {
        Ok(mut stmt) => {
            let rows: Vec<String> = stmt.query_map([start], |row| {
                let app: String = row.get(0)?;
                let total: i64 = row.get(1)?;
                let mins = total / 60;
                Ok(format!("  {} — {}m", app, mins))
            }).ok()
            .map(|r| r.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();
            if rows.is_empty() { String::new() }
            else { format!("\n\nTOP APPS BY TIME:\n{}", rows.join("\n")) }
        },
        Err(_) => String::new(),
    };

    ActivityContext {
        prompt_context: format!("{}{}", activities_text, top_apps),
        references,
    }
}
