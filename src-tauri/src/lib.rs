mod intent;
mod models;
mod services;
mod utils;

use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use url::Url;

static GAME_MODE_ENABLED: AtomicBool = AtomicBool::new(false);
static INCOGNITO_ENABLED: AtomicBool = AtomicBool::new(false);
static INCOGNITO_UNTIL_TS: AtomicI64 = AtomicI64::new(0);

#[derive(Debug, Clone)]
struct RuntimeSettings {
    track_apps: bool,
    track_screen_ocr: bool,
    enable_startup: bool,
    startup_behavior: String,
    close_to_tray: bool,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            track_apps: true,
            track_screen_ocr: false,
            enable_startup: true,
            startup_behavior: "minimized_to_tray".to_string(),
            close_to_tray: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct TokenStore {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expiry_date: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct FileNode {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    children: Option<Vec<FileNode>>,
}

#[derive(Serialize)]
struct MutationResult {
    success: bool,
    path: Option<String>,
    #[serde(rename = "newPath")]
    new_path: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct CalendarEvent {
    id: String,
    title: String,
    start: String,
    end: String,
    description: String,
    #[serde(rename = "isGoogleEvent")]
    is_google_event: bool,
}

#[derive(Serialize)]
struct GoogleTask {
    id: String,
    title: String,
    notes: Option<String>,
    due: Option<String>,
    status: String,
    #[serde(rename = "webViewLink")]
    web_view_link: Option<String>,
}

#[derive(Serialize)]
struct IncognitoStatus {
    active: bool,
    #[serde(rename = "remainingSeconds")]
    remaining_seconds: i64,
}

fn app_data_tokens_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to read app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Unable to create app data dir: {e}"))?;
    dir.push("google_tokens.json");
    Ok(dir)
}

fn load_tokens(app: &tauri::AppHandle) -> Result<TokenStore, String> {
    let path = app_data_tokens_path(app)?;
    if !path.exists() {
        return Ok(TokenStore::default());
    }
    let data = fs::read_to_string(path).map_err(|e| format!("Unable to read token file: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Unable to parse token file: {e}"))
}

fn save_tokens(app: &tauri::AppHandle, tokens: &TokenStore) -> Result<(), String> {
    let path = app_data_tokens_path(app)?;
    let payload = serde_json::to_string_pretty(tokens).map_err(|e| format!("Unable to encode tokens: {e}"))?;
    fs::write(path, payload).map_err(|e| format!("Unable to persist tokens: {e}"))
}

fn delete_tokens(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app_data_tokens_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Unable to remove token file: {e}"))?;
    }
    Ok(())
}

fn google_client_credentials(app: &tauri::AppHandle) -> Result<(String, String), String> {
    if let Ok(conn) = intent::db::open(app) {
        let db_client_id: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'google_client_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        let db_client_secret: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'google_client_secret'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();

        if !db_client_id.trim().is_empty() && !db_client_secret.trim().is_empty() {
            return Ok((db_client_id, db_client_secret));
        }
    }

    dotenvy::dotenv().ok();
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .or_else(|_| std::env::var("VITE_GOOGLE_CLIENT_ID"))
        .map_err(|_| "Missing Google Client ID. Set it in Settings > API Keys or GOOGLE_CLIENT_ID env var.".to_string())?;
    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .or_else(|_| std::env::var("VITE_GOOGLE_CLIENT_SECRET"))
        .map_err(|_| "Missing Google Client Secret. Set it in Settings > API Keys or GOOGLE_CLIENT_SECRET env var.".to_string())?;
    Ok((client_id, client_secret))
}

fn configured_google_redirect_uri() -> Option<String> {
    dotenvy::dotenv().ok();
    std::env::var("GOOGLE_REDIRECT_URI")
        .or_else(|_| std::env::var("VITE_GOOGLE_REDIRECT_URI"))
        .ok()
}

fn parse_google_redirect_uri(redirect_uri: &str) -> Result<(String, String), String> {
    let parsed = Url::parse(&redirect_uri)
        .map_err(|e| format!("Invalid GOOGLE_REDIRECT_URI: {e}"))?;

    if parsed.scheme() != "http" {
        return Err("GOOGLE_REDIRECT_URI must use http for local OAuth callback".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "GOOGLE_REDIRECT_URI must include a host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "GOOGLE_REDIRECT_URI must include a valid port".to_string())?;

    let bind_host = if host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        host
    };

    Ok((redirect_uri.to_string(), format!("{}:{}", bind_host, port)))
}

fn default_google_redirect_uri_candidates() -> Vec<String> {
    vec![
        "http://127.0.0.1:3000/oauth2callback".to_string(),
        "http://localhost:3000/oauth2callback".to_string(),
    ]
}

async fn is_redirect_uri_mismatch(client_id: &str, redirect_uri: &str) -> Result<bool, String> {
    let mut auth_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| format!("Invalid auth url: {e}"))?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid");

    let probe_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build HTTP client for redirect probe: {e}"))?;

    let response = probe_client
        .get(auth_url.as_str())
        .send()
        .await
        .map_err(|e| format!("Redirect probe failed: {e}"))?;

    if response.status().as_u16() == 400 {
        let body = response.text().await.unwrap_or_default().to_lowercase();
        return Ok(body.contains("redirect_uri_mismatch"));
    }

    if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
        let loc = location.to_str().unwrap_or_default().to_lowercase();
        if loc.contains("redirect_uri_mismatch") {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn select_google_redirect_uri(client_id: &str) -> Result<(String, String), String> {
    if let Some(explicit) = configured_google_redirect_uri() {
        return parse_google_redirect_uri(&explicit);
    }

    let mut tried = Vec::new();
    let mut seen = HashSet::new();
    for candidate in default_google_redirect_uri_candidates() {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        tried.push(candidate.clone());
        let parsed = match parse_google_redirect_uri(&candidate) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match is_redirect_uri_mismatch(client_id, &candidate).await {
            Ok(false) => return Ok(parsed),
            Ok(true) => continue,
            Err(_) => {
                // On probe failure, keep old behavior and use first parsable candidate.
                return Ok(parsed);
            }
        }
    }

    Err(format!(
        "Google OAuth redirect URI mismatch. Register one of these URIs in Google Cloud Console and/or set GOOGLE_REDIRECT_URI explicitly: {}",
        tried.join(", ")
    ))
}

async fn refresh_access_token_if_needed(app: &tauri::AppHandle) -> Result<String, String> {
    let mut tokens = load_tokens(app)?;
    let now_ms = Utc::now().timestamp_millis();
    let has_valid_access = tokens
        .access_token
        .as_ref()
        .zip(tokens.expiry_date)
        .map(|(_, exp)| exp > now_ms + 60_000)
        .unwrap_or(false);

    if has_valid_access {
        return Ok(tokens.access_token.unwrap_or_default());
    }

    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "Not authenticated".to_string())?;
    let (client_id, client_secret) = google_client_credentials(app)?;
    let client = Client::new();
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Token refresh failed with status {}", response.status()));
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|e| format!("Token refresh decode failed: {e}"))?;
    let new_access = payload
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Token refresh response missing access_token".to_string())?
        .to_string();
    let expires_in = payload.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    tokens.access_token = Some(new_access.clone());
    tokens.expiry_date = Some(now_ms + expires_in * 1000);
    save_tokens(app, &tokens)?;

    Ok(new_access)
}

fn get_directory_tree(dir_path: &Path) -> Vec<FileNode> {
    get_directory_tree_inner(dir_path, 0, 10)
}

fn get_directory_tree_inner(dir_path: &Path, depth: usize, max_depth: usize) -> Vec<FileNode> {
    let mut items = Vec::new();
    if depth >= max_depth || !dir_path.exists() || !dir_path.is_dir() {
        return items;
    }

    let entries = match fs::read_dir(dir_path) {
        Ok(entries) => entries,
        Err(_) => return items,
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        if path.is_dir() {
            items.push(FileNode {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                is_directory: true,
                children: Some(get_directory_tree_inner(&path, depth + 1, max_depth)),
            });
        } else if name.ends_with(".md") {
            items.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: false,
                children: None,
            });
        }
    }
    items.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    items
}

