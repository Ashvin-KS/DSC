use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const SCAN_INTERVAL_SECS: u64 = 2;
const MAX_SCAN_DEPTH: usize = 8;
const RECENT_CREATE_WINDOW_MS: i64 = 180_000;
const MAX_SNAPSHOT_CHARS: usize = 4000;
const MAX_PREVIEW_CHARS: usize = 500;
static MONITOR_ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Debug, Clone, Serialize)]
struct NotesMutationEvent {
    vault_path: Option<String>,
    action: String,
    path: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    is_directory: bool,
    source: String,
}

pub fn start_file_monitor(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let roots = discover_roots();
        if roots.is_empty() {
            println!("[FileMonitor] No valid roots found. Set INTENTFLOW_CODE_ROOTS to enable monitoring.");
            return;
        }
        println!(
            "[FileMonitor] Active monitoring started (interval={}s, depth={})",
            SCAN_INTERVAL_SECS, MAX_SCAN_DEPTH
        );
        for root in &roots {
            println!("[FileMonitor] Watching root: {}", root.to_string_lossy());
        }

        let mut known_mtimes: HashMap<String, i64> = HashMap::new();
        let mut known_dirs: HashSet<String> = HashSet::new();
        let mut known_hashes: HashMap<String, u64> = HashMap::new();
        let mut initialized_roots: HashSet<String> = HashSet::new();

        loop {
            if !MONITOR_ENABLED.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_secs(SCAN_INTERVAL_SECS)).await;
                continue;
            }

            // Open ONE connection per scan cycle instead of per event
            let conn = match crate::intent::db::open(&app_handle) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[FileMonitor] Failed to open DB: {e}");
                    tokio::time::sleep(Duration::from_secs(SCAN_INTERVAL_SECS)).await;
                    continue;
                }
            };

            for root in &roots {
                scan_root(
                    &app_handle,
                    &conn,
                    root,
                    &mut known_mtimes,
                    &mut known_dirs,
                    &mut known_hashes,
                    &mut initialized_roots,
                );
            }
            tokio::time::sleep(Duration::from_secs(SCAN_INTERVAL_SECS)).await;
        }
    });
}

pub fn set_monitor_enabled(enabled: bool) {
    MONITOR_ENABLED.store(enabled, Ordering::Relaxed);
}

fn discover_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Ok(raw) = std::env::var("INTENTFLOW_CODE_ROOTS") {
        for part in raw.split(';').flat_map(|p| p.split(',')) {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }

    if roots.is_empty() {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            roots.push(PathBuf::from(&profile).join("Developer").join("Code"));
            roots.push(PathBuf::from(profile).join("Documents").join("GitHub"));
        }
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd);
        }
    }

    let mut unique: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for p in roots.into_iter().filter(|p| p.exists() && p.is_dir()) {
        let key = p.to_string_lossy().to_string();
        if seen.insert(key) {
            unique.push(p);
        }
    }
    unique
}

fn hash_content(content: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

fn scan_root(
    app_handle: &AppHandle,
    conn: &rusqlite::Connection,
    root: &Path,
    known_mtimes: &mut HashMap<String, i64>,
    known_dirs: &mut HashSet<String>,
    known_hashes: &mut HashMap<String, u64>,
    initialized_roots: &mut HashSet<String>,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().timestamp();
    let mut seen_in_scan: HashSet<String> = HashSet::new();
    let mut seen_dirs_in_scan: HashSet<String> = HashSet::new();
    let root_string = root.to_string_lossy().to_string();
    let initialized = initialized_roots.contains(&root_string);

    let walker = WalkDir::new(root)
        .max_depth(MAX_SCAN_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !matches!(
                name.as_str(),
                "system32"
                    | "windows"
                    | "library"
                    | "program files"
                    | "program files (x86)"
                    | "programdata"
                    | "appdata"
                    | ".git"
                    | "node_modules"
                    | ".svelte-kit"
                    | ".next"
                    | "dist"
                    | "target"
                    | "build"
                    | ".idea"
                    | ".vscode"
            )
        });

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_type().is_dir() {
            let dir_str = path.to_string_lossy().to_string();
            seen_dirs_in_scan.insert(dir_str.clone());
            if initialized && !known_dirs.contains(&dir_str) {
                let _ = insert_event(
                    app_handle,
                    conn,
                    &dir_str,
                    &root_string,
                    "folder",
                    "created",
                    None,
                    now,
                );
            }
            continue;
        }
        if !entry.file_type().is_file() || !is_code_file(path) {
            continue;
        }

        let Some(mtime) = modified_unix_millis(path) else {
            continue;
        };
        let path_str = path.to_string_lossy().to_string();
        seen_in_scan.insert(path_str.clone());

        match known_mtimes.get(&path_str).copied() {
            None => {
                known_mtimes.insert(path_str.clone(), mtime);
                if let Some(content) = read_file_snapshot(path) {
                    known_hashes.insert(path_str.clone(), hash_content(&content));
                }
                if now_ms - mtime <= RECENT_CREATE_WINDOW_MS {
                    let created_preview = read_file_snapshot(path).map(|content| {
                        format!(
                            "Initial content:\n{}",
                            truncate_chars(&content, MAX_PREVIEW_CHARS)
                        )
                    });
                    let _ = insert_event(
                        app_handle,
                        conn,
                        &path_str,
                        &root_string,
                        "file",
                        "created",
                        created_preview.as_deref(),
                        now,
                    );
                }
            }
            Some(prev) if mtime > prev => {
                known_mtimes.insert(path_str.clone(), mtime);
                let current = read_file_snapshot(path);
                // Only record a change if the content actually differs
                let current_hash = current.as_deref().map(hash_content);
                let prev_hash = known_hashes.get(&path_str).copied();
                let content_changed = match (current_hash, prev_hash) {
                    (Some(c), Some(p)) => c != p,
                    _ => true,
                };
                if content_changed {
                    if let Some(h) = current_hash {
                        known_hashes.insert(path_str.clone(), h);
                    }
                    let preview = current
                        .as_deref()
                        .map(|c| truncate_chars(c, MAX_PREVIEW_CHARS));
                    let _ = insert_event(
                        app_handle,
                        conn,
                        &path_str,
                        &root_string,
                        "file",
                        "modified",
                        preview.as_deref(),
                        now,
                    );
                }
            }
            _ => {}
        }
    }

    let deleted_dirs: Vec<String> = known_dirs
        .iter()
        .filter(|p| p.starts_with(&root_string) && !seen_dirs_in_scan.contains(*p))
        .cloned()
        .collect();
    for path in deleted_dirs {
        known_dirs.remove(&path);
        if initialized {
            let _ = insert_event(
                app_handle,
                conn,
                &path,
                &root_string,
                "folder",
                "deleted",
                None,
                now,
            );
        }
    }

    known_dirs.extend(seen_dirs_in_scan.into_iter());

    let deleted: Vec<String> = known_mtimes
        .keys()
        .filter(|p| p.starts_with(&root_string) && !seen_in_scan.contains(*p))
        .cloned()
        .collect();
    for path in deleted {
        known_mtimes.remove(&path);
        known_hashes.remove(&path);
        let _ = insert_event(
            app_handle,
            conn,
            &path,
            &root_string,
            "file",
            "deleted",
            None,
            now,
        );
    }

    initialized_roots.insert(root_string);

    // Provide a hard bound on memory growth over long sessions
    if known_mtimes.len() > 100_000 || known_hashes.len() > 100_000 {
        println!("[FileMonitor] Reached 100k memory bound. Clearing cache.");
        known_mtimes.clear();
        known_hashes.clear();
        known_dirs.clear();
        initialized_roots.clear();
    }
}

