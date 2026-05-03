/// Database initialisation — creates all Atheletia tables on first run.
use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;
use tauri::Manager;

pub fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let current = dir.join("atheletia_intent.db");
    let legacy = dir.join("allentire_intent.db");
    eprintln!("[db] Database path: {:?}", current);
    eprintln!("[db] App data dir: {:?}", dir);
    if !current.exists() && legacy.exists() {
        eprintln!("[db] Migrating legacy database from {:?} to {:?}", legacy, current);
        std::fs::copy(&legacy, &current).map_err(|e| e.to_string())?;
    }
    eprintln!("[db] Database exists: {}", current.exists());
    Ok(current)
}

pub fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    eprintln!("[db] Opening connection to: {:?}", path);
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    // Performance-critical PRAGMAs — applied on every connection open
    conn.execute_batch("
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA synchronous=NORMAL;
        PRAGMA cache_size=-8000;
        PRAGMA temp_store=MEMORY;
        PRAGMA mmap_size=268435456;
    ")
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open(app)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS categories (
            id      INTEGER PRIMARY KEY,
            name    TEXT NOT NULL UNIQUE,
            color   TEXT NOT NULL DEFAULT '#6366f1'
        );
        INSERT OR IGNORE INTO categories (id, name, color) VALUES
            (1, 'Development',   '#06b6d4'),
            (2, 'Browser',       '#3b82f6'),
            (3, 'Communication', '#22c55e'),
            (4, 'Entertainment', '#a855f7'),
            (5, 'Productivity',  '#f59e0b'),
            (6, 'System',        '#6b7280'),
            (7, 'Other',         '#4b5563');

        CREATE TABLE IF NOT EXISTS activities (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            app_name         TEXT    NOT NULL,
            app_hash         INTEGER NOT NULL DEFAULT 0,
            window_title     TEXT    NOT NULL DEFAULT '',
            window_title_hash INTEGER NOT NULL DEFAULT 0,
            category_id      INTEGER NOT NULL DEFAULT 7,
            start_time       INTEGER NOT NULL,
            end_time         INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL,
            metadata         BLOB,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );
        CREATE INDEX IF NOT EXISTS idx_act_start ON activities(start_time);
        CREATE INDEX IF NOT EXISTS idx_act_end ON activities(end_time);
        CREATE INDEX IF NOT EXISTS idx_act_category ON activities(category_id);
        CREATE INDEX IF NOT EXISTS idx_act_app_name ON activities(app_name);
        
        CREATE TABLE IF NOT EXISTS code_file_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            project_root TEXT NOT NULL,
            entity_type TEXT NOT NULL DEFAULT 'file',
            change_type TEXT NOT NULL,
            content_preview TEXT,
            detected_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_code_file_events_detected_at ON code_file_events(detected_at);
        CREATE INDEX IF NOT EXISTS idx_code_file_events_project ON code_file_events(project_root);

        CREATE TABLE IF NOT EXISTS activity_evidence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            activity_id INTEGER NOT NULL,
            evidence_type TEXT NOT NULL,
            text TEXT NOT NULL,
            source_ts INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_activity_evidence_activity ON activity_evidence(activity_id);
        CREATE INDEX IF NOT EXISTS idx_activity_evidence_type ON activity_evidence(evidence_type);
        CREATE INDEX IF NOT EXISTS idx_activity_evidence_source_ts ON activity_evidence(source_ts);

        CREATE TABLE IF NOT EXISTS chat_sessions (
            id         TEXT    PRIMARY KEY,
            title      TEXT    NOT NULL DEFAULT 'New Chat',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT    NOT NULL,
            role       TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            created_at INTEGER NOT NULL,
            agent_steps TEXT,
            activities TEXT,
            metadata   TEXT,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_msg_session ON chat_messages(session_id);

        CREATE TABLE IF NOT EXISTS diary_entries (
            id             TEXT    PRIMARY KEY,
            date           TEXT    NOT NULL,
            content        TEXT    NOT NULL,
            is_ai_generated INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(date);
        CREATE INDEX IF NOT EXISTS idx_diary_created ON diary_entries(created_at);

        CREATE TABLE IF NOT EXISTS retrieval_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            chunk_text TEXT NOT NULL,
            chunk_summary TEXT,
            project_root TEXT,
            source_ts INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(entity_type, entity_id, source_type, chunk_text)
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_entity ON retrieval_chunks(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_source_type ON retrieval_chunks(source_type);
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_source_ts ON retrieval_chunks(source_ts);
        CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_project_root ON retrieval_chunks(project_root);

        CREATE TABLE IF NOT EXISTS retrieval_embeddings (
            chunk_id INTEGER PRIMARY KEY,
            model_name TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            vector_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (chunk_id) REFERENCES retrieval_chunks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS embedding_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chunk_id INTEGER NOT NULL UNIQUE,
            model_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (chunk_id) REFERENCES retrieval_chunks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status, updated_at);

        CREATE TABLE IF NOT EXISTS daily_summaries (
            date_key TEXT PRIMARY KEY,
            summary_type TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_summaries_type ON daily_summaries(summary_type, updated_at);

        CREATE TABLE IF NOT EXISTS weekly_summaries (
            week_key TEXT NOT NULL,
            summary_type TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (week_key, summary_type)
        );
        CREATE INDEX IF NOT EXISTS idx_weekly_summaries_type ON weekly_summaries(summary_type, updated_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS activity_evidence_fts USING fts5(
            text,
            evidence_type UNINDEXED,
            activity_id UNINDEXED,
            source_ts UNINDEXED,
            content=''
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_chunks_fts USING fts5(
            chunk_text,
            chunk_summary,
            entity_type UNINDEXED,
            entity_id UNINDEXED,
            source_type UNINDEXED,
            source_ts UNINDEXED,
            project_root UNINDEXED,
            content=''
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dashboard_snapshots (
             date_key TEXT PRIMARY KEY,
             summary_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );
        ",
    )
    .map_err(|e| e.to_string())?;

    // ── Migrations: add columns that may be absent in older databases ──
    let migrations = [
        "ALTER TABLE activities ADD COLUMN app_hash INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE activities ADD COLUMN window_title_hash INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE activities ADD COLUMN metadata BLOB",
        "ALTER TABLE chat_messages ADD COLUMN agent_steps TEXT",
        "ALTER TABLE chat_messages ADD COLUMN activities TEXT",
        "ALTER TABLE chat_messages ADD COLUMN metadata TEXT",
    ];
    for sql in &migrations {
        // ALTER TABLE … ADD COLUMN fails with "duplicate column" if it already exists.
        // We simply ignore that error.
        let _ = conn.execute_batch(sql);
    }

    Ok(())
}