#[tauri::command]
fn app_minimize_to_tray(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        Ok(true)
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
fn app_show_window(app: tauri::AppHandle) -> Result<bool, String> {
    show_window_and_navigate(&app, "dashboard");
    Ok(true)
}

#[tauri::command]
fn app_show_window_page(app: tauri::AppHandle, page: String) -> Result<bool, String> {
    show_window_and_navigate(&app, &page);
    Ok(true)
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) -> Result<bool, String> {
    app.exit(0);
    Ok(true)
}

#[tauri::command]
fn app_get_incognito_status() -> Result<IncognitoStatus, String> {
    let now = Utc::now().timestamp();
    let remaining = INCOGNITO_UNTIL_TS.load(Ordering::Relaxed) - now;
    let timed_active = remaining > 0;
    let active = INCOGNITO_ENABLED.load(Ordering::Relaxed) || timed_active;
    Ok(IncognitoStatus {
        active,
        remaining_seconds: if timed_active { remaining } else { 0 },
    })
}

#[tauri::command]
fn app_toggle_incognito(app: tauri::AppHandle) -> Result<IncognitoStatus, String> {
    let now = Utc::now().timestamp();
    let currently_active = INCOGNITO_ENABLED.load(Ordering::Relaxed)
        || INCOGNITO_UNTIL_TS.load(Ordering::Relaxed) > now;

    if currently_active {
        disable_incognito(&app);
    } else {
        INCOGNITO_ENABLED.store(true, Ordering::Relaxed);
        INCOGNITO_UNTIL_TS.store(0, Ordering::Relaxed);
        apply_monitoring_state(&app);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("tray:incognito-tick", json!({ "active": true, "remainingSeconds": 0 }));
        }
    }

    app_get_incognito_status()
}

#[tauri::command]
fn app_set_incognito_for(app: tauri::AppHandle, minutes: i64) -> Result<IncognitoStatus, String> {
    if minutes <= 0 {
        disable_incognito(&app);
    } else {
        set_incognito_for(&app, minutes);
    }
    app_get_incognito_status()
}

#[tauri::command]
fn app_get_game_mode() -> Result<bool, String> {
    Ok(GAME_MODE_ENABLED.load(Ordering::Relaxed))
}

#[tauri::command]
fn app_toggle_game_mode(app: tauri::AppHandle) -> Result<bool, String> {
    let next = !GAME_MODE_ENABLED.load(Ordering::Relaxed);
    GAME_MODE_ENABLED.store(next, Ordering::Relaxed);
    apply_monitoring_state(&app);
    Ok(next)
}

#[tauri::command]
fn app_refresh_ai(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("tray:refresh-ai", true);
    }
    Ok(true)
}

#[tauri::command]
fn app_clear_notifications(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("tray:clear-notifications", true);
    }
    Ok(true)
}

#[tauri::command]
fn app_music_control(app: tauri::AppHandle, action: String) -> Result<bool, String> {
    let normalized = action.to_lowercase();
    let mapped = match normalized.as_str() {
        "play_pause" | "playpause" | "toggle" => "play_pause",
        "next" => "next",
        "prev" | "previous" => "prev",
        _ => return Err(format!("Unsupported music action: {action}")),
    };
    emit_music_control(&app, mapped);
    Ok(true)
}

