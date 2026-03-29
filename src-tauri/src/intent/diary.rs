use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::AppHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiaryEntry {
    pub id: String,
    pub date: String,
    pub content: String,
    #[serde(rename = "isAiGenerated")]
    pub is_ai_generated: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

// ─── sync helpers ─────────────────────────────────────────────────────────────

fn db_get_entries(conn: &rusqlite::Connection, date: Option<&str>) -> Result<Vec<DiaryEntry>, String> {
    if let Some(d) = date {
        let mut stmt = conn.prepare(
            "SELECT id, date, content, is_ai_generated, created_at, updated_at
             FROM diary_entries WHERE date = ?1 ORDER BY created_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![d], |row| Ok(DiaryEntry {
            id:              row.get(0)?,
            date:            row.get(1)?,
            content:         row.get(2)?,
            is_ai_generated: row.get::<_, i64>(3)? != 0,
            created_at:      row.get(4)?,
            updated_at:      row.get(5)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.map_err(|e| eprintln!("[db] diary row error: {e}")).ok()).collect())
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, date, content, is_ai_generated, created_at, updated_at
             FROM diary_entries ORDER BY date DESC, created_at DESC
             LIMIT 200",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(DiaryEntry {
            id:              row.get(0)?,
            date:            row.get(1)?,
            content:         row.get(2)?,
            is_ai_generated: row.get::<_, i64>(3)? != 0,
            created_at:      row.get(4)?,
            updated_at:      row.get(5)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.map_err(|e| eprintln!("[db] diary row error: {e}")).ok()).collect())
    }
}

fn duration_label(secs: i64) -> String {
    if secs >= 3600 {
        format!("{:.1}h", secs as f64 / 3600.0)
    } else {
        let mins = ((secs + 59) / 60).max(1);
        format!("{}m", mins)
    }
}

fn compact_text(input: &str, max_len: usize) -> String {
    let compact = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_len {
        compact
    } else {
        format!("{}...", compact.chars().take(max_len).collect::<String>())
    }
}

fn is_system_noise_window(app_name: &str, window_title: &str) -> bool {
    let app = app_name.to_lowercase();
    let title = window_title.to_lowercase();
    app.contains("lockapp")
        || title.contains("windows default lock screen")
        || title == "program manager"
        || title == "start"
        || title == "search"
        || title.contains("task view")
        || title.contains("task switching")
        || title.contains("snap assist")
}

fn is_communication_signal(app_name: &str, window_title: &str) -> bool {
    let app = app_name.to_lowercase();
    let title = window_title.to_lowercase();
    let keys = [
        "discord", "whatsapp", "telegram", "teams", "slack", "messenger", "signal", "skype",
        "chat", "dm", "voice call",
    ];
    keys.iter().any(|k| app.contains(k) || title.contains(k))
}

fn is_browser_app(app_name: &str) -> bool {
    let app = app_name.to_lowercase();
    app.contains("browser")
        || app.contains("chrome")
        || app.contains("firefox")
        || app.contains("edge")
        || app.contains("safari")
}

