use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;
use chrono::Utc;
use keyring::Entry;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DashboardTask {
    pub title: String,
    pub due_date: Option<String>,
    pub status: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectOverview {
    pub name: String,
    pub update: String,
    pub files_changed: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContactOverview {
    pub name: String,
    pub context: String,
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DashboardOverview {
    pub date_key: String,
    pub summary: String,
    pub focus_points: Vec<String>,
    pub deadlines: Vec<DashboardTask>,
    pub projects: Vec<ProjectOverview>,
    pub contacts: Vec<ContactOverview>,
    pub updated_at: i64,
}

fn read_snapshot_by_date(conn: &rusqlite::Connection, date_key: &str) -> Option<DashboardOverview> {
    let json: Result<String, _> = conn.query_row(
        "SELECT summary_json FROM dashboard_snapshots WHERE date_key = ?1",
        rusqlite::params![date_key],
        |row| row.get(0),
    );
    json.ok().and_then(|s| serde_json::from_str::<DashboardOverview>(&s).ok())
}

fn save_snapshot(conn: &rusqlite::Connection, snapshot: &DashboardOverview) -> Result<(), String> {
    let ts = Utc::now().timestamp();
    let json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO dashboard_snapshots (date_key, summary_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(date_key) DO UPDATE SET summary_json = excluded.summary_json, updated_at = excluded.updated_at",
        rusqlite::params![snapshot.date_key, json, ts],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn empty_snapshot_for_date(date_key: &str) -> DashboardOverview {
    DashboardOverview {
        date_key: date_key.to_string(),
        summary: String::new(),
        focus_points: Vec::new(),
        deadlines: Vec::new(),
        projects: Vec::new(),
        contacts: Vec::new(),
        updated_at: Utc::now().timestamp(),
    }
}

#[tauri::command]
pub async fn dashboard_upsert_deadline(
    app_handle: AppHandle,
    item: DashboardTask,
) -> Result<DashboardOverview, String> {
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || -> Result<DashboardOverview, String> {
        let conn = crate::intent::db::open(&app_handle)?;
        let mut snapshot = read_snapshot_by_date(&conn, &date_key).unwrap_or_else(|| empty_snapshot_for_date(&date_key));

        let key = item.title.trim().to_lowercase();
        if key.is_empty() {
            return Err("Deadline title is required".to_string());
        }

        if let Some(existing) = snapshot.deadlines.iter_mut().find(|d| d.title.trim().to_lowercase() == key) {
            *existing = item;
        } else {
            snapshot.deadlines.push(item);
        }
        snapshot.deadlines.sort_by(|a, b| {
            let a_pending = a.status.to_lowercase() != "completed";
            let b_pending = b.status.to_lowercase() != "completed";
            b_pending.cmp(&a_pending)
        });
        snapshot.deadlines.truncate(20);
        snapshot.updated_at = Utc::now().timestamp();

        save_snapshot(&conn, &snapshot)?;
        Ok(snapshot)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dashboard_delete_deadline(
    app_handle: AppHandle,
    title: String,
) -> Result<DashboardOverview, String> {
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || -> Result<DashboardOverview, String> {
        let conn = crate::intent::db::open(&app_handle)?;
        let mut snapshot = read_snapshot_by_date(&conn, &date_key).unwrap_or_else(|| empty_snapshot_for_date(&date_key));
        let key = title.trim().to_lowercase();
        snapshot.deadlines.retain(|d| d.title.trim().to_lowercase() != key);
        snapshot.updated_at = Utc::now().timestamp();
        save_snapshot(&conn, &snapshot)?;
        Ok(snapshot)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dashboard_upsert_project(
    app_handle: AppHandle,
    project: ProjectOverview,
) -> Result<DashboardOverview, String> {
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || -> Result<DashboardOverview, String> {
        let conn = crate::intent::db::open(&app_handle)?;
        let mut snapshot = read_snapshot_by_date(&conn, &date_key).unwrap_or_else(|| empty_snapshot_for_date(&date_key));

        let key = project.name.trim().to_lowercase();
        if key.is_empty() {
            return Err("Project name is required".to_string());
        }

        if let Some(existing) = snapshot.projects.iter_mut().find(|p| p.name.trim().to_lowercase() == key) {
            *existing = project;
        } else {
            snapshot.projects.push(project);
        }
        snapshot.projects.sort_by(|a, b| b.files_changed.cmp(&a.files_changed));
        snapshot.projects.truncate(20);
        snapshot.updated_at = Utc::now().timestamp();

        save_snapshot(&conn, &snapshot)?;
        Ok(snapshot)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dashboard_delete_project(
    app_handle: AppHandle,
    name: String,
) -> Result<DashboardOverview, String> {
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    tokio::task::spawn_blocking(move || -> Result<DashboardOverview, String> {
        let conn = crate::intent::db::open(&app_handle)?;
        let mut snapshot = read_snapshot_by_date(&conn, &date_key).unwrap_or_else(|| empty_snapshot_for_date(&date_key));
        let key = name.trim().to_lowercase();
        snapshot.projects.retain(|p| p.name.trim().to_lowercase() != key);
        snapshot.updated_at = Utc::now().timestamp();
        save_snapshot(&conn, &snapshot)?;
        Ok(snapshot)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dashboard_get_overview(
    app_handle: AppHandle,
    refresh: Option<bool>,
) -> Result<DashboardOverview, String> {
    if refresh.unwrap_or(false) {
        return refresh_dashboard_snapshot(app_handle).await;
    }

    // Try to get cached snapshot for today
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let cached = {
        let conn = crate::intent::db::open(&app_handle)?;
        let result: Result<String, _> = conn.query_row(
            "SELECT summary_json FROM dashboard_snapshots WHERE date_key = ?1",
            rusqlite::params![date_key],
            |row| row.get(0),
        );
        match result {
            Ok(json) => serde_json::from_str(&json).ok(),
            Err(_) => None,
        }
    };

    if let Some(snapshot) = cached {
        return Ok(snapshot);
    }

    refresh_dashboard_snapshot(app_handle).await
}

#[tauri::command]
pub async fn dashboard_refresh_overview(
    app_handle: AppHandle,
) -> Result<DashboardOverview, String> {
    refresh_dashboard_snapshot(app_handle).await
}

fn infer_provider_from_model(model: &str) -> String {
    let lower = model.trim().to_lowercase();
    if lower.starts_with("gemini") || lower.starts_with("models/gemini") {
        "gemini".to_string()
    } else if lower.starts_with("gpt-") || lower.starts_with('o') {
        "openai".to_string()
    } else if lower.starts_with("claude") {
        "anthropic".to_string()
    } else if lower.starts_with("llama-") || lower.starts_with("mixtral") {
        "groq".to_string()
    } else {
        "nvidia".to_string()
    }
}

fn provider_key_name(provider: &str) -> &'static str {
    match provider.to_lowercase().as_str() {
        "openai" => "openai_api_key",
        "anthropic" => "anthropic_api_key",
        "groq" => "groq_api_key",
        "gemini" => "gemini_api_key",
        _ => "nvidia_api_key",
    }
}

fn provider_env_name(provider: &str) -> &'static str {
    match provider.to_lowercase().as_str() {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "groq" => "GROQ_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => "NVIDIA_API_KEY",
    }
}

/// Resolve the AI endpoint URL and model name based on the selected model's provider.
fn resolve_dashboard_ai_endpoint(provider: &str, user_model: Option<&str>) -> (String, String) {
    match provider.to_lowercase().as_str() {
        "openai" => (
            "https://api.openai.com/v1/chat/completions".to_string(),
            user_model.unwrap_or("gpt-4o-mini").to_string(),
        ),
        "anthropic" => (
            "https://api.anthropic.com/v1/messages".to_string(),
            user_model.unwrap_or("claude-3-haiku-20240307").to_string(),
        ),
        "groq" => (
            "https://api.groq.com/openai/v1/chat/completions".to_string(),
            user_model.unwrap_or("llama-3.3-70b-versatile").to_string(),
        ),
        "gemini" => {
            let model = user_model.unwrap_or("gemini-2.0-flash");
            (
                format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model),
                model.to_string(),
            )
        },
        _ => (
            "https://integrate.api.nvidia.com/v1/chat/completions".to_string(),
            user_model.unwrap_or("meta/llama-3.3-70b-instruct").to_string(),
        ),
    }
}

#[tauri::command]
pub async fn dashboard_summarize_item(
    app_handle: AppHandle,
    item_type: String,
    item_name: String,
    context: Option<String>,
) -> Result<String, String> {
    let item_type_norm = item_type.to_lowercase();
    let base_context = context.unwrap_or_default();

    let (api_key, provider, model, evidence) = tokio::task::spawn_blocking({
        let app = app_handle.clone();
        let item_type2 = item_type_norm.clone();
        let item_name2 = item_name.clone();
        move || -> Result<(Option<String>, String, Option<String>, String), String> {
            let conn = crate::intent::db::open(&app)?;
            let model = conn.query_row(
                "SELECT value FROM app_settings WHERE key = 'default_model'",
                [], |row| row.get::<_, String>(0),
            ).ok().filter(|s| !s.is_empty());
            let provider = model
                .as_deref()
                .map(infer_provider_from_model)
                .unwrap_or_else(|| "nvidia".to_string());
            let key_name = provider_key_name(&provider);
            
            let mut key = None;
            if let Ok(entry) = Entry::new("Atheletia", key_name) {
                if let Ok(pwd) = entry.get_password() {
                    if !pwd.trim().is_empty() {
                        key = Some(pwd);
                    }
                }
            }

            if key.is_none() {
                key = conn.query_row(
                    "SELECT value FROM app_settings WHERE key = ?1",
                    rusqlite::params![key_name], |row| row.get::<_, String>(0),
                ).ok().filter(|s| !s.is_empty())
                .or_else(|| {
                    std::env::var(provider_env_name(&provider)).ok().filter(|s| !s.is_empty())
                });
            }

            let mut evidence_lines: Vec<String> = Vec::new();
            if item_type2 == "project" {
                let mut stmt = conn.prepare(
                    "SELECT path, change_type, COALESCE(content_preview,''), detected_at
                     FROM code_file_events
                     WHERE lower(project_root) LIKE '%' || lower(?1) || '%'
                        OR lower(path) LIKE '%' || lower(?1) || '%'
                     ORDER BY detected_at DESC
                     LIMIT 80"
                ).map_err(|e| e.to_string())?;
                let rows = stmt.query_map(rusqlite::params![item_name2], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                }).map_err(|e| e.to_string())?;
                for (path, change, preview, ts) in rows.filter_map(|r| r.ok()).take(30) {
                    evidence_lines.push(format!("[{}] {} {} :: {}", ts, change, path, preview.chars().take(140).collect::<String>()));
                }
            } else if item_type2 == "contact" {
                let mut stmt = conn.prepare(
                    "SELECT app_name, window_title, COALESCE(metadata,''), start_time
                     FROM activities
                     WHERE (
                        lower(app_name) LIKE '%whatsapp%'
                        OR lower(app_name) LIKE '%telegram%'
                        OR lower(app_name) LIKE '%teams%'
                        OR lower(app_name) LIKE '%slack%'
                        OR lower(app_name) LIKE '%discord%'
                        OR lower(app_name) LIKE '%instagram%'
                     )
                     AND (
                        lower(window_title) LIKE '%' || lower(?1) || '%'
                        OR lower(COALESCE(metadata,'')) LIKE '%' || lower(?1) || '%'
                     )
                     ORDER BY start_time DESC
                     LIMIT 100"
                ).map_err(|e| e.to_string())?;
                let rows = stmt.query_map(rusqlite::params![item_name2], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                }).map_err(|e| e.to_string())?;
                for (app, title, metadata_raw, ts) in rows.filter_map(|r| r.ok()).take(30) {
                    let ocr = serde_json::from_str::<serde_json::Value>(&metadata_raw)
                        .ok()
                        .and_then(|v| v.get("screen_text").and_then(|x| x.as_str()).map(|s| s.to_string()))
                        .unwrap_or_default();
                    let ocr_snip = ocr.chars().take(180).collect::<String>();
                    evidence_lines.push(format!("[{}] {} :: {} :: {}", ts, app, title, ocr_snip));
                }
            } else {
                let mut stmt = conn.prepare(
                    "SELECT role, content, created_at FROM chat_messages
                     WHERE lower(content) LIKE '%' || lower(?1) || '%'
                     ORDER BY created_at DESC
                     LIMIT 80"
                ).map_err(|e| e.to_string())?;
                let rows = stmt.query_map(rusqlite::params![item_name2], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                }).map_err(|e| e.to_string())?;
                for (role, content, ts) in rows.filter_map(|r| r.ok()).take(30) {
                    evidence_lines.push(format!("[{}] {}: {}", ts, role, content.chars().take(180).collect::<String>()));
                }
            }

            Ok((key, provider, model, evidence_lines.join("\n")))
        }
    }).await.map_err(|e| e.to_string())??;

    let prompt = format!(
        "Create a concise but detailed summary for this dashboard item.\n\
Item type: {}\nItem name: {}\n\n\
Known context:\n{}\n\n\
Tracked evidence:\n{}\n\n\
Return plain text with:\n1) What was happening\n2) Key mentions / action items\n3) Next suggested follow-up.",
        item_type_norm,
        item_name,
        base_context,
        evidence
    );

    let Some(api_key) = api_key else {
        return Ok(format!(
            "No AI key configured.\n\n{}\n\nEvidence:\n{}",
            base_context,
            if evidence.trim().is_empty() { "No additional evidence found.".to_string() } else { evidence }
        ));
    };

    let (endpoint, model_name) = resolve_dashboard_ai_endpoint(&provider, model.as_deref());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;

    let provider_norm = provider.to_lowercase();
    let system = "You are an assistant that summarizes activity evidence factually. Avoid hallucinations. Do not include romantic, intimate, or personal relationship labels (e.g. 'love interest', 'crush', 'girlfriend', 'boyfriend') or descriptions of personal habits or bad habits in your summaries. Focus only on observable communication patterns and activity evidence. Never output the full name 'Sneha Nair'.";

    if provider_norm == "gemini" {
        let gemini_url = format!("{}?key={}", endpoint, api_key);
        let body = serde_json::json!({
            "contents": [{ "parts": [{ "text": format!("{}\n\n{}", system, prompt) }] }],
            "generationConfig": { "temperature": 0.2, "maxOutputTokens": 600 }
        });
        let value: serde_json::Value = client.post(&gemini_url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        return Ok(value.pointer("/candidates/0/content/parts/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or("No summary generated.")
            .to_string());
    }

    if provider_norm == "anthropic" {
        let body = serde_json::json!({
            "model": model_name,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.2,
            "max_tokens": 600
        });
        let value: serde_json::Value = client.post(&endpoint)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        return Ok(value.get("content")
            .and_then(|v| v.as_array())
            .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "No summary generated.".to_string()));
    }

    #[derive(Serialize)] struct Msg { role: String, content: String }
    #[derive(Serialize)] struct Req { model: String, messages: Vec<Msg>, temperature: f32, max_tokens: u32 }
    #[derive(Deserialize)] struct Resp { choices: Vec<Ch> }
    #[derive(Deserialize)] struct Ch { message: Mc }
    #[derive(Deserialize)] struct Mc { content: String }

    let req = Req {
        model: model_name,
        messages: vec![
            Msg { role: "system".into(), content: system.into() },
            Msg { role: "user".into(), content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 600,
    };

    let request = client.post(&endpoint)
        .json(&req)
        .header("Authorization", format!("Bearer {}", api_key));
    let res: Resp = request
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    Ok(res.choices.into_iter().next().map(|c| c.message.content).unwrap_or_else(|| "No summary generated.".to_string()))
}

// ─── Core Engine ─────────────────────────────────────────────────────────────
// This generates the overview from activity data + AI if available.

async fn refresh_dashboard_snapshot(app_handle: AppHandle) -> Result<DashboardOverview, String> {
    let now = chrono::Local::now();
    let date_key = now.format("%Y-%m-%d").to_string();
    
    use chrono::{TimeZone, Local};
    let day_start = Local
        .from_local_datetime(&now.naive_local().date().and_hms_opt(0, 0, 0).ok_or("Invalid date time boundaries")?)
        .single()
        .ok_or("Failed to convert to local datetime")?
        .timestamp();
    let day_end = day_start + 86400;

    // 1. Gather context synchronously
    let context = tokio::task::spawn_blocking({
        let app = app_handle.clone();
        let date_key2 = date_key.clone();
        move || -> Result<TodayContext, String> {
            let conn = crate::intent::db::open(&app)?;
            build_today_context(&conn, day_start, day_end, &date_key2)
        }
    }).await.map_err(|e| e.to_string())??;

    let (api_key, ai_provider, ai_model): (Option<String>, String, Option<String>) = tokio::task::spawn_blocking({
        let app = app_handle.clone();
        move || -> (Option<String>, String, Option<String>) {
            let conn = match crate::intent::db::open(&app) {
                Ok(c) => c,
                Err(_) => return (None, "nvidia".to_string(), None),
            };
            let model = conn.query_row(
                "SELECT value FROM app_settings WHERE key = 'default_model'",
                [], |row| row.get::<_, String>(0),
            ).ok().filter(|s| !s.is_empty());
            let provider = model
                .as_deref()
                .map(infer_provider_from_model)
                .unwrap_or_else(|| "nvidia".to_string());
            let key_name = provider_key_name(&provider);
            
            let mut key = None;
            if let Ok(entry) = Entry::new("Atheletia", key_name) {
                if let Ok(pwd) = entry.get_password() {
                    if !pwd.trim().is_empty() {
                        key = Some(pwd);
                    }
                }
            }

            if key.is_none() {
                key = conn.query_row(
                    "SELECT value FROM app_settings WHERE key = ?1",
                    rusqlite::params![key_name], |row| row.get::<_, String>(0),
                ).ok().filter(|s| !s.is_empty())
                .or_else(|| {
                    std::env::var(provider_env_name(&provider)).ok().filter(|s| !s.is_empty())
                });
            }
            (key, provider, model)
        }
    }).await.unwrap_or((None, "nvidia".to_string(), None));

    // 3. AI Summary (or fallback)
    let overview = if let Some(key) = api_key.as_deref() {
        // We'll just ask for a basic JSON summary to avoid huge latency
        let res = call_nim_dashboard(key, &ai_provider, ai_model.as_deref(), &context).await;
        match res {
            Ok(mut o) => {
                o.date_key = date_key.clone();
                o.contacts = sanitize_contacts(o.contacts);

                let derived_deadlines = derive_deadlines_from_context(&context);
                if o.deadlines.is_empty() {
                    o.deadlines = derived_deadlines;
                } else {
                    for d in derived_deadlines {
                        let exists = o.deadlines.iter().any(|x| x.title.eq_ignore_ascii_case(&d.title));
                        if !exists {
                            o.deadlines.push(d);
                        }
                    }
                    o.deadlines.truncate(12);
                }

                let derived_projects = summarize_projects_from_file_changes(&context, 12);
                if o.projects.is_empty() {
                    o.projects = derived_projects;
                } else {
                    for p in derived_projects {
                        let exists = o.projects.iter().any(|x| x.name.eq_ignore_ascii_case(&p.name));
                        if !exists {
                            o.projects.push(p);
                        }
                    }
                    o.projects.sort_by(|a, b| b.files_changed.cmp(&a.files_changed));
                    o.projects.truncate(12);
                }

                let derived_contacts = sanitize_contacts(derive_contacts_from_context(&context));
                if o.contacts.is_empty() {
                    o.contacts = derived_contacts;
                } else {
                    for c in derived_contacts {
                        let exists = o.contacts.iter().any(|x| x.name.eq_ignore_ascii_case(&c.name));
                        if !exists {
                            o.contacts.push(c);
                        }
                    }
                    o.contacts = sanitize_contacts(o.contacts);
                    o.contacts.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
                    o.contacts.truncate(12);
                }

                o
            }
            Err(_) => {
                let mut fallback = fallback_overview(&context);
                fallback.date_key = date_key.clone();
                fallback.contacts = sanitize_contacts(fallback.contacts);
                fallback
            }
        }
    } else {
        let mut fallback = fallback_overview(&context);
        fallback.date_key = date_key.clone();
        fallback.contacts = sanitize_contacts(fallback.contacts);
        fallback
    };

    let overview = tokio::task::spawn_blocking({
        let app = app_handle.clone();
        let dk = date_key.clone();
        let fresh = overview.clone();
        move || -> Result<DashboardOverview, String> {
            let conn = crate::intent::db::open(&app)?;
            let mut stmt = conn.prepare(
                "SELECT summary_json FROM dashboard_snapshots
                 WHERE date_key != ?1
                 ORDER BY updated_at DESC
                 LIMIT 10"
            ).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![dk], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;

            let mut merged = fresh;
            for row in rows.filter_map(|r| r.ok()) {
                if let Ok(prev) = serde_json::from_str::<DashboardOverview>(&row) {
                    merged = merge_dashboard_overview(prev, merged);
                }
            }
            // Final sanitize pass — removes blocked names that may have been
            // persisted in old DB snapshots before the block list existed.
            merged.contacts = sanitize_contacts(merged.contacts);
            Ok(merged)
        }
    }).await.map_err(|e| e.to_string())??;

    // 4. Save to DB
    let ts = chrono::Utc::now().timestamp();
    tokio::task::spawn_blocking({
        let app = app_handle.clone();
        let overview = overview.clone();
        let dk = date_key.clone();
        move || -> Result<(), String> {
            let conn = crate::intent::db::open(&app)?;
            let json = serde_json::to_string(&overview).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO dashboard_snapshots (date_key, summary_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(date_key) DO UPDATE SET summary_json = excluded.summary_json, updated_at = excluded.updated_at",
                rusqlite::params![dk, json, ts],
            ).map_err(|e| e.to_string())?;
            Ok(())
        }
    }).await.map_err(|e| e.to_string())??;

    Ok(overview)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct TodayContext {
    total_duration: i64,
    top_apps: Vec<(String, i64)>,
    chat_turns: Vec<(String, String)>,
    file_changes: Vec<(String, String, String, String, i64)>,
    diary_entries: Vec<String>,
    communication_events: Vec<(String, String, String, i64)>,
    carry_over_deadlines: Vec<DashboardTask>,
    carry_over_projects: Vec<ProjectOverview>,
}

fn build_today_context(conn: &rusqlite::Connection, day_start: i64, day_end: i64, date_key: &str) -> Result<TodayContext, String> {
    let mut ctx = TodayContext::default();

    // Top apps
    let mut stmt = conn.prepare(
        "SELECT app_name, SUM(duration_seconds) FROM activities 
         WHERE start_time >= ?1 AND start_time < ?2 GROUP BY app_name ORDER BY 2 DESC LIMIT 10"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![day_start, day_end], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    }).map_err(|e| e.to_string())?;
    for row in rows.filter_map(|r| r.ok()) {
        ctx.total_duration += row.1;
        ctx.top_apps.push(row);
    }

    // Chat
    let mut stmt2 = conn.prepare(
        "SELECT role, content FROM chat_messages 
         WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at ASC LIMIT 100"
    ).map_err(|e| e.to_string())?;
    let chat_rows = stmt2.query_map(rusqlite::params![day_start, day_end], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?;
    
    let mut pending_user = None;
    for row in chat_rows.filter_map(|r| r.ok()) {
        if row.0 == "user" {
            pending_user = Some(row.1);
        } else if row.0 == "assistant" {
            if let Some(user) = pending_user.take() {
                ctx.chat_turns.push((user, row.1));
            }
        }
    }

    let mut stmt3 = conn.prepare(
        "SELECT path, project_root, change_type, COALESCE(content_preview, ''), detected_at
         FROM code_file_events
         WHERE detected_at >= ?1 AND detected_at < ?2
         ORDER BY detected_at DESC
         LIMIT 400"
    ).map_err(|e| e.to_string())?;
    let file_rows = stmt3.query_map(rusqlite::params![day_start, day_end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }).map_err(|e| e.to_string())?;
    ctx.file_changes = file_rows.filter_map(|r| r.ok()).collect();

    let mut stmt4 = conn.prepare(
        "SELECT content FROM diary_entries WHERE date = ?1 ORDER BY created_at DESC LIMIT 80"
    ).map_err(|e| e.to_string())?;
    let diary_rows = stmt4.query_map(rusqlite::params![date_key], |row| {
        row.get::<_, String>(0)
    }).map_err(|e| e.to_string())?;
    ctx.diary_entries = diary_rows.filter_map(|r| r.ok()).collect();

        let mut stmt5 = conn.prepare(
                "SELECT app_name, window_title, COALESCE(metadata, ''), start_time FROM activities
         WHERE start_time >= ?1 AND start_time < ?2
           AND (
             lower(app_name) LIKE '%whatsapp%'
             OR lower(app_name) LIKE '%telegram%'
             OR lower(app_name) LIKE '%slack%'
             OR lower(app_name) LIKE '%discord%'
             OR lower(app_name) LIKE '%teams%'
             OR lower(app_name) LIKE '%instagram%'
           )
         ORDER BY start_time DESC
         LIMIT 300"
    ).map_err(|e| e.to_string())?;
    let comm_rows = stmt5.query_map(rusqlite::params![day_start, day_end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }).map_err(|e| e.to_string())?;
    ctx.communication_events = comm_rows
        .filter_map(|r| r.ok())
        .map(|(app, title, metadata_raw, start)| {
            let ocr = if metadata_raw.trim().is_empty() {
                String::new()
            } else {
                serde_json::from_str::<serde_json::Value>(&metadata_raw)
                    .ok()
                    .and_then(|v| v.get("screen_text").and_then(|x| x.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default()
            };
            (app, title, ocr, start)
        })
        .collect();

    let mut stmt_prev = conn.prepare(
        "SELECT summary_json FROM dashboard_snapshots
         WHERE date_key != ?1
         ORDER BY updated_at DESC
         LIMIT 14"
    ).map_err(|e| e.to_string())?;
    let prev_rows = stmt_prev.query_map(rusqlite::params![date_key], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut seen_deadline = HashSet::new();
    let mut seen_project = HashSet::new();
    for row in prev_rows.filter_map(|r| r.ok()) {
        if let Ok(prev) = serde_json::from_str::<DashboardOverview>(&row) {
            for d in prev.deadlines {
                if d.status.to_lowercase() == "completed" {
                    continue;
                }
                let key = d.title.trim().to_lowercase();
                if !key.is_empty() && seen_deadline.insert(key) {
                    ctx.carry_over_deadlines.push(d);
                }
                if ctx.carry_over_deadlines.len() >= 20 {
                    break;
                }
            }
            for p in prev.projects {
                let key = p.name.trim().to_lowercase();
                if !key.is_empty() && seen_project.insert(key) {
                    ctx.carry_over_projects.push(p);
                }
                if ctx.carry_over_projects.len() >= 20 {
                    break;
                }
            }
        }
    }

    Ok(ctx)
}

async fn call_nim_dashboard(api_key: &str, ai_provider: &str, ai_model: Option<&str>, ctx: &TodayContext) -> Result<DashboardOverview, String> {
    let prompt = format!(
        "Build a personal dashboard overview from today's data.\n\
        Return STRICT JSON only matching this schema:\n\
        {{\n\
          \"summary\": \"Overall paragraph summary of today's behavior\",\n\
          \"focus_points\": [\"point 1\", \"point 2\"],\n\
          \"deadlines\": [{{\"title\": \"Task\", \"due_date\": \"Tomorrow\", \"status\": \"pending\", \"source\": \"AI\"}}],\n\
                    \"projects\": [{{\"name\": \"App Name\", \"update\": \"Worked 40 mins\", \"files_changed\": 0}}],\n\
                    \"contacts\": [{{\"name\": \"Person Name\", \"context\": \"2 interactions in WhatsApp\", \"last_seen\": 0}}]\n\
        }}\n\n\
                Top apps: {:?}\nTotal tracked seconds: {}\nChat turns: {:?}\nFile changes: {:?}\nCommunication events: {:?}\nCarry-over pending deadlines: {:?}\nCarry-over projects: {:?}\n\nIMPORTANT: If a carry-over deadline is not evidenced as completed today, keep it as pending instead of dropping it.",
                ctx.top_apps,
                ctx.total_duration,
                ctx.chat_turns.iter().rev().take(10).collect::<Vec<_>>(),
                ctx.file_changes.iter().take(25).collect::<Vec<_>>(),
                ctx.communication_events.iter().take(25).collect::<Vec<_>>(),
                ctx.carry_over_deadlines.iter().take(20).collect::<Vec<_>>(),
                ctx.carry_over_projects.iter().take(20).collect::<Vec<_>>()
    );

    #[derive(Serialize)] struct Msg { role: String, content: String }
    #[derive(Serialize)] struct Req { model: String, messages: Vec<Msg>, temperature: f32 }
    #[derive(Deserialize)] struct Resp { choices: Vec<Ch> }
    #[derive(Deserialize)] struct Ch { message: Mc }
    #[derive(Deserialize)] struct Mc { content: String }

    let (endpoint, model_name) = resolve_dashboard_ai_endpoint(ai_provider, ai_model);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;

    let provider_norm = ai_provider.to_lowercase();

    let content = if provider_norm == "gemini" {
        // Gemini uses a different schema
        let system_msg = "You output valid JSON only. For the contacts array, the 'context' field must only describe professional or social interaction patterns (e.g. '3 interactions in WhatsApp'). Never include romantic, intimate, or personal relationship labels such as 'love interest', 'crush', 'girlfriend', 'boyfriend', or descriptions of personal habits.";
        let full_prompt = format!("{}\n\n{}", system_msg, prompt);
        let gemini_url = format!("{}?key={}", endpoint, api_key);
        let body = serde_json::json!({
            "contents": [{ "parts": [{ "text": full_prompt }] }],
            "generationConfig": { "temperature": 0.2, "maxOutputTokens": 2048 }
        });
        let resp = client.post(&gemini_url)
            .header("Content-Type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("AI {} — {}", status, &text[..text.len().min(300)]));
        }
        let parsed: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        parsed.get("candidates").and_then(|v| v.as_array()).and_then(|a| a.first())
            .and_then(|c| c.get("content")).and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array()).and_then(|parts| parts.first())
            .and_then(|part| part.get("text")).and_then(|t| t.as_str())
            .unwrap_or("{}").to_string()
    } else if provider_norm == "anthropic" {
        let body = serde_json::json!({
            "model": model_name,
            "system": "You output valid JSON only. For the contacts array, the 'context' field must only describe professional or social interaction patterns (e.g. '3 interactions in WhatsApp'). Never include romantic, intimate, or personal relationship labels such as 'love interest', 'crush', 'girlfriend', 'boyfriend', or descriptions of personal habits. Do not include any person named 'Sneha Nair' in the contacts array.",
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0.2,
            "max_tokens": 2048
        });
        let resp = client.post(&endpoint)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("AI {} - {}", status, &text[..text.len().min(300)]));
        }
        let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        value.get("content")
            .and_then(|v| v.as_array())
            .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
            .unwrap_or_default()
    } else {
        let req = Req {
            model: model_name,
            messages: vec![
                Msg { role: "system".into(), content: "You output valid JSON only. For the contacts array, the 'context' field must only describe professional or social interaction patterns (e.g. '3 interactions in WhatsApp'). Never include romantic, intimate, or personal relationship labels such as 'love interest', 'crush', 'girlfriend', 'boyfriend', or descriptions of personal habits. Do not include any person named 'Sneha Nair' in the contacts array.".into() },
                Msg { role: "user".into(), content: prompt },
            ],
            temperature: 0.2,
        };
        let res: Resp = client.post(&endpoint)
            .json(&req)
            .header("Authorization", format!("Bearer {}", api_key))
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        res.choices.into_iter().next().map(|c| c.message.content).unwrap_or_default()
    };

    let clean = content.trim().trim_start_matches("```json").trim_end_matches("```").trim();
    
    // We parse loosely and fill defaults if NIM fails to return arrays
    #[derive(Deserialize, Default)]
    struct Partial {
        summary: Option<String>,
        focus_points: Option<Vec<String>>,
        deadlines: Option<Vec<DashboardTask>>,
        projects: Option<Vec<ProjectOverview>>,
        contacts: Option<Vec<ContactOverview>>,
    }
    
    let parsed: Partial = serde_json::from_str(clean).map_err(|e| e.to_string())?;

    Ok(DashboardOverview {
        date_key: String::new(),
        summary: parsed.summary.unwrap_or_else(|| "No summary available.".into()),
        focus_points: parsed.focus_points.unwrap_or_default(),
        deadlines: parsed.deadlines.unwrap_or_default(),
        projects: parsed.projects.unwrap_or_default(),
        contacts: parsed.contacts.unwrap_or_default(),
        updated_at: chrono::Utc::now().timestamp(),
    })
}

fn fallback_overview(ctx: &TodayContext) -> DashboardOverview {
    let summary = if ctx.top_apps.is_empty() {
        "No tracked activity yet today.".to_string()
    } else {
        let apps = ctx.top_apps.iter().take(3).map(|(n, d)| format!("{} ({}m)", n, d / 60)).collect::<Vec<_>>().join(", ");
        format!("Today you mostly worked in {}.", apps)
    };

    let deadlines = derive_deadlines_from_context(ctx);
    let mut projects = summarize_projects_from_file_changes(ctx, 10);
    if projects.is_empty() {
        for (app, dur) in ctx.top_apps.iter().take(3) {
            projects.push(ProjectOverview {
                name: app.clone(),
                update: format!("Active for {} minutes", dur / 60),
                files_changed: 0,
            });
        }
    }
    let contacts = derive_contacts_from_context(ctx);

    DashboardOverview {
        date_key: String::new(),
        summary,
        focus_points: vec![
            format!("{} communication windows detected", ctx.communication_events.len()),
            format!("{} file changes tracked", ctx.file_changes.len()),
            format!("{} diary notes scanned for deadlines", ctx.diary_entries.len()),
        ],
        deadlines,
        projects,
        contacts,
        updated_at: chrono::Utc::now().timestamp(),
    }
}

fn derive_deadlines_from_context(ctx: &TodayContext) -> Vec<DashboardTask> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for content in &ctx.diary_entries {
        for line in content.lines().take(40) {
            let l = line.trim();
            if l.len() < 4 {
                continue;
            }
            let lower = l.to_lowercase();
            if !(lower.contains("deadline")
                || lower.contains("due")
                || lower.contains("tomorrow")
                || lower.contains("today")
                || lower.contains("by "))
            {
                continue;
            }
            let title = l.chars().take(90).collect::<String>();
            let key = title.to_lowercase();
            if seen.insert(key) {
                out.push(DashboardTask {
                    title,
                    due_date: extract_due_hint(l),
                    status: infer_status(l),
                    source: "diary".to_string(),
                });
            }
            if out.len() >= 12 {
                return out;
            }
        }
    }

    for (user, _) in ctx.chat_turns.iter().rev().take(40) {
        let lower = user.to_lowercase();
        if !(lower.contains("deadline") || lower.contains("due") || lower.contains("submission")) {
            continue;
        }
        let title = user.chars().take(90).collect::<String>();
        let key = title.to_lowercase();
        if seen.insert(key) {
            out.push(DashboardTask {
                title,
                due_date: extract_due_hint(user),
                status: infer_status(user),
                source: "chat".to_string(),
            });
        }
        if out.len() >= 12 {
            break;
        }
    }

    for (app, title, ocr, _start_time) in ctx.communication_events.iter().take(200) {
        let merged_text = if ocr.trim().is_empty() {
            title.clone()
        } else {
            format!("{}\n{}", title, ocr)
        };

        for line in merged_text.lines().take(60) {
            let l = line.trim();
            if l.len() < 4 {
                continue;
            }
            let lower = l.to_lowercase();
            let looks_like_task = lower.contains("deadline")
                || lower.contains("due")
                || lower.contains("assignment")
                || lower.contains("submission")
                || lower.contains("submit")
                || lower.contains("project")
                || lower.contains("tomorrow")
                || lower.contains("today")
                || lower.contains("by ");
            if !looks_like_task {
                continue;
            }

            let title = l.chars().take(90).collect::<String>();
            let key = title.to_lowercase();
            if seen.insert(key) {
                out.push(DashboardTask {
                    title,
                    due_date: extract_due_hint(l),
                    status: infer_status(&merged_text),
                    source: format!("{}_ocr", app.to_lowercase().replace(' ', "_")),
                });
            }

            if out.len() >= 12 {
                return out;
            }
        }
    }

    out
}

fn infer_status(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("completed")
        || lower.contains("done")
        || lower.contains("submitted")
        || lower.contains("resolved")
        || lower.contains("finished")
    {
        "completed".to_string()
    } else {
        "pending".to_string()
    }
}

fn extract_due_hint(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for marker in ["due ", "deadline ", "by ", "tomorrow", "today"] {
        if let Some(idx) = lower.find(marker) {
            let snippet = text[idx..].chars().take(44).collect::<String>();
            return Some(snippet.trim().to_string());
        }
    }
    None
}

fn summarize_projects_from_file_changes(ctx: &TodayContext, limit: usize) -> Vec<ProjectOverview> {
    #[derive(Default)]
    struct ProjectStat {
        files_changed: i32,
        created: i32,
        modified: i32,
        deleted: i32,
        touched_areas: HashSet<String>,
    }

    let mut by_project: HashMap<String, ProjectStat> = HashMap::new();
    for (path, root, change_type, _preview, _detected_at) in &ctx.file_changes {
        if path.trim().is_empty() || root.trim().is_empty() {
            continue;
        }
        let stat = by_project.entry(root.clone()).or_default();
        stat.files_changed += 1;
        match change_type.to_lowercase().as_str() {
            "created" => stat.created += 1,
            "deleted" => stat.deleted += 1,
            _ => stat.modified += 1,
        }
        if let Some(area) = derive_area_from_path(path, root) {
            stat.touched_areas.insert(area);
        }
    }

    let mut projects: Vec<ProjectOverview> = by_project
        .into_iter()
        .map(|(root, stat)| {
            let short_name = root.replace('\\', "/").rsplit('/').next().unwrap_or(root.as_str()).to_string();
            let areas = stat.touched_areas.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            let update = if areas.is_empty() {
                format!("{} modified, {} created, {} deleted", stat.modified, stat.created, stat.deleted)
            } else {
                format!("{} modified, {} created, {} deleted • touched {}", stat.modified, stat.created, stat.deleted, areas)
            };
            ProjectOverview {
                name: short_name,
                update,
                files_changed: stat.files_changed,
            }
        })
        .collect();

    projects.sort_by(|a, b| b.files_changed.cmp(&a.files_changed));
    projects.truncate(limit);
    projects
}

fn derive_area_from_path(path: &str, project_root: &str) -> Option<String> {
    let normalized_path = path.replace('\\', "/");
    let normalized_root = project_root.replace('\\', "/");
    let relative = normalized_path
        .strip_prefix(&(normalized_root.clone() + "/"))
        .unwrap_or(&normalized_path);
    let mut parts = relative.split('/').filter(|p| !p.is_empty());
    let first = parts.next()?;
    let second = parts.next();
    Some(match second {
        Some(s) => format!("{}/{}", first, s),
        None => first.to_string(),
    })
}

fn derive_contacts_from_context(ctx: &TodayContext) -> Vec<ContactOverview> {
    let mut by_name: HashMap<String, (i32, i64, String)> = HashMap::new();
    for (app, title, ocr, start_time) in &ctx.communication_events {
        let mut candidates = extract_contact_candidates(title, app);
        candidates.extend(extract_contact_candidates(ocr, app));
        if candidates.is_empty() {
            candidates.push(app.clone());
        }

        for candidate in candidates {
            let normalized = normalize_contact_name(&candidate);
            if normalized.is_empty() || !is_valid_contact_name(&normalized) {
                continue;
            }
            let key = normalized.to_lowercase();
            let entry = by_name.entry(key).or_insert((0, 0, app.clone()));
            entry.0 += 1;
            if *start_time > entry.1 {
                entry.1 = *start_time;
            }
        }
    }

    let mut contacts: Vec<ContactOverview> = by_name
        .into_iter()
        .map(|(key, (count, last_seen, app))| ContactOverview {
            name: key
                .split_whitespace()
                .map(|w| {
                    let mut chars = w.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
            context: format!("{} interaction(s) in {}", count, app),
            last_seen: Some(last_seen),
        })
        .collect();

    contacts.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    contacts.truncate(10);
    contacts
}

fn extract_contact_candidates(title: &str, app: &str) -> Vec<String> {
    let cleaned = title.replace('\n', " ");
    let mut out = Vec::new();

    if let Some(part) = cleaned.split('|').next() {
        let p = part.trim();
        if looks_like_human_name(p, app) {
            out.push(p.to_string());
        }
    }

    if let Some((left, right)) = cleaned.split_once(" - ") {
        let app_hint = right.to_lowercase();
        if (app_hint.contains("whatsapp")
            || app_hint.contains("telegram")
            || app_hint.contains("teams")
            || app_hint.contains("discord")
            || app_hint.contains("slack"))
            && looks_like_human_name(left.trim(), app)
        {
            out.push(left.trim().to_string());
        }
    }

    out
}

fn looks_like_human_name(text: &str, app: &str) -> bool {
    let t = text.trim();
    if t.len() < 3 || t.len() > 64 {
        return false;
    }
    let lower = t.to_lowercase();
    let app_lower = app.to_lowercase();
    let banned = [
        "visual studio",
        "windows explorer",
        "task switching",
        "whatsapp",
        "microsoft teams",
        "telegram",
        "discord",
        "slack",
        "zoom",
        "chrome",
        "edge",
        "firefox",
        "inbox",
        "new tab",
    ];
    if banned.iter().any(|b| lower.contains(b)) || lower.contains(&app_lower) {
        return false;
    }

    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() < 2 || words.len() > 5 {
        return false;
    }
    words.iter().all(|w| w.chars().any(|c| c.is_alphabetic()))
}

fn normalize_contact_name(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '.')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_valid_contact_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() {
        return false;
    }
    let lower = n.to_lowercase();
    if lower == "person name"
        || lower.contains("whatsapp.root")
        || lower.contains("telegram.root")
        || lower.contains("teams.root")
        || lower.contains("slack.root")
        || lower.contains("unknown")
    {
        return false;
    }
    true
}

/// Names to hide from the contacts list (e.g. for demo / privacy).
const BLOCKED_CONTACT_NAMES: &[&str] = &["sneha nair"];

fn sanitize_contacts(items: Vec<ContactOverview>) -> Vec<ContactOverview> {
    let mut out: Vec<ContactOverview> = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let normalized = normalize_contact_name(&item.name);
        if !is_valid_contact_name(&normalized) {
            continue;
        }
        let key = normalized.to_lowercase();
        // Skip blocked names
        if BLOCKED_CONTACT_NAMES.iter().any(|b| key == *b) {
            continue;
        }
        if seen.insert(key) {
            out.push(ContactOverview { name: normalized, ..item });
        }
    }
    out
}

fn merge_dashboard_overview(previous: DashboardOverview, mut fresh: DashboardOverview) -> DashboardOverview {
    if fresh.summary.trim().is_empty() {
        fresh.summary = previous.summary;
    }

    let mut focus = fresh.focus_points;
    for p in previous.focus_points {
        if !focus.iter().any(|f| f.eq_ignore_ascii_case(&p)) {
            focus.push(p);
        }
    }
    focus.truncate(12);
    fresh.focus_points = focus;

    let mut merged_deadlines = fresh.deadlines;
    for item in previous.deadlines {
        let key = item.title.to_lowercase();
        if let Some(existing) = merged_deadlines.iter_mut().find(|d| d.title.to_lowercase() == key) {
            if existing.status.trim().is_empty() {
                existing.status = item.status.clone();
            }
            if existing.due_date.is_none() {
                existing.due_date = item.due_date.clone();
            }
            if existing.source.trim().is_empty() {
                existing.source = item.source.clone();
            }
        } else if item.status.to_lowercase() != "completed" {
            merged_deadlines.push(item);
        }
    }
    merged_deadlines.truncate(12);
    fresh.deadlines = merged_deadlines;

    let mut merged_projects = fresh.projects;
    for item in previous.projects {
        let key = item.name.to_lowercase();
        if let Some(existing) = merged_projects.iter_mut().find(|p| p.name.to_lowercase() == key) {
            existing.files_changed = existing.files_changed.max(item.files_changed);
            if existing.update.trim().is_empty() {
                existing.update = item.update.clone();
            }
        } else {
            merged_projects.push(item);
        }
    }
    merged_projects.sort_by(|a, b| b.files_changed.cmp(&a.files_changed));
    merged_projects.truncate(12);
    fresh.projects = merged_projects;

    let mut merged_contacts = fresh.contacts;
    for item in previous.contacts {
        let key = item.name.to_lowercase();
        if let Some(existing) = merged_contacts.iter_mut().find(|c| c.name.to_lowercase() == key) {
            existing.last_seen = existing.last_seen.max(item.last_seen);
            if existing.context.trim().is_empty() {
                existing.context = item.context.clone();
            }
        } else {
            merged_contacts.push(item);
        }
    }
    merged_contacts.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    merged_contacts.truncate(12);
    fresh.contacts = merged_contacts;

    fresh
}