#[tauri::command]
fn app_music_playlist_select(app: tauri::AppHandle, playlist_id: i64) -> Result<bool, String> {
    if playlist_id <= 0 {
        return Err("Invalid playlist id".to_string());
    }

    if let Some(window) = app.get_webview_window("main") {
        let payload = json!({
            "playlistId": playlist_id
        });
        let _ = window.emit("tray:music-playlist-select", payload);
        Ok(true)
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
fn app_timer_control(
    app: tauri::AppHandle,
    action: String,
    minutes: Option<i64>,
) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let payload = json!({
            "action": action,
            "minutes": minutes
        });
        let _ = window.emit("tray:timer-control", payload);
        Ok(true)
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
fn app_toggle_tray_panel(app: tauri::AppHandle) -> Result<bool, String> {
    toggle_tray_panel(&app);
    Ok(true)
}

fn show_window_and_navigate(app_handle: &tauri::AppHandle, page: &str) {
    if let Some(panel) = app_handle.get_webview_window("tray_panel") {
        let _ = panel.hide();
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("tray:navigate", page.to_string());
    }
}

fn read_runtime_settings(app_handle: &tauri::AppHandle) -> RuntimeSettings {
    let conn = match intent::db::open(app_handle) {
        Ok(c) => c,
        Err(_) => return RuntimeSettings::default(),
    };

    // Batch all settings into a single query
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT key, value FROM app_settings WHERE key IN ('track_apps','track_screen_ocr','enable_startup','startup_behavior','close_to_tray')"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.filter_map(|r| r.ok()) {
                map.insert(row.0, row.1);
            }
        }
    }

    RuntimeSettings {
        track_apps: map.get("track_apps").map(|v| v == "true").unwrap_or(true),
        track_screen_ocr: map.get("track_screen_ocr").map(|v| v == "true").unwrap_or(false),
        enable_startup: map.get("enable_startup").map(|v| v == "true").unwrap_or(true),
        startup_behavior: map.get("startup_behavior").cloned().unwrap_or_else(|| "minimized_to_tray".to_string()),
        close_to_tray: map.get("close_to_tray").map(|v| v == "true").unwrap_or(true),
    }
}

fn apply_monitoring_state(app_handle: &tauri::AppHandle) {
    let settings = read_runtime_settings(app_handle);
    let now = Utc::now().timestamp();
    let incognito_active = INCOGNITO_ENABLED.load(Ordering::Relaxed)
        || INCOGNITO_UNTIL_TS.load(Ordering::Relaxed) > now;

    let tracking_enabled = settings.track_apps
        && !GAME_MODE_ENABLED.load(Ordering::Relaxed)
        && !incognito_active;

    let ocr_enabled = settings.track_screen_ocr
        && !GAME_MODE_ENABLED.load(Ordering::Relaxed)
        && !incognito_active;

    intent::activity_tracker::set_tracking_enabled(tracking_enabled);
    intent::screen_capture::set_capture_enabled(ocr_enabled);
    intent::file_monitor::set_monitor_enabled(tracking_enabled);
}

pub(crate) fn refresh_monitoring_state(app_handle: &tauri::AppHandle) {
    apply_monitoring_state(app_handle);
}

fn disable_incognito(app_handle: &tauri::AppHandle) {
    INCOGNITO_ENABLED.store(false, Ordering::Relaxed);
    INCOGNITO_UNTIL_TS.store(0, Ordering::Relaxed);
    apply_monitoring_state(app_handle);
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("tray:incognito-tick", json!({ "active": false, "remainingSeconds": 0 }));
    }
}

fn set_incognito_for(app_handle: &tauri::AppHandle, minutes: i64) {
    let until = Utc::now().timestamp() + (minutes * 60);
    INCOGNITO_ENABLED.store(true, Ordering::Relaxed);
    INCOGNITO_UNTIL_TS.store(until, Ordering::Relaxed);
    apply_monitoring_state(app_handle);
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("tray:incognito-tick", json!({ "active": true, "remainingSeconds": minutes * 60 }));
    }

    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if !INCOGNITO_ENABLED.load(Ordering::Relaxed) {
                break;
            }
            let now = Utc::now().timestamp();
            let remaining = INCOGNITO_UNTIL_TS.load(Ordering::Relaxed) - now;
            if remaining <= 0 {
                disable_incognito(&handle);
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.emit("tray:incognito-expired", true);
                }
                break;
            }
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.emit(
                    "tray:incognito-tick",
                    json!({ "active": true, "remainingSeconds": remaining }),
                );
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