fn db_gather_generate_context(
    conn: &rusqlite::Connection,
    date: &str,
) -> Result<(String, Option<String>, String, String), String> {
    use chrono::NaiveDate;
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "Invalid date format (expected YYYY-MM-DD)".to_string())?;
    let start_ts = d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let end_ts   = start_ts + 86400;

    let mut apps_stmt = conn.prepare(
        "SELECT app_name, SUM(duration_seconds)
         FROM activities WHERE start_time >= ?1 AND start_time < ?2
         GROUP BY app_name ORDER BY 2 DESC LIMIT 15",
    ).map_err(|e| e.to_string())?;

    let apps: Vec<String> = apps_stmt.query_map(rusqlite::params![start_ts, end_ts], |row| {
        let app: String = row.get(0)?;
        let secs: i64   = row.get(1)?;
        Ok(format!("- {} ({})", app, duration_label(secs)))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    let mut windows_stmt = conn.prepare(
        "SELECT app_name, window_title, SUM(duration_seconds) AS total_secs, COUNT(*) AS switches
         FROM activities
         WHERE start_time >= ?1 AND start_time < ?2
         GROUP BY app_name, window_title
         ORDER BY total_secs DESC
         LIMIT 100",
    ).map_err(|e| e.to_string())?;

    let mut communication_windows: Vec<String> = Vec::new();
    let mut browser_titles: Vec<String> = Vec::new();
    let mut notable_windows: Vec<String> = Vec::new();
    let mut seen_chat = HashSet::new();
    let mut seen_browser = HashSet::new();
    let mut seen_notable = HashSet::new();
    let mut system_noise_secs: i64 = 0;

    let rows = windows_stmt
        .query_map(rusqlite::params![start_ts, end_ts], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for (app, title, secs, switches) in rows.filter_map(|r| r.ok()) {
        let title_compact = compact_text(&title, 140);
        if title_compact.is_empty() {
            continue;
        }

        if is_system_noise_window(&app, &title_compact) {
            system_noise_secs += secs;
            continue;
        }

        if is_communication_signal(&app, &title_compact) && communication_windows.len() < 14 {
            let key = format!("{}|{}", app.to_lowercase(), title_compact.to_lowercase());
            if seen_chat.insert(key) {
                communication_windows.push(format!(
                    "- {} | {} ({}, {} switches)",
                    app,
                    title_compact,
                    duration_label(secs),
                    switches
                ));
            }
        }

        if is_browser_app(&app)
            && !title_compact.eq_ignore_ascii_case("new tab")
            && !title_compact.eq_ignore_ascii_case("new tab - brave")
            && browser_titles.len() < 16
        {
            let key = title_compact.to_lowercase();
            if seen_browser.insert(key) {
                browser_titles.push(format!("- {} ({})", title_compact, duration_label(secs)));
            }
        }

        if notable_windows.len() < 16 {
            let key = format!("{}|{}", app.to_lowercase(), title_compact.to_lowercase());
            if seen_notable.insert(key) {
                notable_windows.push(format!(
                    "- {} | {} ({})",
                    app,
                    title_compact,
                    duration_label(secs)
                ));
            }
        }
    }

    let mut ocr_snippets: Vec<String> = Vec::new();
    let mut url_snippets: Vec<String> = Vec::new();
    let mut seen_ocr = HashSet::new();
    let mut seen_url = HashSet::new();

    let mut meta_stmt = conn.prepare(
        "SELECT metadata
         FROM activities
         WHERE start_time >= ?1 AND start_time < ?2 AND metadata IS NOT NULL
         ORDER BY start_time DESC
         LIMIT 180",
    ).map_err(|e| e.to_string())?;

    let meta_rows = meta_stmt
        .query_map(rusqlite::params![start_ts, end_ts], |row| {
            row.get::<_, Option<Vec<u8>>>(0)
        })
        .map_err(|e| e.to_string())?;

    for blob_opt in meta_rows.filter_map(|r| r.ok()) {
        let Some(blob) = blob_opt else { continue; };
        let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&blob) else {
            continue;
        };

        if let Some(url) = meta.get("url").and_then(|v| v.as_str()) {
            let compact = compact_text(url, 120);
            if !compact.is_empty() && seen_url.insert(compact.to_lowercase()) {
                if url_snippets.len() < 12 {
                    url_snippets.push(format!("- {}", compact));
                }
            }
        }

        if let Some(screen_text) = meta.get("screen_text").and_then(|v| v.as_str()) {
            let compact = compact_text(screen_text, 180);
            if compact.len() < 20 {
                continue;
            }
            let key = compact.to_lowercase();
            if seen_ocr.insert(key) && ocr_snippets.len() < 12 {
                ocr_snippets.push(format!("- {}", compact));
            }
        }
    }

    let mut context_sections: Vec<String> = Vec::new();

    if !apps.is_empty() {
        context_sections.push(format!("Top apps by focus time:\n{}", apps.join("\n")));
    }
    if !communication_windows.is_empty() {
        context_sections.push(format!(
            "Communication/chat activity (prioritize this in summary):\n{}",
            communication_windows.join("\n")
        ));
    }
    if !browser_titles.is_empty() {
        context_sections.push(format!("Browser page/title history:\n{}", browser_titles.join("\n")));
    }
    if !url_snippets.is_empty() {
        context_sections.push(format!("Captured URLs:\n{}", url_snippets.join("\n")));
    }
    if !ocr_snippets.is_empty() {
        context_sections.push(format!("OCR snippets from on-screen content:\n{}", ocr_snippets.join("\n")));
    }
    if !notable_windows.is_empty() {
        context_sections.push(format!("Other notable windows:\n{}", notable_windows.join("\n")));
    }
    if system_noise_secs > 0 {
        context_sections.push(format!(
            "System/lock-screen windows observed: {} (treat as low-signal context).",
            duration_label(system_noise_secs)
        ));
    }

    let context_summary = if context_sections.is_empty() {
        "No activity data recorded for this day yet.".to_string()
    } else {
        context_sections.join("\n\n")
    };

    // Read the user's configured AI provider and model
    let ai_provider = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'ai_provider'",
        [], |row| row.get::<_, String>(0),
    ).unwrap_or_else(|_| "nvidia".to_string());

    let ai_model = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'default_model'",
        [], |row| row.get::<_, String>(0),
    ).unwrap_or_default();

    // Determine the correct API key based on provider
    let env_key_name = match ai_provider.to_lowercase().as_str() {
        "openai" => "openai_api_key",
        "anthropic" => "anthropic_api_key",
        "groq" => "groq_api_key",
        _ => "nvidia_api_key",
    };
    let env_var_name = match ai_provider.to_lowercase().as_str() {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "groq" => "GROQ_API_KEY",
        _ => "NVIDIA_API_KEY",
    };

    let api_key = conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![env_key_name], |row| row.get::<_, String>(0),
    ).ok().filter(|s| !s.is_empty())
    .or_else(|| std::env::var(env_var_name).ok().filter(|s| !s.is_empty()));

    Ok((context_summary, api_key, ai_model, ai_provider))
}

