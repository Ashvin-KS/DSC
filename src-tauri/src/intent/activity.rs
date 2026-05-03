use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Activity {
    pub id: i64,
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "categoryId")]
    pub category_id: i64,
    #[serde(rename = "startTime")]
    pub start_time: i64,
    #[serde(rename = "endTime")]
    pub end_time: i64,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: i64,
    pub metadata: Option<ActivityMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActivityMetadata {
    pub is_idle: bool,
    pub is_fullscreen: bool,
    pub process_id: Option<u32>,
    pub url: Option<String>,
    pub screen_text: Option<String>,
    pub background_windows: Option<Vec<String>>,
    pub media_info: Option<MediaInfo>,
    pub raw_duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEvent {
    pub app_name: String,
    pub app_hash: u64,
    pub window_title: String,
    pub window_title_hash: u64,
    pub category_id: i32,
    pub start_time: i64,
    pub end_time: i64,
    pub duration_seconds: i32,
    pub metadata: ActivityMetadata,
}

impl ActivityEvent {
    pub fn new(
        app_name: String,
        window_title: String,
        category_id: i32,
        start_time: i64,
        end_time: i64,
    ) -> Self {
        use twox_hash::XxHash64;
        use std::hash::Hasher;
        
        let mut hasher = XxHash64::default();
        hasher.write(app_name.as_bytes());
        let app_hash = hasher.finish();
        
        let mut hasher = XxHash64::default();
        hasher.write(window_title.to_lowercase().as_bytes());
        let window_title_hash = hasher.finish();
        
        let duration_seconds = (end_time - start_time) as i32;
        
        Self {
            app_name,
            app_hash,
            window_title,
            window_title_hash,
            category_id,
            start_time,
            end_time,
            duration_seconds,
            metadata: ActivityMetadata::default(),
        }
    }
}


#[derive(Debug, Serialize, Deserialize)]
pub struct ActivityStats {
    #[serde(rename = "totalSeconds")]
    pub total_seconds: i64,
    #[serde(rename = "totalEvents")]
    pub total_events: i64,
    #[serde(rename = "topApps")]
    pub top_apps: Vec<AppUsage>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppUsage {
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "totalSeconds")]
    pub total_seconds: i64,
    pub sessions: i64,
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_activities(
    app_handle: AppHandle,
    start_time: i64,
    end_time: i64,
    limit: Option<i64>,
) -> Result<Vec<Activity>, String> {
    let conn = crate::intent::db::open(&app_handle)?;
    let lim = limit.unwrap_or(500).min(1000);

    let mut stmt = conn.prepare(
        "SELECT id, app_name, window_title, category_id, start_time, end_time, duration_seconds, metadata
         FROM activities
         WHERE start_time >= ?1 AND start_time <= ?2
         ORDER BY start_time DESC
         LIMIT ?3",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(
        rusqlite::params![start_time, end_time, lim],
        |row| {
            let metadata: Option<crate::intent::activity::ActivityMetadata> = row.get::<_, Option<Vec<u8>>>(7)
                .ok()
                .flatten()
                .and_then(|blob| serde_json::from_slice(&blob).ok());
            Ok(Activity {
                id:               row.get(0)?,
                app_name:         row.get(1)?,
                window_title:     row.get(2)?,
                category_id:      row.get(3)?,
                start_time:       row.get(4)?,
                end_time:         row.get(5)?,
                duration_seconds: row.get(6)?,
                metadata,
            })
        },
    ).map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| match r {
        Ok(activity) => Some(activity),
        Err(e) => {
            eprintln!("[get_activities] Failed to parse activity row: {}", e);
            None
        }
    }).collect())
}

#[tauri::command]
pub async fn get_activity_stats(
    app_handle: AppHandle,
    start_time: i64,
    end_time: i64,
) -> Result<ActivityStats, String> {
    let conn = crate::intent::db::open(&app_handle)?;

    let (total_seconds, total_events): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(duration_seconds), 0), COUNT(*)
         FROM activities WHERE start_time >= ?1 AND start_time <= ?2",
        rusqlite::params![start_time, end_time],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT app_name, SUM(duration_seconds) as total, COUNT(*) as sessions
         FROM activities
         WHERE start_time >= ?1 AND start_time <= ?2
         GROUP BY app_name
         ORDER BY total DESC
         LIMIT 10",
    ).map_err(|e| e.to_string())?;

    let top_apps = stmt.query_map(
        rusqlite::params![start_time, end_time],
        |row| Ok(AppUsage {
            app_name:      row.get(0)?,
            total_seconds: row.get(1)?,
            sessions:      row.get(2)?,
        }),
    ).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(ActivityStats { total_seconds, total_events, top_apps })
}

/// Start the activity tracker — placeholder until the full tracker service is wired.
#[tauri::command]
pub async fn start_activity_tracker() -> Result<bool, String> {
    // The Windows activity tracker requires the `active-win-pos-rs` and `winapi` crates.
    // Those can be added incrementally without breaking the build.
    // For now this command returns true so the frontend can call it safely.
    Ok(true)
}
