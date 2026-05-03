use serde::{Deserialize, Serialize};

pub mod settings;

pub use settings::*;

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
    pub status: String, // "Playing", "Paused", "Stopped"
}
