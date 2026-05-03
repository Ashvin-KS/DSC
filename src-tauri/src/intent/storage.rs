use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct StorageStats {
    #[serde(rename = "dbPath")]
    pub db_path: String,
    #[serde(rename = "totalSizeBytes")]
    pub total_size_bytes: i64,
    #[serde(rename = "activitiesCount")]
    pub activities_count: i64,
    #[serde(rename = "chatMessagesCount")]
    pub chat_messages_count: i64,
    #[serde(rename = "diaryEntriesCount")]
    pub diary_entries_count: i64,
    #[serde(rename = "codeEventsCount")]
    pub code_events_count: i64,
    #[serde(rename = "snapshotsCount")]
    pub snapshots_count: i64,
}

fn db_size_bytes(app: &AppHandle) -> Result<i64, String> {
    let path = crate::intent::db::db_path(app)?;
    Ok(path.metadata().map(|m| m.len() as i64).unwrap_or(0))
}

fn get_valid_table_name(table: &str) -> Option<&str> {
    match table {
        "activities" | "chat_messages" | "chat_sessions" | "diary_entries" | "code_file_events" | "dashboard_snapshots" | "app_settings" | "retrieval_chunks" => Some(table),
        _ => None,
    }
}

fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    let Some(valid_table) = get_valid_table_name(table) else { return 0; };
    let sql = format!("SELECT COUNT(*) FROM {}", valid_table);
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0)).unwrap_or(0)
}

#[tauri::command]
pub async fn storage_get_stats(app_handle: AppHandle) -> Result<StorageStats, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    let db_path = crate::intent::db::db_path(&app_handle)?;

    Ok(StorageStats {
        db_path: db_path.to_string_lossy().to_string(),
        total_size_bytes: db_size_bytes(&app_handle)?,
        activities_count: count(&conn, "activities"),
        chat_messages_count: count(&conn, "chat_messages"),
        diary_entries_count: count(&conn, "diary_entries"),
        code_events_count: count(&conn, "code_file_events"),
        snapshots_count: count(&conn, "dashboard_snapshots"),
    })
}

