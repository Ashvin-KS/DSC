use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

use crate::intent::activity::{ActivityEvent, ActivityMetadata};

static TRACKING_ENABLED: AtomicBool = AtomicBool::new(true);
static TRACKING_INTERVAL_SECS: AtomicU64 = AtomicU64::new(DEFAULT_TRACKING_INTERVAL_SECS);
static TRACK_MEDIA_ENABLED: AtomicBool = AtomicBool::new(true);
static TRACK_BROWSER_ENABLED: AtomicBool = AtomicBool::new(false);
static EXCLUDED_APPS: Mutex<Vec<String>> = Mutex::new(Vec::new());

const DEFAULT_TRACKING_INTERVAL_SECS: u64 = 10;
const MIN_TRACKING_INTERVAL_SECS: u64 = 1;
const MAX_TRACKING_INTERVAL_SECS: u64 = 60;
const FOCUS_POLL_INTERVAL_MS: u64 = 200;
const MIN_RECORDED_DURATION_MS: i64 = 1;

#[derive(Clone)]
struct ActivitySession {
    window: ActiveWindow,
    start_ms: i64,
    last_seen_ms: i64,
    metadata: ActivityMetadata,
    metadata_last_updated_ms: i64,
}

pub fn start_tracking(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        initialize_tracking_from_settings(&app_handle);
        let mut session: Option<ActivitySession> = None;

        loop {
            let interval_secs = tracking_interval_secs();
            let metadata_refresh_ms = (interval_secs * 1000) as i64;
            let now_ms = chrono::Utc::now().timestamp_millis();

            if !TRACKING_ENABLED.load(Ordering::Relaxed) {
                if let Some(active) = session.take() {
                    if let Err(e) = finalize_and_store_activity(&app_handle, active, now_ms) {
                        println!("Failed to store activity while disabling tracking: {}", e);
                    }
                }
                tokio::time::sleep(Duration::from_millis(FOCUS_POLL_INTERVAL_MS)).await;
                continue;
            }

            match get_active_window() {
                Ok(Some(window)) => {
                    if let Some(ref mut active) = session {
                        let is_same_window = active.window.app_name == window.app_name
                            && active.window.title == window.title;

                        if is_same_window {
                            active.last_seen_ms = now_ms;
                            if now_ms - active.metadata_last_updated_ms >= metadata_refresh_ms {
                                let refreshed = capture_metadata().await;
                                merge_session_metadata(&mut active.metadata, refreshed);
                                active.metadata_last_updated_ms = now_ms;
                            }
                        } else {
                            let finished = active.clone();
                            if let Err(e) = finalize_and_store_activity(&app_handle, finished, now_ms) {
                                println!("Failed to store activity on focus change: {}", e);
                            }
                            session = Some(ActivitySession {
                                window,
                                start_ms: now_ms,
                                last_seen_ms: now_ms,
                                metadata: capture_metadata().await,
                                metadata_last_updated_ms: now_ms,
                            });
                        }
                    } else {
                        session = Some(ActivitySession {
                            window,
                            start_ms: now_ms,
                            last_seen_ms: now_ms,
                            metadata: capture_metadata().await,
                            metadata_last_updated_ms: now_ms,
                        });
                    }
                }
                Ok(None) => {
                    if let Some(active) = session.take() {
                        if let Err(e) = finalize_and_store_activity(&app_handle, active, now_ms) {
                            println!("Failed to store activity: {}", e);
                        }
                    }
                }
                Err(e) => {
                    println!("Failed to get active window: {}", e);
                }
            }

            tokio::time::sleep(Duration::from_millis(FOCUS_POLL_INTERVAL_MS)).await;
        }
    });
}
fn initialize_tracking_from_settings(app_handle: &AppHandle) {
    let conn = match crate::intent::db::open(app_handle) {
        Ok(c) => c,
        Err(_) => return,
    };

    if let Ok(mut stmt) = conn.prepare(
        "SELECT key, value FROM app_settings WHERE key IN ('track_apps','track_media','track_browser','excluded_apps')"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for (key, value) in rows.filter_map(|r| r.ok()) {
                match key.as_str() {
                    "track_apps" => set_tracking_enabled(value == "true"),
                    "track_media" => set_track_media_enabled(value == "true"),
                    "track_browser" => set_track_browser_enabled(value == "true"),
                    "excluded_apps" => set_excluded_apps(parse_excluded_apps(&value)),
                    _ => {}
                }
            }
        }
    };
}

fn parse_excluded_apps(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return vec![];
    }

    if let Ok(values) = serde_json::from_str::<Vec<String>>(raw) {
        return values
            .into_iter()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .collect();
    }

    raw.split(|c| c == ',' || c == '\n' || c == ';')
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}

fn clamp_tracking_interval(seconds: u64) -> u64 {
    seconds.clamp(MIN_TRACKING_INTERVAL_SECS, MAX_TRACKING_INTERVAL_SECS)
}