fn apply_startup_behavior(app_handle: &tauri::AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let is_autostart = args.iter().any(|arg| arg == "--autostart");
    let settings = read_runtime_settings(app_handle);

    if is_autostart && settings.enable_startup {
        let behavior = settings.startup_behavior.to_lowercase();
        if behavior == "minimized_to_tray" || behavior == "hidden" {
            return;
        }
    }

    if let Some(window) = app_handle.get_webview_window("main") {
        if matches!(window.is_visible(), Ok(true)) {
            return;
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn should_close_to_tray(app_handle: &tauri::AppHandle) -> bool {
    read_runtime_settings(app_handle).close_to_tray
}

fn emit_music_control(app: &tauri::AppHandle, action: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("tray:music-control", action);
    }
}

fn position_tray_panel(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let panel_width: i32 = 420;
        let panel_height: i32 = 560;
        let x = monitor_pos.x + monitor_size.width as i32 - panel_width - 16;
        let y = monitor_pos.y + monitor_size.height as i32 - panel_height - 56;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn toggle_tray_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("tray_panel") {
        if matches!(window.is_visible(), Ok(true)) {
            let _ = window.hide();
            return;
        }
        position_tray_panel(app, &window);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let panel = match WebviewWindowBuilder::new(
        app,
        "tray_panel",
        WebviewUrl::App("index.html?window=tray".into()),
    )
    .title("NEXUS Control Center")
    .inner_size(420.0, 560.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    {
        Ok(window) => window,
        Err(err) => {
            if err.to_string().contains("already exists") {
                if let Some(window) = app.get_webview_window("tray_panel") {
                    position_tray_panel(app, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                    return;
                }
                if let Some(window) = app.get_window("tray_panel") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    return;
                }
            }
            eprintln!("[tray_panel] Failed to create tray panel window: {err}");
            return;
        }
    };

    position_tray_panel(app, &panel);
    let _ = panel.show();
    let _ = panel.set_focus();
}

fn register_global_media_shortcuts(app: &tauri::AppHandle) {
    let shortcuts = [
        Shortcut::new(None, Code::MediaPlayPause),
        Shortcut::new(None, Code::MediaTrackNext),
        Shortcut::new(None, Code::MediaTrackPrevious),
    ];

    for shortcut in shortcuts {
        if let Err(err) = app.global_shortcut().register(shortcut) {
            eprintln!("[shortcuts] Failed to register global shortcut: {err}");
        }
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let launch_item = MenuItem::with_id(app, "launch_app", "Launch App", true, None::<&str>)?;
    let open_control_center_item = MenuItem::with_id(app, "open_control_center", "Open Control Center", true, None::<&str>)?;
    let open_dashboard_item = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let open_diary_item = MenuItem::with_id(app, "open_diary", "Open Diary", true, None::<&str>)?;
    let open_chat_item = MenuItem::with_id(app, "open_chat", "Open Chat", true, None::<&str>)?;
    let open_code_item = MenuItem::with_id(app, "open_code", "Open Code", true, None::<&str>)?;
    let open_music_item = MenuItem::with_id(app, "open_music", "Open Music", true, None::<&str>)?;
    let refresh_ai_item = MenuItem::with_id(app, "refresh_ai", "Refresh AI Updates", true, None::<&str>)?;
    let clear_notifications_item = MenuItem::with_id(app, "clear_notifications", "Clear Notifications", true, None::<&str>)?;
    let music_play_pause_item = MenuItem::with_id(app, "music_play_pause", "Music: Play/Pause", true, None::<&str>)?;
    let music_prev_item = MenuItem::with_id(app, "music_prev", "Music: Previous", true, None::<&str>)?;
    let music_next_item = MenuItem::with_id(app, "music_next", "Music: Next", true, None::<&str>)?;
    let game_mode_item = MenuItem::with_id(app, "toggle_game_mode", "Game Mode: OFF", true, None::<&str>)?;
    let incognito_item = MenuItem::with_id(app, "toggle_incognito", "Incognito: OFF", true, None::<&str>)?;
    let incognito_15_item = MenuItem::with_id(app, "incognito_15m", "Incognito 15m", true, None::<&str>)?;
    let incognito_30_item = MenuItem::with_id(app, "incognito_30m", "Incognito 30m", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &launch_item,
            &open_control_center_item,
            &open_dashboard_item,
            &open_diary_item,
            &open_chat_item,
            &open_code_item,
            &open_music_item,
            &refresh_ai_item,
            &clear_notifications_item,
            &PredefinedMenuItem::separator(app)?,
            &music_play_pause_item,
            &music_prev_item,
            &music_next_item,
            &PredefinedMenuItem::separator(app)?,
            &game_mode_item,
            &incognito_item,
            &incognito_15_item,
            &incognito_30_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let game_mode_item_handle = game_mode_item.clone();
    let incognito_item_handle = incognito_item.clone();

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "launch_app" => show_window_and_navigate(app, "dashboard"),
                "open_control_center" => toggle_tray_panel(app),
                "open_dashboard" => show_window_and_navigate(app, "dashboard"),
                "open_diary" => show_window_and_navigate(app, "diary"),
                "open_chat" => show_window_and_navigate(app, "chat"),
                "open_code" => show_window_and_navigate(app, "code"),
                "open_music" => show_window_and_navigate(app, "music"),
                "refresh_ai" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("tray:refresh-ai", true);
                    }
                }
                "clear_notifications" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("tray:clear-notifications", true);
                    }
                }
                "music_play_pause" => {
                    emit_music_control(app, "play_pause");
                }
                "music_prev" => {
                    emit_music_control(app, "prev");
                }
                "music_next" => {
                    emit_music_control(app, "next");
                }
                "toggle_game_mode" => {
                    let next = !GAME_MODE_ENABLED.load(Ordering::Relaxed);
                    GAME_MODE_ENABLED.store(next, Ordering::Relaxed);
                    let _ = game_mode_item_handle.set_text(if next { "Game Mode: ON" } else { "Game Mode: OFF" });
                    apply_monitoring_state(app);
                }
                "toggle_incognito" => {
                    let now = Utc::now().timestamp();
                    let currently_active = INCOGNITO_ENABLED.load(Ordering::Relaxed)
                        || INCOGNITO_UNTIL_TS.load(Ordering::Relaxed) > now;
                    if currently_active {
                        disable_incognito(app);
                        let _ = incognito_item_handle.set_text("Incognito: OFF");
                    } else {
                        INCOGNITO_ENABLED.store(true, Ordering::Relaxed);
                        INCOGNITO_UNTIL_TS.store(0, Ordering::Relaxed);
                        apply_monitoring_state(app);
                        let _ = incognito_item_handle.set_text("Incognito: ON");
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("tray:incognito-tick", json!({ "active": true, "remainingSeconds": 0 }));
                        }
                    }
                }
                "incognito_15m" => {
                    set_incognito_for(app, 15);
                    let _ = incognito_item_handle.set_text("Incognito: ON (15m)");
                }
                "incognito_30m" => {
                    set_incognito_for(app, 30);
                    let _ = incognito_item_handle.set_text("Incognito: ON (30m)");
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_tray_panel(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    Ok(())
}

fn mutation_ok(path: Option<String>, new_path: Option<String>) -> MutationResult {
    MutationResult {
        success: true,
        path,
        new_path,
        error: None,
    }
}

fn mutation_err(message: impl Into<String>) -> MutationResult {
    MutationResult {
        success: false,
        path: None,
        new_path: None,
        error: Some(message.into()),
    }
}

/// Validate that a path is within an expected vault directory to prevent path traversal.
/// Returns the canonicalized path on success.
fn validate_notes_path(file_path: &str, vault_path: Option<&str>) -> Result<PathBuf, String> {
    let target = std::fs::canonicalize(file_path)
        .or_else(|_| {
            // If file doesn't exist yet, canonicalize the parent
            let p = PathBuf::from(file_path);
            if let Some(parent) = p.parent() {
                std::fs::canonicalize(parent).map(|cp| cp.join(p.file_name().unwrap_or_default()))
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "invalid path"))
            }
        })
        .map_err(|e| format!("Invalid path: {e}"))?;

    // If a vault path is provided, ensure the target is within it
    if let Some(vault) = vault_path {
        let vault_canon = std::fs::canonicalize(vault)
            .map_err(|e| format!("Invalid vault path: {e}"))?;
        if !target.starts_with(&vault_canon) {
            return Err("Access denied: path is outside the vault directory".to_string());
        }
    }

    // Additional safety: reject paths containing suspicious components
    let path_str = target.to_string_lossy();
    if path_str.contains("..") {
        return Err("Access denied: path traversal detected".to_string());
    }

    Ok(target)
}

#[tauri::command]
async fn notes_get_file_tree(vault_path: String) -> Result<Vec<FileNode>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(get_directory_tree(Path::new(&vault_path)))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_read_file(file_path: String) -> Result<Option<String>, String> {
    validate_notes_path(&file_path, None)?;
    tokio::task::spawn_blocking(move || {
        Ok(fs::read_to_string(file_path).ok())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_write_file(file_path: String, content: String) -> Result<bool, String> {
    validate_notes_path(&file_path, None)?;
    tokio::task::spawn_blocking(move || {
        Ok(fs::write(file_path, content).is_ok())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn notes_create_file(dir_path: String, file_name: String) -> MutationResult {
    let mut file_path = PathBuf::from(dir_path);
    let normalized = if file_name.ends_with(".md") {
        file_name
    } else {
        format!("{file_name}.md")
    };
    file_path.push(&normalized);
    if file_path.exists() {
        return mutation_err("File already exists");
    }
    let heading = normalized.trim_end_matches(".md");
    match fs::write(&file_path, format!("# {heading}\n\n")) {
        Ok(_) => mutation_ok(Some(file_path.to_string_lossy().to_string()), None),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn notes_create_folder(dir_path: String, folder_name: String) -> MutationResult {
    let mut folder_path = PathBuf::from(dir_path);
    folder_path.push(folder_name);
    if folder_path.exists() {
        return mutation_err("Folder already exists");
    }
    match fs::create_dir(&folder_path) {
        Ok(_) => mutation_ok(Some(folder_path.to_string_lossy().to_string()), None),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn notes_ensure_dir(dir_path: String) -> MutationResult {
    match fs::create_dir_all(&dir_path) {
        Ok(_) => mutation_ok(None, None),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn notes_delete(item_path: String) -> MutationResult {
    if let Err(e) = validate_notes_path(&item_path, None) {
        return mutation_err(e);
    }
    let path = PathBuf::from(item_path);
    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(_) => mutation_ok(None, None),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn notes_rename(old_path: String, new_name: String) -> MutationResult {
    if let Err(e) = validate_notes_path(&old_path, None) {
        return mutation_err(e);
    }
    // Reject new names with path separators to prevent traversal
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return mutation_err("Invalid file name");
    }
    let old = PathBuf::from(&old_path);
    let Some(parent) = old.parent() else {
        return mutation_err("Invalid source path");
    };
    let new_path = parent.join(new_name);
    match fs::rename(&old, &new_path) {
        Ok(_) => mutation_ok(None, Some(new_path.to_string_lossy().to_string())),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn notes_move_file(source_path: String, destination_path: String) -> MutationResult {
    if let Err(e) = validate_notes_path(&source_path, None) {
        return mutation_err(e);
    }
    if let Err(e) = validate_notes_path(&destination_path, None) {
        return mutation_err(e);
    }
    let source = PathBuf::from(&source_path);
    let destination = PathBuf::from(&destination_path);
    if destination.starts_with(&source) {
        return mutation_err("Cannot move a folder into itself");
    }
    let Some(file_name) = source.file_name() else {
        return mutation_err("Invalid source path");
    };
    let new_path = destination.join(file_name);
    if new_path.exists() {
        return mutation_err("Destination already exists");
    }
    match fs::rename(&source, &new_path) {
        Ok(_) => mutation_ok(None, Some(new_path.to_string_lossy().to_string())),
        Err(e) => mutation_err(e.to_string()),
    }
}

#[tauri::command]
fn leetcode_read_csv(app: tauri::AppHandle) -> Option<String> {
    let mut candidates = Vec::<PathBuf>::new();

    // Walk up from current_dir until we find the file (handles dev mode where
    // current_dir == src-tauri/ but file is in project root)
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            let candidate = dir.join("leetcode_problems.csv");
            candidates.push(candidate);
            if !dir.pop() { break; }
        }
    }

    // Tauri resource path (production)
    if let Ok(resource) = app.path().resolve("leetcode_problems.csv", tauri::path::BaseDirectory::Resource) {
        candidates.push(resource);
    }

    // Installed app fallback: look next to the executable and a few parent dirs.
    // This covers installer layouts where the CSV is shipped externally.
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(mut dir) = exe_path.parent().map(Path::to_path_buf) {
            for _ in 0..4 {
                candidates.push(dir.join("leetcode_problems.csv"));
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    // App data dir (user-copied file)
    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("leetcode_problems.csv"));
    }

    for path in candidates {
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                return Some(data);
            }
        }
    }
    None
}


#[tauri::command]
fn google_check_auth(app: tauri::AppHandle) -> bool {
    load_tokens(&app)
        .ok()
        .and_then(|t| t.refresh_token)
        .is_some()
}

#[tauri::command]
async fn google_sign_in(app: tauri::AppHandle) -> Result<bool, String> {
    let (client_id, client_secret) = google_client_credentials(&app)?;
    let (redirect_uri, callback_bind_addr) = select_google_redirect_uri(&client_id).await?;
    let redirect_url = Url::parse(&redirect_uri).map_err(|e| format!("Invalid redirect URI: {e}"))?;
    let host = redirect_url
        .host_str()
        .ok_or_else(|| "Redirect URI host is missing".to_string())?;
    let port = redirect_url
        .port_or_known_default()
        .ok_or_else(|| "Redirect URI port is missing".to_string())?;
    let callback_origin = format!("{}://{}:{}", redirect_url.scheme(), host, port);

    let mut auth_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| format!("Invalid auth url: {e}"))?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks",
        )
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    let listener = TcpListener::bind(&callback_bind_addr)
        .await
        .map_err(|e| format!("Unable to listen on OAuth callback port: {e}"))?;
    open::that(auth_url.as_str()).map_err(|e| format!("Unable to open browser: {e}"))?;
    let accept_result = timeout(Duration::from_secs(240), listener.accept())
        .await
        .map_err(|_| "Timed out waiting for OAuth callback".to_string())?
        .map_err(|e| format!("OAuth callback failed: {e}"))?;
    let (mut socket, _) = accept_result;
    let mut buf = vec![0_u8; 4096];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read OAuth callback: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();
    let first_line = request.lines().next().unwrap_or_default();
    let path = first_line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split(" HTTP/").next())
        .unwrap_or("/");
    let callback_url = format!("{callback_origin}{path}");
    let parsed = Url::parse(&callback_url).map_err(|e| format!("Invalid callback URL: {e}"))?;
    let code = parsed
        .query_pairs()
        .find_map(|(k, v)| if k == "code" { Some(v.to_string()) } else { None })
        .ok_or_else(|| "OAuth callback missing code".to_string())?;

    let response_body = "Authentication successful. You can return to NEXUS OS.";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    let client = Client::new();
    let token_response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("OAuth token request failed: {e}"))?;
    if !token_response.status().is_success() {
        return Err(format!(
            "OAuth token exchange failed with status {}",
            token_response.status()
        ));
    }
    let payload: Value = token_response
        .json()
        .await
        .map_err(|e| format!("OAuth token decode failed: {e}"))?;
    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "OAuth response missing access token".to_string())?
        .to_string();
    let refresh_token = payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| "OAuth response missing refresh token".to_string())?;
    let expires_in = payload.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);

    let tokens = TokenStore {
        access_token: Some(access_token),
        refresh_token: Some(refresh_token),
        expiry_date: Some(Utc::now().timestamp_millis() + expires_in * 1000),
    };
    save_tokens(&app, &tokens)?;
    Ok(true)
}

#[tauri::command]
async fn google_sign_out(app: tauri::AppHandle) -> Result<bool, String> {
    let tokens = load_tokens(&app)?;
    if let Some(access_token) = tokens.access_token {
        let _ = Client::new()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", access_token)])
            .send()
            .await;
    }
    delete_tokens(&app)?;
    Ok(true)
}

async fn google_api_get(app: &tauri::AppHandle, url: &str) -> Result<Value, String> {
    let token = refresh_access_token_if_needed(app).await?;
    let response = Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Google GET request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let details = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google GET failed with status {status}: {details}"
        ));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Google GET decode failed: {e}"))
}

async fn google_api_with_body(
    app: &tauri::AppHandle,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = refresh_access_token_if_needed(app).await?;
    let client = Client::new();
    let mut req = client.request(method, url).bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("Google API request failed: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let details = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google API failed with status {status}: {details}"
        ));
    }
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(json!({}));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Google API decode failed: {e}"))
}