#[tauri::command]
pub async fn storage_clear_all(app_handle: AppHandle) -> Result<bool, String> {
    let conn = crate::intent::db::open(&app_handle)?;

    conn.execute_batch(
        "
        DELETE FROM activities;
        DELETE FROM code_file_events;
        DELETE FROM chat_messages;
        DELETE FROM chat_sessions;
        DELETE FROM diary_entries;
        DELETE FROM dashboard_snapshots;
        DELETE FROM retrieval_chunks;
        DELETE FROM retrieval_embeddings;
        PRAGMA wal_checkpoint(TRUNCATE);
        VACUUM;
        ",
    )
    .map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub async fn storage_export_data(app_handle: AppHandle, file_path: String) -> Result<bool, String> {
    let p = std::path::PathBuf::from(&file_path);
    if !p.is_absolute() {
        return Err("Export path must be absolute".into());
    }
    let conn = crate::intent::db::open(&app_handle)?;
    let export = json!({
        "version": 1,
        "exportedAt": chrono::Utc::now().timestamp(),
        "activities": dump_table(&conn, "activities")?,
        "chatSessions": dump_table(&conn, "chat_sessions")?,
        "chatMessages": dump_table(&conn, "chat_messages")?,
        "diaryEntries": dump_table(&conn, "diary_entries")?,
        "codeEvents": dump_table(&conn, "code_file_events")?,
        "dashboardSnapshots": dump_table(&conn, "dashboard_snapshots")?,
        "appSettings": dump_table(&conn, "app_settings")?,
        "retrievalChunks": dump_table(&conn, "retrieval_chunks")?,
    });

    let payload = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
    fs::write(file_path, payload).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn storage_import_data(
    app_handle: AppHandle,
    file_path: String,
    replace_existing: Option<bool>,
) -> Result<bool, String> {
    let p = std::path::PathBuf::from(&file_path);
    if !p.is_absolute() {
        return Err("Import path must be absolute".into());
    }

    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let replace = replace_existing.unwrap_or(true);
    let mut conn = crate::intent::db::open(&app_handle)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    if replace {
        tx.execute_batch(
            "
            DELETE FROM activities;
            DELETE FROM code_file_events;
            DELETE FROM chat_messages;
            DELETE FROM chat_sessions;
            DELETE FROM diary_entries;
            DELETE FROM dashboard_snapshots;
            DELETE FROM retrieval_chunks;
            DELETE FROM retrieval_embeddings;
            ",
        )
        .map_err(|e| e.to_string())?;
    }

    import_activities(&tx, parsed.get("activities").and_then(Value::as_array))?;
    import_chat_sessions(&tx, parsed.get("chatSessions").and_then(Value::as_array))?;
    import_chat_messages(&tx, parsed.get("chatMessages").and_then(Value::as_array))?;
    import_diary_entries(&tx, parsed.get("diaryEntries").and_then(Value::as_array))?;
    import_code_events(&tx, parsed.get("codeEvents").and_then(Value::as_array))?;
    import_dashboard_snapshots(&tx, parsed.get("dashboardSnapshots").and_then(Value::as_array))?;
    import_settings(&tx, parsed.get("appSettings").and_then(Value::as_array))?;
    import_retrieval_chunks(&tx, parsed.get("retrievalChunks").and_then(Value::as_array))?;

    tx.commit().map_err(|e| e.to_string())?;

    let conn = crate::intent::db::open(&app_handle)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn enforce_max_storage_mb(app_handle: &AppHandle, max_storage_mb: i64) -> Result<bool, String> {
    if max_storage_mb <= 0 {
        return Ok(false);
    }

    let target_bytes = max_storage_mb * 1024 * 1024;
    let conn = crate::intent::db::open(app_handle)?;
    let mut current_size = db_size_bytes(app_handle)?;

    if current_size <= target_bytes {
        return Ok(false);
    }

    for _ in 0..20 {
        let activity_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM activities ORDER BY start_time ASC LIMIT 5000")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        for id in &activity_ids {
            crate::intent::retrieval::delete_retrieval_chunks_for_entity(&conn, "activity", &id.to_string())?;
        }

        let file_event_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM code_file_events ORDER BY detected_at ASC LIMIT 5000")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        for id in &file_event_ids {
            crate::intent::retrieval::delete_retrieval_chunks_for_entity(&conn, "file_event", &id.to_string())?;
        }

        let chat_message_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM chat_messages ORDER BY created_at ASC LIMIT 3000")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        for id in &chat_message_ids {
            crate::intent::retrieval::delete_retrieval_chunks_for_entity(&conn, "chat_message", &id.to_string())?;
        }

        let diary_entry_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM diary_entries ORDER BY created_at ASC LIMIT 1000")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        for id in &diary_entry_ids {
            crate::intent::retrieval::delete_retrieval_chunks_for_entity(&conn, "diary_entry", id)?;
        }

        conn.execute(
            "DELETE FROM activities WHERE id IN (SELECT id FROM activities ORDER BY start_time ASC LIMIT 5000)",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "DELETE FROM code_file_events WHERE id IN (SELECT id FROM code_file_events ORDER BY detected_at ASC LIMIT 5000)",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "DELETE FROM chat_messages WHERE id IN (SELECT id FROM chat_messages ORDER BY created_at ASC LIMIT 3000)",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "DELETE FROM diary_entries WHERE id IN (SELECT id FROM diary_entries ORDER BY created_at ASC LIMIT 1000)",
            [],
        )
        .map_err(|e| e.to_string())?;

        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|e| e.to_string())?;

        current_size = db_size_bytes(app_handle)?;
        if current_size <= target_bytes {
            return Ok(true);
        }

        if count(&conn, "activities") == 0 && count(&conn, "code_file_events") == 0 && count(&conn, "chat_messages") == 0 {
            break;
        }
    }

    Ok(current_size < db_size_bytes(app_handle)?)
}

/// Run startup maintenance: data retention cleanup, storage limits, and PRAGMA optimize.
/// Call this once during app setup after db::init().
pub fn run_startup_maintenance(app_handle: &AppHandle) {
    let conn = match crate::intent::db::open(app_handle) {
        Ok(c) => c,
        Err(_) => return,
    };

    // 1. Read settings for retention and cleanup config
    let retention_days: i64 = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'data_retention_days'",
        [], |row| row.get::<_, String>(0),
    ).ok().and_then(|v| v.parse().ok()).unwrap_or(30);

    let auto_cleanup: bool = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'auto_cleanup'",
        [], |row| row.get::<_, String>(0),
    ).map(|v| v == "true").unwrap_or(true);

    let max_storage_mb: i64 = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'max_storage_mb'",
        [], |row| row.get::<_, String>(0),
    ).ok().and_then(|v| v.parse().ok()).unwrap_or(512);

    // 2. Data retention: delete records older than retention_days
    if retention_days > 0 {
        let cutoff = chrono::Utc::now().timestamp() - (retention_days * 86400);

        // ALWAYS delete retrieval chunks (vectors) BEFORE the main entity rows are deleted!
        let _ = conn.execute(
            "DELETE FROM retrieval_chunks WHERE entity_type = 'activity' AND source_ts < ?1",
            rusqlite::params![cutoff],
        );
        let _ = conn.execute(
            "DELETE FROM retrieval_chunks WHERE entity_type = 'file_event' AND source_ts < ?1",
            rusqlite::params![cutoff],
        );

        let _ = conn.execute(
            "DELETE FROM activities WHERE start_time < ?1",
            rusqlite::params![cutoff],
        );
        let _ = conn.execute(
            "DELETE FROM code_file_events WHERE detected_at < ?1",
            rusqlite::params![cutoff],
        );
    }

    // 3. Enforce max storage if auto_cleanup is on
    if auto_cleanup {
        let _ = enforce_max_storage_mb(app_handle, max_storage_mb);
    }

    // 4. PRAGMA optimize — lets SQLite auto-tune indexes based on query patterns
    let _ = conn.execute_batch("PRAGMA optimize;");
}