fn tracking_interval_secs() -> u64 {
    clamp_tracking_interval(TRACKING_INTERVAL_SECS.load(Ordering::Relaxed))
}

async fn capture_metadata() -> ActivityMetadata {
    let mut metadata = ActivityMetadata::default();
    metadata.screen_text = crate::intent::screen_capture::get_latest_screen_text();

    let bg_windows = crate::intent::windows_utils::get_open_windows();
    if !bg_windows.is_empty() {
        metadata.background_windows = Some(bg_windows);
    }

    if TRACK_MEDIA_ENABLED.load(Ordering::Relaxed) {
        metadata.media_info = match tokio::task::spawn_blocking(|| crate::intent::windows_utils::get_media_info()).await {
            Ok(info) => info,
            Err(e) => {
                println!("[Tracker] SMTC spawn_blocking failed: {:?}", e);
                None
            }
        };
    }

    metadata
}

fn merge_session_metadata(current: &mut ActivityMetadata, incoming: ActivityMetadata) {
    if incoming.screen_text.is_some() {
        current.screen_text = incoming.screen_text;
    }
    if incoming.background_windows.is_some() {
        current.background_windows = incoming.background_windows;
    }
    if incoming.media_info.is_some() {
        current.media_info = incoming.media_info;
    }
}

fn finalize_and_store_activity(
    app_handle: &AppHandle,
    session: ActivitySession,
    end_ms: i64,
) -> Result<(), String> {
    let duration_ms = (end_ms - session.start_ms).max(MIN_RECORDED_DURATION_MS);
    let duration_seconds = ((duration_ms + 999) / 1000) as i32;

    let start_time = session.start_ms / 1000;
    let end_time = start_time + duration_seconds as i64;

    let mut activity = ActivityEvent::new(
        session.window.app_name,
        session.window.title,
        session.window.category_id,
        start_time,
        end_time,
    );
    activity.duration_seconds = duration_seconds;
    activity.metadata = session.metadata;
    activity.metadata.raw_duration_ms = Some(duration_ms);

    store_activity(app_handle, &activity)
}

#[derive(Clone)]
struct ActiveWindow {
    app_name: String,
    title: String,
    category_id: i32,
}

fn get_active_window() -> Result<Option<ActiveWindow>, String> {
    // Use active-win-pos-rs to get the active window
    match active_win_pos_rs::get_active_window() {
        Ok(window) => {
            // Sanitize app_name - remove control characters and normalize
            let app_name = sanitize_app_name(&window.app_name);
            if is_app_excluded(&app_name) {
                return Ok(None);
            }

            let mut title = window.title;
            if !TRACK_BROWSER_ENABLED.load(Ordering::Relaxed) && is_browser_app(&app_name) {
                title = "Browser (metadata hidden)".to_string();
            }
            
            // Categorize the window
            let category_id = categorize_window(&app_name, &title);
            
            Ok(Some(ActiveWindow {
                app_name,
                title,
                category_id,
            }))
        }
        Err(_) => Ok(None),
    }
}

/// Sanitize app name by removing control characters and normalizing known apps
fn sanitize_app_name(name: &str) -> String {
    // Remove control characters (ASCII 0-31) and other non-printable chars
    let cleaned: String = name.chars()
        .filter(|c| c.is_ascii() && (*c as u8) >= 32 || !c.is_ascii())
        .collect();
    
    // Normalize known app names
    let cleaned_lower = cleaned.to_lowercase();
    
    // Spotify can appear as "Spotify8FileV" or similar with embedded chars
    if cleaned_lower.starts_with("spotify") || cleaned.contains("Spotify") {
        return "Spotify".to_string();
    }
    
    cleaned
}