#[tauri::command]
async fn google_list_events(app: tauri::AppHandle, time_min: String, time_max: String) -> Result<Vec<CalendarEvent>, String> {
    let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .map_err(|e| format!("Invalid calendar URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("timeMin", &time_min)
        .append_pair("timeMax", &time_max)
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime");
    let payload = google_api_get(&app, url.as_str()).await?;
    let events = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mapped = events
        .into_iter()
        .filter_map(|event| {
            let id = event.get("id").and_then(Value::as_str)?.to_string();
            let start = event
                .get("start")
                .and_then(|s| s.get("dateTime").or_else(|| s.get("date")))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if start.is_empty() {
                return None;
            }
            Some(CalendarEvent {
                id,
                title: event
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("No Title")
                    .to_string(),
                start,
                end: event
                    .get("end")
                    .and_then(|e| e.get("dateTime").or_else(|| e.get("date")))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: event
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                is_google_event: true,
            })
        })
        .collect();
    Ok(mapped)
}

#[tauri::command]
async fn google_add_event(app: tauri::AppHandle, event: Value) -> Result<String, String> {
    let body = json!({
        "summary": event.get("title").and_then(Value::as_str).unwrap_or("No title"),
        "description": event.get("description").and_then(Value::as_str).unwrap_or(""),
        "start": { "dateTime": event.get("start").and_then(Value::as_str).unwrap_or_default() },
        "end": { "dateTime": event.get("end").and_then(Value::as_str).unwrap_or_default() }
    });
    let payload = google_api_with_body(
        &app,
        reqwest::Method::POST,
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        Some(body),
    )
    .await?;
    Ok(payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

#[tauri::command]
async fn google_update_event(app: tauri::AppHandle, id: String, event: Value) -> Result<bool, String> {
    let body = json!({
        "summary": event.get("title").and_then(Value::as_str).unwrap_or("No title"),
        "description": event.get("description").and_then(Value::as_str).unwrap_or(""),
        "start": { "dateTime": event.get("start").and_then(Value::as_str).unwrap_or_default() },
        "end": { "dateTime": event.get("end").and_then(Value::as_str).unwrap_or_default() }
    });
    let endpoint = format!(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/{}",
        id
    );
    let _ = google_api_with_body(&app, reqwest::Method::PUT, &endpoint, Some(body)).await?;
    Ok(true)
}

#[tauri::command]
async fn google_delete_event(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let endpoint = format!(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/{}",
        id
    );
    let _ = google_api_with_body(&app, reqwest::Method::DELETE, &endpoint, None).await?;
    Ok(true)
}

#[tauri::command]
async fn google_tasks_get_lists(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let payload = google_api_get(&app, "https://www.googleapis.com/tasks/v1/users/@me/lists").await?;
    let lists = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(lists)
}

#[tauri::command]
async fn google_tasks_list(app: tauri::AppHandle, tasklist_id: Option<String>) -> Result<Vec<GoogleTask>, String> {
    let list_id = tasklist_id.unwrap_or_else(|| "@default".to_string());
    let endpoint = format!(
        "https://www.googleapis.com/tasks/v1/lists/{}/tasks?showCompleted=true&showHidden=true",
        list_id
    );
    let payload = google_api_get(&app, &endpoint).await?;
    let tasks = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mapped = tasks
        .into_iter()
        .filter_map(|task| {
            Some(GoogleTask {
                id: task.get("id").and_then(Value::as_str)?.to_string(),
                title: task
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("No Title")
                    .to_string(),
                notes: task.get("notes").and_then(Value::as_str).map(str::to_string),
                due: task.get("due").and_then(Value::as_str).map(str::to_string),
                status: task
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("needsAction")
                    .to_string(),
                web_view_link: task
                    .get("webViewLink")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    Ok(mapped)
}

#[tauri::command]
async fn google_tasks_add(app: tauri::AppHandle, tasklist_id: Option<String>, task_data: Value) -> Result<String, String> {
    let list_id = tasklist_id.unwrap_or_else(|| "@default".to_string());
    let due = task_data
        .get("due")
        .and_then(Value::as_str)
        .map(|d| if d.contains('T') { d.to_string() } else { format!("{d}T00:00:00.000Z") });
    let body = json!({
        "title": task_data.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
        "notes": task_data.get("notes").and_then(Value::as_str).unwrap_or(""),
        "due": due
    });
    let endpoint = format!("https://www.googleapis.com/tasks/v1/lists/{}/tasks", list_id);
    let payload = google_api_with_body(&app, reqwest::Method::POST, &endpoint, Some(body)).await?;
    Ok(payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

#[tauri::command]
async fn google_tasks_update(
    app: tauri::AppHandle,
    tasklist_id: Option<String>,
    task_id: String,
    task: Value,
) -> Result<bool, String> {
    let list_id = tasklist_id.unwrap_or_else(|| "@default".to_string());
    let due = task
        .get("due")
        .and_then(Value::as_str)
        .map(|d| if d.contains('T') { d.to_string() } else { format!("{d}T00:00:00.000Z") });
    let body = json!({
        "title": task.get("title").and_then(Value::as_str),
        "notes": task.get("notes").and_then(Value::as_str),
        "due": due,
        "status": task.get("status").and_then(Value::as_str)
    });
    let endpoint = format!(
        "https://www.googleapis.com/tasks/v1/lists/{}/tasks/{}",
        list_id, task_id
    );
    let _ = google_api_with_body(&app, reqwest::Method::PATCH, &endpoint, Some(body)).await?;
    Ok(true)
}

#[tauri::command]
async fn google_tasks_delete(app: tauri::AppHandle, tasklist_id: Option<String>, task_id: String) -> Result<bool, String> {
    let list_id = tasklist_id.unwrap_or_else(|| "@default".to_string());
    let endpoint = format!(
        "https://www.googleapis.com/tasks/v1/lists/{}/tasks/{}",
        list_id, task_id
    );
    let _ = google_api_with_body(&app, reqwest::Method::DELETE, &endpoint, None).await?;
    Ok(true)
}


#[derive(Serialize, Deserialize, Clone)]
struct MusicTrack {
    id: String,
    title: String,
    thumbnail: String,
}

fn playlists_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to read app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Unable to create app data dir: {e}"))?;
    dir.push("playlists.json");
    Ok(dir)
}

#[tauri::command]
async fn music_search(query: String) -> Result<Vec<MusicTrack>, String> {
    let body = serde_json::json!({
        "query": query,
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20241101.01.00",
                "hl": "en",
                "gl": "US"
            }
        }
    });

    let response = Client::new()
        .post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube search request failed: {e}"))?;

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("YouTube search decode failed: {e}"))?;

    let mut tracks: Vec<MusicTrack> = Vec::new();
    let contents = json
        .pointer("/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    'outer: for section in &contents {
        let items = section
            .pointer("/itemSectionRenderer/contents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in &items {
            if let Some(v) = item.get("videoRenderer") {
                let video_id = match v.get("videoId").and_then(Value::as_str) {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let title = v
                    .pointer("/title/runs/0/text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut thumbnail = format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg");
                if let Some(thumbs) = v.pointer("/thumbnail/thumbnails").and_then(Value::as_array) {
                    if let Some(last_thumb) = thumbs.last() {
                        if let Some(url) = last_thumb.get("url").and_then(Value::as_str) {
                            thumbnail = url.to_string();
                        }
                    }
                }
                
                tracks.push(MusicTrack { id: video_id, title, thumbnail });
                if tracks.len() >= 20 {
                    break 'outer;
                }
            }
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn music_get_playlists(app: tauri::AppHandle) -> Result<Value, String> {
    let path = playlists_path(&app)?;
    if !path.exists() {
        // Try to find playlists.json in the working directory as fallback
        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("playlists.json");
            if cwd_path.exists() {
                let data = fs::read_to_string(&cwd_path)
                    .map_err(|e| format!("Failed to read playlists: {e}"))?;
                return serde_json::from_str(&data)
                    .map_err(|e| format!("Failed to parse playlists: {e}"));
            }
        }
        return Ok(json!([]));
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read playlists: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse playlists: {e}"))
}

#[tauri::command]
fn music_save_playlists(app: tauri::AppHandle, playlists: Value) -> Result<bool, String> {
    let path = playlists_path(&app)?;
    let data = serde_json::to_string_pretty(&playlists)
        .map_err(|e| format!("Failed to serialize playlists: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write playlists: {e}"))?;
    Ok(true)
}

fn library_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to read app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Unable to create app data dir: {e}"))?;
    dir.push("music_library.json");
    Ok(dir)
}

#[tauri::command]
fn music_get_library(app: tauri::AppHandle) -> Result<Value, String> {
    let path = library_path(&app)?;
    if !path.exists() {
        return Ok(json!({ "likedSongs": [], "recentlyPlayed": [] }));
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read music library: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse music library: {e}"))
}

#[tauri::command]
fn music_save_library(app: tauri::AppHandle, library: Value) -> Result<bool, String> {
    let path = library_path(&app)?;
    let data = serde_json::to_string_pretty(&library)
        .map_err(|e| format!("Failed to serialize music library: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write music library: {e}"))?;
    Ok(true)
}

#[tauri::command]
fn browser_open_in_app(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let label = format!("browser-{}", Utc::now().timestamp_millis());

    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title("NEXUS Browser")
        .inner_size(1280.0, 820.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to open in-app browser: {e}"))?;

    Ok(true)
}

#[tauri::command]
async fn browser_create_child(
    app: tauri::AppHandle,
    window: tauri::Window,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;

    if let Some(webview) = app.get_webview("embedded-browser") {
        webview
            .navigate(parsed)
            .map_err(|e| format!("Failed to navigate webview: {e}"))?;
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| format!("Failed to set webview position: {e}"))?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to set webview size: {e}"))?;
        return Ok(true);
    }

    let webview_builder = tauri::WebviewBuilder::new("embedded-browser", WebviewUrl::External(parsed));

    let webview = window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create child webview: {e}"))?;

    webview
        .set_auto_resize(false)
        .map_err(|e| format!("Failed to disable webview auto-resize: {e}"))?;

    Ok(true)
}

#[tauri::command]
async fn browser_update_child_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    if let Some(webview) = app.get_webview("embedded-browser") {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| format!("Failed to set position: {e}"))?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to set size: {e}"))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn browser_close_child(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(webview) = app.get_webview("embedded-browser") {
        webview.close().map_err(|e| format!("Failed to close child webview: {e}"))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn run() {
    let media_play_pause = Shortcut::new(None, Code::MediaPlayPause);
    let media_next = Shortcut::new(None, Code::MediaTrackNext);
    let media_prev = Shortcut::new(None, Code::MediaTrackPrevious);

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if *shortcut == media_play_pause {
                            emit_music_control(app, "play_pause");
                        } else if *shortcut == media_next {
                            emit_music_control(app, "next");
                        } else if *shortcut == media_prev {
                            emit_music_control(app, "prev");
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialise intent database on first run
            if let Err(e) = intent::db::init(app.handle()) {
                eprintln!("[intent] DB init failed: {e}");
            }
            // Run maintenance: data retention cleanup, storage limits, PRAGMA optimize
            intent::storage::run_startup_maintenance(app.handle());
            
            let handle = app.handle().clone();
            intent::screen_capture::start_screen_capture(handle.clone());
            intent::activity_tracker::start_tracking(handle.clone());
            intent::file_monitor::start_file_monitor(handle);

            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            {
                let settings = read_runtime_settings(&app.handle().clone());
                if settings.enable_startup {
                    let _ = app.handle().autolaunch().enable();
                } else {
                    let _ = app.handle().autolaunch().disable();
                }
            }
            #[cfg(all(target_os = "windows", debug_assertions))]
            {
                let _ = app.handle().autolaunch().disable();
            }

            apply_monitoring_state(&app.handle().clone());
            setup_tray(app)?;
            register_global_media_shortcuts(&app.handle().clone());

            Ok(())
        })
        .on_page_load(|window, _| {
            if window.label() == "main" {
                apply_startup_behavior(window.app_handle());
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "tray_panel" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                    return;
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if should_close_to_tray(window.app_handle()) {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            notes_get_file_tree,
            notes_read_file,
            notes_write_file,
            notes_create_file,
            notes_create_folder,
            notes_ensure_dir,
            notes_delete,
            notes_rename,
            notes_move_file,
            leetcode_read_csv,
            browser_open_in_app,
            browser_create_child,
            browser_update_child_bounds,
            browser_close_child,
            google_check_auth,
            google_sign_in,
            google_sign_out,
            google_list_events,
            google_add_event,
            google_update_event,
            google_delete_event,
            google_tasks_get_lists,
            google_tasks_list,
            google_tasks_add,
            google_tasks_update,
            google_tasks_delete,
            music_search,
            music_get_playlists,
            music_save_playlists,
            music_get_library,
            music_save_library,
            app_minimize_to_tray,
            app_show_window,
            app_show_window_page,
            app_quit,
            app_get_incognito_status,
            app_toggle_incognito,
            app_set_incognito_for,
            app_get_game_mode,
            app_toggle_game_mode,
            app_refresh_ai,
            app_clear_notifications,
            app_music_control,
            app_music_playlist_select,
            app_timer_control,
            app_toggle_tray_panel,
            // ─── Intent / IntentFlow commands ────────────────
            intent::activity::get_activities,
            intent::activity::get_activity_stats,
            intent::activity::start_activity_tracker,
            intent::chat::create_chat_session,
            intent::chat::get_chat_sessions,
            intent::chat::delete_chat_session,
            intent::chat::get_chat_messages,
            intent::chat::send_chat_message,
            intent::diary::diary_get_entries,
            intent::diary::diary_save_entry,
            intent::diary::diary_delete_entry,
            intent::diary::diary_generate_entry,
            intent::settings::settings_get,
            intent::settings::settings_save,
            intent::settings::settings_get_nvidia_models,
            intent::settings::settings_get_lmstudio_models,
            intent::settings::settings_validate_api_key,
            intent::settings::settings_nvidia_chat_completion,
            intent::settings::settings_lmstudio_chat_completion,
            intent::settings::brain_chat_stream,
            intent::dashboard::dashboard_get_overview,
            intent::dashboard::dashboard_refresh_overview,
            intent::dashboard::dashboard_summarize_item,
            intent::dashboard::dashboard_upsert_deadline,
            intent::dashboard::dashboard_delete_deadline,
            intent::dashboard::dashboard_upsert_project,
            intent::dashboard::dashboard_delete_project,
            intent::storage::storage_get_stats,
            intent::storage::storage_clear_all,
            intent::storage::storage_export_data,
            intent::storage::storage_import_data,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| panic!("error while running tauri application: {e}"));
}