fn resolve_diary_ai_endpoint(provider: &str, user_model: Option<&str>) -> (String, String) {
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
        _ => (
            "https://integrate.api.nvidia.com/v1/chat/completions".to_string(),
            user_model.unwrap_or("meta/llama-3.3-70b-instruct").to_string(),
        ),
    }
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn diary_get_entries(app_handle: AppHandle, date: Option<String>) -> Result<Vec<DiaryEntry>, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    db_get_entries(&conn, date.as_deref())
}

#[tauri::command]
pub async fn diary_save_entry(app_handle: AppHandle, entry: DiaryEntry) -> Result<DiaryEntry, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    let now  = Utc::now().timestamp();

    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM diary_entries WHERE id = ?1)",
        [&entry.id], |row| row.get(0),
    ).unwrap_or(false);

    if exists {
        conn.execute(
            "UPDATE diary_entries SET date=?1,content=?2,is_ai_generated=?3,updated_at=?4 WHERE id=?5",
            rusqlite::params![entry.date, entry.content, entry.is_ai_generated as i64, now, entry.id],
        ).map_err(|e| e.to_string())?;
        Ok(DiaryEntry { updated_at: now, ..entry })
    } else {
        let id = if entry.id.is_empty() { Uuid::new_v4().to_string() } else { entry.id.clone() };
        conn.execute(
            "INSERT INTO diary_entries (id,date,content,is_ai_generated,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
            rusqlite::params![id, entry.date, entry.content, entry.is_ai_generated as i64, now],
        ).map_err(|e| e.to_string())?;
        Ok(DiaryEntry { id, created_at: now, updated_at: now, ..entry })
    }
}