fn categorize_window(app_name: &str, title: &str) -> i32 {
    let app_lower = app_name.to_lowercase();
    let title_lower = title.to_lowercase();
    
    // Development (category 1)
    if app_lower.contains("code") || 
       app_lower.contains("vscode") ||
       app_lower.contains("antigravity") ||
       app_lower.contains("cursor") ||
       app_lower.contains("idea") ||
       app_lower.contains("pycharm") ||
       app_lower.contains("webstorm") ||
       app_lower.contains("phpstorm") ||
       app_lower.contains("rider") ||
       app_lower.contains("clion") ||
       app_lower.contains("goland") ||
       app_lower.contains("android studio") ||
       app_lower.contains("eclipse") ||
       app_lower.contains("sublime") ||
       app_lower.contains("atom") ||
       app_lower.contains("vim") ||
       app_lower.contains("neovim") ||
       app_lower.contains("emacs") ||
       app_lower.contains("git") ||
       app_lower.contains("terminal") ||
       app_lower.contains("powershell") ||
       app_lower.contains("cmd") ||
       app_lower.contains("windowsterminal") ||
       app_lower.contains("wt") ||
       app_lower.contains("postman") ||
       app_lower.contains("insomnia") ||
       app_lower.contains("docker") ||
       title_lower.contains("visual studio") ||
       title_lower.contains("- antigravity") {
        return 1;
    }
    
    // Check title for code file extensions → Development
    let code_extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", 
                           ".java", ".cpp", ".c", ".cs", ".rb", ".php", ".vue",
                           ".svelte", ".html", ".css", ".scss", ".json", ".toml",
                           ".yaml", ".yml", ".md", ".sql"];
    for ext in code_extensions {
        if title_lower.contains(ext) {
            return 1;
        }
    }
    
    // Entertainment (category 4) — check TITLE first (before browser) so
    // Spotify/YouTube playing inside a browser gets tagged as Entertainment
    // Note: Spotify web shows playing tracks as "Song • Artist - Browser"
    if app_lower.contains("spotify") || 
       app_lower.contains("netflix") ||
       app_lower.contains("youtube") ||
       app_lower.contains("vlc") ||
       app_lower.contains("media player") ||
       title_lower.contains("spotify") ||
       title_lower.contains("youtube") ||
       title_lower.contains("netflix") ||
       title_lower.contains("twitch") ||
       title_lower.contains("soundcloud") ||
       title_lower.contains("apple music") ||
       title_lower.contains("liked songs") ||
       title_lower.contains("\u{2022}") {  // "•" bullet — Spotify uses "Song • Artist" format
        return 4;
    }
    
    // Browser (category 2) — only if title didn't match entertainment above
    if is_browser_app(&app_lower) {
        return 2;
    }
    
    // Communication (category 3)
    if app_lower.contains("slack") || 
       app_lower.contains("discord") ||
       app_lower.contains("teams") ||
       app_lower.contains("zoom") ||
       app_lower.contains("telegram") ||
       app_lower.contains("whatsapp") ||
       app_lower.contains("signal") ||
       app_lower.contains("skype") ||
       app_lower.contains("outlook") ||
       app_lower.contains("thunderbird") ||
       app_lower.contains("gmail") {
        return 3;
    }
    
    // Productivity (category 5)
    if app_lower.contains("notion") || 
       app_lower.contains("obsidian") ||
       app_lower.contains("todo") ||
       app_lower.contains("word") ||
       app_lower.contains("excel") ||
       app_lower.contains("powerpoint") ||
       app_lower.contains("onenote") ||
       app_lower.contains("notepad") ||
       app_lower.contains("figma") ||
       title_lower.contains("notion") ||
       title_lower.contains("google docs") ||
       title_lower.contains("google sheets") {
        return 5;
    }
    
    // System (category 6)
    if app_lower.contains("explorer") || 
       app_lower.contains("settings") ||
       app_lower.contains("task manager") ||
       app_lower.contains("control panel") ||
       app_lower.contains("systemsettings") {
        return 6;
    }
    
    // Other (category 7)
    7
}

fn store_activity(app_handle: &AppHandle, activity: &ActivityEvent) -> Result<(), String> {
    // Use db::open() to get a connection with all performance PRAGMAs applied
    let conn = crate::intent::db::open(app_handle)?;
    
    let metadata_blob = serde_json::to_vec(&activity.metadata).map_err(|e| e.to_string())?;
    
    conn.execute(
        "INSERT INTO activities 
         (app_name, app_hash, window_title, window_title_hash, category_id, 
          start_time, end_time, duration_seconds, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            &activity.app_name,
            activity.app_hash as i64,
            &activity.window_title,
            activity.window_title_hash as i64,
            activity.category_id,
            activity.start_time,
            activity.end_time,
            activity.duration_seconds,
            &metadata_blob,
        ],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn set_tracking_enabled(enabled: bool) {
    TRACKING_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn set_track_media_enabled(enabled: bool) {
    TRACK_MEDIA_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn set_track_browser_enabled(enabled: bool) {
    TRACK_BROWSER_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn set_excluded_apps(apps: Vec<String>) {
    if let Ok(mut list) = EXCLUDED_APPS.lock() {
        *list = apps
            .into_iter()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .collect();
    }
}

fn is_app_excluded(app_name: &str) -> bool {
    let app = app_name.to_lowercase();
    if let Ok(list) = EXCLUDED_APPS.lock() {
        return list.iter().any(|pattern| app == *pattern || app.contains(pattern));
    }
    false
}

fn is_browser_app(app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    lower.contains("chrome")
        || lower.contains("firefox")
        || lower.contains("edge")
        || lower.contains("brave")
        || lower.contains("opera")
        || lower.contains("vivaldi")
        || lower.contains("safari")
        || lower.contains("webview2")
        || lower.contains("msedgewebview")
}

pub fn is_tracking_enabled() -> bool {
    TRACKING_ENABLED.load(Ordering::Relaxed)
}

pub fn set_tracking_interval(seconds: u64) {
    TRACKING_INTERVAL_SECS.store(clamp_tracking_interval(seconds), Ordering::Relaxed);
}