fn dump_table(conn: &rusqlite::Connection, table: &str) -> Result<Vec<Value>, String> {
    let valid_table = get_valid_table_name(table).ok_or_else(|| "Invalid table".to_string())?;
    let sql = format!("SELECT * FROM {}", valid_table);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for (idx, name) in col_names.iter().enumerate() {
                let val = match row.get_ref(idx)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(i) => json!(i),
                    rusqlite::types::ValueRef::Real(f) => json!(f),
                    rusqlite::types::ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                    rusqlite::types::ValueRef::Blob(b) => Value::Array(b.iter().map(|v| json!(v)).collect()),
                };
                obj.insert(name.clone(), val);
            }
            Ok(Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn as_i64(v: Option<&Value>) -> i64 {
    v.and_then(Value::as_i64).unwrap_or(0)
}

fn as_string(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_string()
}

fn import_activities(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO activities (id, app_name, app_hash, window_title, window_title_hash, category_id, start_time, end_time, duration_seconds, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                as_i64(item.get("id")),
                as_string(item.get("app_name")),
                as_i64(item.get("app_hash")),
                as_string(item.get("window_title")),
                as_i64(item.get("window_title_hash")),
                as_i64(item.get("category_id")),
                as_i64(item.get("start_time")),
                as_i64(item.get("end_time")),
                as_i64(item.get("duration_seconds")),
                item.get("metadata").and_then(|v| serde_json::to_vec(v).ok()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_chat_sessions(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO chat_sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                as_string(item.get("id")),
                as_string(item.get("title")),
                as_i64(item.get("created_at")),
                as_i64(item.get("updated_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_chat_messages(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, created_at, agent_steps, activities, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                as_i64(item.get("id")),
                as_string(item.get("session_id")),
                as_string(item.get("role")),
                as_string(item.get("content")),
                as_i64(item.get("created_at")),
                item.get("agent_steps").and_then(Value::as_str).map(|s| s.to_string()),
                item.get("activities").and_then(Value::as_str).map(|s| s.to_string()),
                item.get("metadata").and_then(Value::as_str).map(|s| s.to_string()),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_diary_entries(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO diary_entries (id, date, content, is_ai_generated, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                as_string(item.get("id")),
                as_string(item.get("date")),
                as_string(item.get("content")),
                as_i64(item.get("is_ai_generated")),
                as_i64(item.get("created_at")),
                as_i64(item.get("updated_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_code_events(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO code_file_events (id, path, project_root, entity_type, change_type, content_preview, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                as_i64(item.get("id")),
                as_string(item.get("path")),
                as_string(item.get("project_root")),
                as_string(item.get("entity_type")),
                as_string(item.get("change_type")),
                item.get("content_preview").and_then(Value::as_str).map(|s| s.to_string()),
                as_i64(item.get("detected_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_dashboard_snapshots(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO dashboard_snapshots (date_key, summary_json, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                as_string(item.get("date_key")),
                as_string(item.get("summary_json")),
                as_i64(item.get("updated_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_settings(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![
                as_string(item.get("key")),
                as_string(item.get("value")),
                as_i64(item.get("updated_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn import_retrieval_chunks(conn: &rusqlite::Connection, items: Option<&Vec<Value>>) -> Result<(), String> {
    let Some(items) = items else { return Ok(()); };
    for item in items {
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_chunks (entity_type, entity_id, source_type, chunk_text, chunk_summary, project_root, source_ts, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                as_string(item.get("entity_type")),
                as_string(item.get("entity_id")),
                as_string(item.get("source_type")),
                as_string(item.get("chunk_text")),
                item.get("chunk_summary").and_then(Value::as_str).map(|s| s.to_string()),
                item.get("project_root").and_then(Value::as_str).map(|s| s.to_string()),
                as_i64(item.get("source_ts")),
                as_i64(item.get("created_at")),
                as_i64(item.get("updated_at")),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