#[tauri::command]
pub async fn diary_delete_entry(app_handle: AppHandle, id: String) -> Result<bool, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    conn.execute("DELETE FROM diary_entries WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn diary_generate_entry(
    app_handle: AppHandle,
    date: String,
    model: Option<String>,
) -> Result<String, String> {
    // Phase 1: sync DB — collect all data into owned Strings, then conn is dropped
    let (activity_context, api_key, db_model, ai_provider) = tokio::task::spawn_blocking({
        let app2 = app_handle.clone();
        let date2 = date.clone();
        move || -> Result<(String, Option<String>, String, String), String> {
            let conn = crate::intent::db::open(&app2)?;
            db_gather_generate_context(&conn, &date2)
        }
    }).await.map_err(|e| e.to_string())??;

    // Phase 2: async API call (no Connection held)
    // Use explicit model > db model > provider default
    let user_model = model.as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| if db_model.is_empty() { None } else { Some(db_model.as_str()) })
    ;

    let (endpoint, model_id) = resolve_diary_ai_endpoint(&ai_provider, user_model);

    let Some(key) = api_key else {
        return Ok(format!(
            "## Yesterday Summary\n*AI diary generation requires an API key. Set one in Settings.*\n\n**Activity summary for {}:**\n{}\n\n## What To Do Today\n1. Review yesterday's work blocks and pick one high-impact target.\n2. Start with a 60-90 minute focus session on your top priority.\n3. Close one outstanding task before end of day.",
            date,
            activity_context
        ));
    };

    let prompt = format!(
        "Write a concise personal reflection brief for {} based on tracked activity data.\n\n\
         Activity data:\n{}\n\n\
         Return markdown using exactly these headings:\n\
         ## Yesterday Summary\n\
         ## What To Do Today\n\n\
         Requirements:\n\
         - In Yesterday Summary, write 2-3 short paragraphs in first-person past tense.\n\
         - Mention specific apps/tools from the activity data when available.\n\
         - If communication evidence exists (Discord/WhatsApp/Teams/Telegram/Slack/browser chat tabs/OCR), explicitly mention it with approximate time and context.\n\
         - Do not invent names or message content; only use what appears in titles/OCR/context provided.\n\
         - Down-weight lock-screen/system windows unless they were dominant.\n\
         - In What To Do Today, provide 3-5 numbered, actionable priorities for today.\n\
         - If activity data is sparse, say so briefly and still give practical priorities.",
        date,
        activity_context
    );

    let provider_norm = ai_provider.to_lowercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;

    if provider_norm == "anthropic" {
        #[derive(Serialize)] struct Msg { role: &'static str, content: String }
        #[derive(Serialize)] struct Req {
            model: String,
            messages: Vec<Msg>,
            max_tokens: u32,
            temperature: f32,
        }

        let resp = client
            .post(&endpoint)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&Req {
                model: model_id,
                messages: vec![Msg { role: "user", content: prompt }],
                max_tokens: 512,
                temperature: 0.65,
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("AI {} — {}", status, &text[..text.len().min(300)]));
        }

        let parsed: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let content = parsed
            .get("content")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find_map(|item| {
                item.get("text").and_then(|t| t.as_str())
            }))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Empty diary generation response".to_string())?;

        Ok(content)
    } else {
        #[derive(Serialize)] struct Msg { role: &'static str, content: String }
        #[derive(Serialize)] struct Req {
            model: String,
            messages: Vec<Msg>,
            max_tokens: u32,
            temperature: f32,
        }

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", key))
            .json(&Req {
                model: model_id,
                messages: vec![Msg { role: "user", content: prompt }],
                max_tokens: 512,
                temperature: 0.65,
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("AI {} — {}", status, &text[..text.len().min(300)]));
        }

        let parsed: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let content = parsed
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|msg| msg.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Empty diary generation response".to_string())?;

        Ok(content)
    }
}