fn insert_event(
    app_handle: &AppHandle,
    conn: &rusqlite::Connection,
    path: &str,
    project_root: &str,
    entity_type: &str,
    change_type: &str,
    content_preview: Option<&str>,
    detected_at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO code_file_events (path, project_root, entity_type, change_type, content_preview, detected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![path, project_root, entity_type, change_type, content_preview, detected_at],
    )
    .map_err(|e| e.to_string())?;
    println!(
        "[FileMonitor] {} {} | {}{}",
        entity_type,
        change_type,
        path,
        content_preview
            .map(|p| format!(" | {}", p.replace('\n', " ")))
            .unwrap_or_default()
    );

    let event_id = conn.last_insert_rowid();
    let mut chunk_text = format!("{} {} {}", entity_type, change_type, path);
    if let Some(preview) = content_preview {
        chunk_text.push_str("\n");
        chunk_text.push_str(preview);
    }
    let summary = format!("{} {} in {}", entity_type, change_type, project_root);
    let _ = crate::intent::retrieval::upsert_retrieval_chunk(
        conn,
        crate::intent::retrieval::ChunkInput {
            entity_type: "file_event",
            entity_id: &event_id.to_string(),
            source_type: "file_change",
            chunk_text: &chunk_text,
            chunk_summary: Some(summary),
            project_root: Some(project_root),
            source_ts: Some(detected_at),
        },
    );

    emit_external_notes_mutation(app_handle, path, entity_type, change_type);

    Ok(())
}

fn emit_external_notes_mutation(
    app_handle: &AppHandle,
    path: &str,
    entity_type: &str,
    change_type: &str,
) {
    let is_directory = entity_type == "folder";
    let is_markdown = entity_type == "file" && path.to_ascii_lowercase().ends_with(".md");
    if !is_directory && !is_markdown {
        return;
    }

    let action = match (entity_type, change_type) {
        ("file", "created") => "create_file",
        ("file", "modified") => "write_file",
        ("file", "deleted") => "delete",
        ("folder", "created") => "create_folder",
        ("folder", "deleted") => "delete",
        _ => return,
    };

    let payload = NotesMutationEvent {
        vault_path: None,
        action: action.to_string(),
        path: Some(path.to_string()),
        old_path: None,
        new_path: None,
        is_directory,
        source: "external".to_string(),
    };
    let _ = app_handle.emit("notes://vault-mutated", payload);
}

fn is_code_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("rs")
            | Some("ts")
            | Some("tsx")
            | Some("js")
            | Some("jsx")
            | Some("py")
            | Some("go")
            | Some("java")
            | Some("cpp")
            | Some("c")
            | Some("h")
            | Some("hpp")
            | Some("cs")
            | Some("json")
            | Some("toml")
            | Some("yaml")
            | Some("yml")
            | Some("md")
            | Some("sql")
    )
}

fn modified_unix_millis(path: &Path) -> Option<i64> {
    let modified: SystemTime = path.metadata().ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis() as i64)
}

fn read_file_snapshot(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    Some(truncate_chars(&content, MAX_SNAPSHOT_CHARS))
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in input.chars() {
        if count >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
        count += 1;
    }
    out
}
