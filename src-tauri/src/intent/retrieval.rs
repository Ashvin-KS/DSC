use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone, Utc};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::intent::activity::ActivityMetadata;

pub const DEFAULT_EMBED_MODEL: &str = "BAAI/bge-base-en-v1.5";
pub const CHAT_SOURCE_IDS: [&str; 5] = ["apps", "screen", "media", "browser", "files"];
const MAX_CHUNK_CHARS: usize = 4_000;
const MAX_SUMMARY_CHARS: usize = 512;
const MAX_EVIDENCE_CHARS: usize = 1_000;
const EMBEDDING_BATCH_SIZE: usize = 12;
const EMBEDDING_IDLE_POLL_SECS: u64 = 12;
const EMBEDDING_ACTIVE_POLL_SECS: u64 = 3;
const EMBEDDING_MAX_ATTEMPTS: i64 = 3;
const EMBEDDING_RUNNING_STALE_SECS: i64 = 120;
const ROLLUP_REFRESH_SECS: u64 = 1800;

struct EmbedderState {
    model_name: String,
    model: TextEmbedding,
}

static EMBEDDER: OnceLock<Mutex<Option<EmbedderState>>> = OnceLock::new();
static VAULT_REINDEX_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct ChunkInput<'a> {
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub source_type: &'a str,
    pub chunk_text: &'a str,
    pub chunk_summary: Option<String>,
    pub project_root: Option<&'a str>,
    pub source_ts: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct VaultIndexProgress {
    pub vault_path: String,
    pub stage: String,
    pub total_files: usize,
    pub processed_files: usize,
    pub indexed_chunks: usize,
    pub current_file: Option<String>,
}

fn emit_vault_index_progress(app: &AppHandle, payload: &VaultIndexProgress) {
    let _ = app.emit("notes://vault-index-progress", payload);
}

#[derive(Clone, Debug)]
pub struct EvidenceInput {
    pub evidence_type: String,
    pub text: String,
    pub source_ts: i64,
}

#[derive(Debug)]
struct EmbeddingJob {
    id: i64,
    chunk_id: i64,
    model_name: String,
    attempts: i64,
    chunk_text: String,
}

#[derive(Clone, Debug)]
struct RetrievalCandidate {
    chunk_id: i64,
    entity_type: String,
    entity_id: String,
    source_type: String,
    chunk_summary: String,
    chunk_text: String,
    project_root: Option<String>,
    source_ts: Option<i64>,
    lexical_score: f32,
    semantic_score: f32,
    structured_score: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct RetrievalHit {
    pub chunk_id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub source_type: String,
    pub summary: String,
    pub snippet: String,
    pub project_root: Option<String>,
    pub source_ts: Option<i64>,
    pub score: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct HybridRetrievalContext {
    pub route: String,
    pub lexical_hits: usize,
    pub semantic_hits: usize,
    pub structured_hits: usize,
    pub prompt_context: String,
    pub hits: Vec<RetrievalHit>,
}

#[derive(Clone, Debug, Default)]
pub struct RetrievalScopeFilter {
    allowed_source_types: Option<Vec<String>>,
    excluded_source_types: Vec<String>,
    excluded_entity_types: Vec<String>,
}

impl RetrievalScopeFilter {
    fn allows(&self, candidate: &RetrievalCandidate) -> bool {
        if self
            .excluded_entity_types
            .iter()
            .any(|entity_type| entity_type == &candidate.entity_type)
        {
            return false;
        }
        if self
            .excluded_source_types
            .iter()
            .any(|source_type| source_type == &candidate.source_type)
        {
            return false;
        }
        match &self.allowed_source_types {
            Some(allowed) => allowed.iter().any(|source_type| source_type == &candidate.source_type),
            None => true,
        }
    }
}

pub fn build_chat_retrieval_filter(selected_sources: Option<&[String]>) -> RetrievalScopeFilter {
    let enabled_sources: Vec<String> = match selected_sources {
        Some(sources) if !sources.is_empty() => sources.iter().map(|value| value.trim().to_lowercase()).collect(),
        _ => vec!["apps".to_string(), "screen".to_string(), "media".to_string()],
    };

    let mut allowed_source_types: Vec<String> = Vec::new();
    let mut push_allowed = |value: &str| {
        if !allowed_source_types.iter().any(|existing| existing == value) {
            allowed_source_types.push(value.to_string());
        }
    };

    // Retrieval boundary policy:
    // Chat stays activity-first; note/file evidence is only allowed through the Files source.
    for source in enabled_sources {
        match source.as_str() {
            "apps" => {
                push_allowed("activity_window");
                push_allowed("summary_daily");
                push_allowed("summary_weekly");
            }
            "screen" => push_allowed("ocr"),
            "media" => push_allowed("media"),
            "browser" => push_allowed("url"),
            "files" => {
                push_allowed("file_change");
                push_allowed("vault_note_outline");
                push_allowed("vault_note_chunk");
            }
            _ => {}
        }
    }

    RetrievalScopeFilter {
        allowed_source_types: Some(allowed_source_types),
        excluded_source_types: vec!["chat_user".to_string(), "chat_assistant".to_string()],
        excluded_entity_types: vec!["chat_message".to_string()],
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct VaultIndexStats {
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub vault_path: String,
    pub cancelled: bool,
}

fn begin_vault_reindex_session() -> u64 {
    VAULT_REINDEX_SESSION.fetch_add(1, Ordering::SeqCst) + 1
}

fn is_vault_reindex_session_cancelled(session_id: u64) -> bool {
    VAULT_REINDEX_SESSION.load(Ordering::SeqCst) != session_id
}

pub fn cancel_vault_reindex() {
    VAULT_REINDEX_SESSION.fetch_add(1, Ordering::SeqCst);
}

fn tokenize_query_terms(input: &str) -> Vec<String> {
    input
        .split(|c: char| !c.is_alphanumeric())
        .map(|part| part.trim().to_lowercase())
        .filter(|part| part.len() >= 3)
        .filter(|part| !matches!(part.as_str(), "what" | "when" | "where" | "which" | "with" | "from" | "that" | "this" | "have" | "about" | "your" | "mine" | "into" | "there" | "their"))
        .collect()
}

fn make_fts_query(query: &str) -> Option<String> {
    let terms = tokenize_query_terms(query);
    if terms.is_empty() {
        None
    } else {
        Some(
            terms
                .into_iter()
                .take(6)
                .map(|term| format!("{term}*"))
                .collect::<Vec<_>>()
                .join(" OR "),
        )
    }
}

fn detect_retrieval_route(query: &str) -> &'static str {
    let lower = query.to_lowercase();
    let semantic_markers = [
        "similar", "like this", "felt", "reminds", "pattern", "theme", "state", "vibe",
        "related", "about myself", "what was going on", "connected",
    ];
    let structured_markers = [
        "how many", "how often", "total", "top", "most", "least", "when", "timeline",
        "today", "yesterday", "last", "week", "month", "year", "hours", "minutes",
    ];

    if semantic_markers.iter().any(|marker| lower.contains(marker)) {
        "semantic"
    } else if structured_markers.iter().any(|marker| lower.contains(marker)) {
        "structured"
    } else if tokenize_query_terms(query).len() >= 3 {
        "hybrid"
    } else {
        "keyword"
    }
}

fn recent_candidate_limit(start_ts: i64, end_ts: i64) -> i64 {
    let span_days = ((end_ts - start_ts).max(0) as f64 / 86_400.0).ceil();
    if start_ts <= 0 || span_days >= 90.0 {
        900
    } else if span_days >= 30.0 {
        700
    } else if span_days >= 7.0 {
        500
    } else {
        320
    }
}

fn source_weight(source_type: &str) -> f32 {
    match source_type {
        "diary" => 1.1,
        "chat_user" => 1.18,
        "chat_assistant" => 0.92,
        "ocr" => 1.1,
        "url" => 0.98,
        "media" => 0.9,
        "file_change" => 1.05,
        "activity_window" => 1.0,
        "summary_daily" | "summary_weekly" => 1.02,
        "vault_note_outline" => 0.98,
        "vault_note_chunk" => 1.0,
        _ => 0.95,
    }
}

fn recency_weight(source_ts: Option<i64>, end_ts: i64) -> f32 {
    let Some(ts) = source_ts else {
        return 0.85;
    };
    if end_ts <= 0 || ts <= 0 {
        return 0.9;
    }
    let age_days = ((end_ts - ts).max(0) as f32) / 86_400.0;
    1.0 / (1.0 + (age_days / 14.0))
}

fn make_snippet(text: &str, max_chars: usize) -> String {
    truncate_chars(text, max_chars)
}

fn lexical_overlap_score(query_terms: &[String], text: &str) -> f32 {
    if query_terms.is_empty() {
        return 0.0;
    }
    let haystack = text.to_lowercase();
    let matches = query_terms
        .iter()
        .filter(|term| haystack.contains(term.as_str()))
        .count();
    matches as f32 / query_terms.len() as f32
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }

    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    if norm_a <= f32::EPSILON || norm_b <= f32::EPSILON {
        0.0
    } else {
        dot / (norm_a.sqrt() * norm_b.sqrt())
    }
}

fn format_ts(source_ts: Option<i64>) -> String {
    source_ts
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .map(|dt| dt.format("%b %d %I:%M %p").to_string())
        .unwrap_or_else(|| "unknown time".to_string())
}

fn local_day_start_ts(days_ago: i64) -> Option<i64> {
    let now = Local::now();
    let target_date = now.date_naive() - ChronoDuration::days(days_ago);
    let start_naive = target_date.and_hms_opt(0, 0, 0)?;
    now.timezone()
        .from_local_datetime(&start_naive)
        .single()
        .map(|dt| dt.timestamp())
}

fn date_key_from_ts(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(ts, 0).map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn week_key_from_ts(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(ts, 0).map(|dt| {
        let local_dt = dt.with_timezone(&Local);
        let iso = local_dt.iso_week();
        format!("{}-W{:02}", iso.year(), iso.week())
    })
}

fn fetch_structured_candidates(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
    filter: Option<&RetrievalScopeFilter>,
) -> Result<Vec<RetrievalCandidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, source_type, chunk_summary, chunk_text, project_root, source_ts
             FROM retrieval_chunks
             WHERE (?1 <= 0 OR COALESCE(source_ts, 0) >= ?1)
               AND (?2 <= 0 OR COALESCE(source_ts, 0) <= ?2)
             ORDER BY COALESCE(source_ts, 0) DESC, updated_at DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![start_ts, end_ts, limit], |row| {
            Ok(RetrievalCandidate {
                chunk_id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                source_type: row.get(3)?,
                chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                chunk_text: row.get(5)?,
                project_root: row.get(6)?,
                source_ts: row.get(7)?,
                lexical_score: 0.0,
                semantic_score: 0.0,
                structured_score: 1.0,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows
        .filter_map(|row| row.ok())
        .filter(|candidate| filter.map(|value| value.allows(candidate)).unwrap_or(true))
        .collect())
}

fn fetch_lexical_candidates(
    conn: &Connection,
    fts_query: &str,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
    filter: Option<&RetrievalScopeFilter>,
) -> Result<Vec<RetrievalCandidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT rc.id, rc.entity_type, rc.entity_id, rc.source_type, rc.chunk_summary, rc.chunk_text, rc.project_root, rc.source_ts, bm25(retrieval_chunks_fts) AS rank
             FROM retrieval_chunks_fts
             INNER JOIN retrieval_chunks rc ON rc.id = retrieval_chunks_fts.rowid
             WHERE retrieval_chunks_fts MATCH ?1
               AND (?2 <= 0 OR COALESCE(rc.source_ts, 0) >= ?2)
               AND (?3 <= 0 OR COALESCE(rc.source_ts, 0) <= ?3)
             ORDER BY rank
             LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![fts_query, start_ts, end_ts, limit], |row| {
            let rank = row.get::<_, f64>(8).unwrap_or(0.0) as f32;
            Ok(RetrievalCandidate {
                chunk_id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                source_type: row.get(3)?,
                chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                chunk_text: row.get(5)?,
                project_root: row.get(6)?,
                source_ts: row.get(7)?,
                lexical_score: 1.0 / (1.0 + rank.abs()),
                semantic_score: 0.0,
                structured_score: 0.0,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows
        .filter_map(|row| row.ok())
        .filter(|candidate| filter.map(|value| value.allows(candidate)).unwrap_or(true))
        .collect())
}

fn fetch_semantic_candidates(
    conn: &Connection,
    query_embedding: &[f32],
    start_ts: i64,
    end_ts: i64,
    route: &str,
    filter: Option<&RetrievalScopeFilter>,
) -> Result<Vec<RetrievalCandidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT rc.id, rc.entity_type, rc.entity_id, rc.source_type, rc.chunk_summary, rc.chunk_text, rc.project_root, rc.source_ts, re.vector_json
             FROM retrieval_embeddings re
             INNER JOIN retrieval_chunks rc ON rc.id = re.chunk_id
             WHERE (?1 <= 0 OR COALESCE(rc.source_ts, 0) >= ?1)
               AND (?2 <= 0 OR COALESCE(rc.source_ts, 0) <= ?2)
               AND re.model_name = ?3
             ORDER BY COALESCE(rc.source_ts, 0) DESC
             LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;

    let candidate_limit = if route == "semantic" { 900 } else { 500 };
    let rows = stmt
        .query_map(params![start_ts, end_ts, DEFAULT_EMBED_MODEL, candidate_limit], |row| {
            let vector_json: String = row.get(8)?;
            Ok((
                RetrievalCandidate {
                    chunk_id: row.get(0)?,
                    entity_type: row.get(1)?,
                    entity_id: row.get(2)?,
                    source_type: row.get(3)?,
                    chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    chunk_text: row.get(5)?,
                    project_root: row.get(6)?,
                    source_ts: row.get(7)?,
                    lexical_score: 0.0,
                    semantic_score: 0.0,
                    structured_score: 0.0,
                },
                vector_json,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut candidates = Vec::new();
    for row in rows.filter_map(|row| row.ok()) {
        let (mut candidate, vector_json) = row;
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&vector_json) else {
            continue;
        };
        candidate.semantic_score = cosine_similarity(query_embedding, &vector);
        if filter.map(|value| value.allows(&candidate)).unwrap_or(true) {
            candidates.push(candidate);
        }
    }

    candidates.sort_by(|a, b| b.semantic_score.partial_cmp(&a.semantic_score).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(if route == "semantic" { 14 } else { 8 });
    Ok(candidates)
}

fn build_prompt_context(route: &str, hits: &[RetrievalHit]) -> String {
    if hits.is_empty() {
        return "No grounded retrieval evidence found in the selected scope.".to_string();
    }

    let mut lines = Vec::new();
    lines.push(format!("HYBRID RETRIEVAL EVIDENCE [{}]", route.to_uppercase()));
    for (idx, hit) in hits.iter().enumerate() {
        let header = format!(
            "{}. [{}] {} | {}",
            idx + 1,
            hit.source_type,
            format_ts(hit.source_ts),
            hit.summary
        );
        lines.push(header);
        lines.push(format!("   {}", hit.snippet));
        if let Some(project_root) = hit.project_root.as_deref().filter(|value| !value.trim().is_empty()) {
            lines.push(format!("   project: {}", project_root));
        }
    }

    lines.join("\n")
}

fn split_markdown_chunks(content: &str, lines_per_chunk: usize, overlap: usize) -> Vec<(usize, usize, String)> {
    let lines = content.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + lines_per_chunk).min(lines.len());
        let text = lines[start..end].join("\n");
        if !text.trim().is_empty() {
            chunks.push((start + 1, end, text));
        }
        if end == lines.len() {
            break;
        }
        start = (end.saturating_sub(overlap)).max(start + 1);
    }
    chunks
}

fn extract_markdown_headings(content: &str, limit: usize) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .take(limit)
        .collect()
}

fn file_modified_ts(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
}

fn delete_vault_chunks_for_root(conn: &Connection, vault_root: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM retrieval_chunks WHERE entity_type = 'vault_note' AND project_root = ?1",
        params![vault_root],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_vault_chunks_for_note(conn: &Connection, vault_root: &str, entity_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM retrieval_chunks
         WHERE entity_type = 'vault_note' AND project_root = ?1 AND entity_id = ?2",
        params![vault_root, entity_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn index_single_vault_note(
    conn: &Connection,
    vault_root: &str,
    canonical_path: &Path,
    relative_path: &str,
    content: &str,
) -> Result<usize, String> {
    let full_path = canonical_path.to_string_lossy().to_string();
    delete_vault_chunks_for_note(conn, vault_root, &full_path)?;

    let headings = extract_markdown_headings(content, 24);
    let heading_text = if headings.is_empty() {
        "No markdown headings found.".to_string()
    } else {
        headings.join("\n")
    };
    let modified_ts = file_modified_ts(canonical_path);
    let outline_text = format!(
        "Path: {relative_path}\nFile: {}\n\nHEADINGS:\n{heading_text}",
        canonical_path.file_name().and_then(|name| name.to_str()).unwrap_or(relative_path),
    );

    upsert_retrieval_chunk(
        conn,
        ChunkInput {
            entity_type: "vault_note",
            entity_id: &full_path,
            source_type: "vault_note_outline",
            chunk_text: &outline_text,
            chunk_summary: Some(format!("Outline for {relative_path}")),
            project_root: Some(vault_root),
            source_ts: modified_ts,
        },
    )?;

    let mut chunks_indexed = 1usize;
    for (start_line, end_line, chunk_text) in split_markdown_chunks(content, 36, 8) {
        let title = headings
            .iter()
            .find(|heading| heading.starts_with('#'))
            .cloned()
            .unwrap_or_else(|| relative_path.to_string());
        let summary = format!("{relative_path} [{start_line}-{end_line}] {title}");
        upsert_retrieval_chunk(
            conn,
            ChunkInput {
                entity_type: "vault_note",
                entity_id: &full_path,
                source_type: "vault_note_chunk",
                chunk_text: &format!("Path: {relative_path}\nLines: {start_line}-{end_line}\n\n{chunk_text}"),
                chunk_summary: Some(summary),
                project_root: Some(vault_root),
                source_ts: modified_ts,
            },
        )?;
        chunks_indexed += 1;
    }

    Ok(chunks_indexed)
}

fn is_markdown_file(path: &Path) -> bool {
    path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn normalize_path_key_str(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    let candidate_key = normalize_path_key(candidate);
    let root_key = normalize_path_key(root);
    candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}\\"))
}

fn path_matches_or_within(candidate: &str, prefix_key: &str) -> bool {
    let candidate_key = normalize_path_key_str(candidate);
    candidate_key == prefix_key || candidate_key.starts_with(&format!("{prefix_key}\\"))
}

fn delete_vault_chunks_for_subtree(
    conn: &Connection,
    vault_root: &str,
    subtree_path: &Path,
) -> Result<usize, String> {
    let prefix_key = normalize_path_key(subtree_path);
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_id
             FROM retrieval_chunks
             WHERE entity_type = 'vault_note' AND project_root = ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![vault_root], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut deleted = 0usize;
    for row in rows.filter_map(|row| row.ok()) {
        let (id, entity_id) = row;
        if !path_matches_or_within(&entity_id, &prefix_key) {
            continue;
        }

        conn.execute("DELETE FROM retrieval_chunks WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        deleted += 1;
    }

    Ok(deleted)
}

pub fn upsert_markdown_note(
    app: &AppHandle,
    vault_path: &str,
    note_path: &Path,
) -> Result<usize, String> {
    if !is_markdown_file(note_path) {
        return Ok(0);
    }

    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    let canonical_note = fs::canonicalize(note_path).map_err(|e| format!("Invalid note path: {e}"))?;
    if !path_is_within(&canonical_note, &canonical_vault) {
        return Ok(0);
    }

    let content = fs::read_to_string(&canonical_note).map_err(|e| format!("Failed to read note content: {e}"))?;
    let vault_root = canonical_vault.to_string_lossy().to_string();
    let relative_path = canonical_note
        .strip_prefix(&canonical_vault)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| {
            canonical_note
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown.md")
                .to_string()
        });

    let conn = crate::intent::db::open(app)?;
    index_single_vault_note(&conn, &vault_root, &canonical_note, &relative_path, &content)
}

pub fn delete_markdown_note(
    app: &AppHandle,
    vault_path: &str,
    note_path: &Path,
) -> Result<(), String> {
    if !is_markdown_file(note_path) {
        return Ok(());
    }

    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    if !path_is_within(note_path, &canonical_vault) {
        return Ok(());
    }

    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;
    delete_vault_chunks_for_note(&conn, &vault_root, &note_path.to_string_lossy())
}

pub fn delete_markdown_subtree(
    app: &AppHandle,
    vault_path: &str,
    subtree_path: &Path,
) -> Result<usize, String> {
    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    if !path_is_within(subtree_path, &canonical_vault) {
        return Ok(0);
    }

    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;
    delete_vault_chunks_for_subtree(&conn, &vault_root, subtree_path)
}

pub fn reindex_markdown_subtree(
    app: &AppHandle,
    vault_path: &str,
    subtree_path: &Path,
) -> Result<VaultIndexStats, String> {
    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    let canonical_subtree = fs::canonicalize(subtree_path).map_err(|e| format!("Invalid subtree path: {e}"))?;
    if !path_is_within(&canonical_subtree, &canonical_vault) {
        return Ok(VaultIndexStats {
            indexed_files: 0,
            indexed_chunks: 0,
            vault_path: canonical_vault.to_string_lossy().to_string(),
            cancelled: false,
        });
    }

    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;

    if canonical_subtree.is_file() {
        if !is_markdown_file(&canonical_subtree) {
            return Ok(VaultIndexStats {
                indexed_files: 0,
                indexed_chunks: 0,
                vault_path: vault_root,
                cancelled: false,
            });
        }

        let content = fs::read_to_string(&canonical_subtree).map_err(|e| format!("Failed to read note content: {e}"))?;
        let relative_path = canonical_subtree
            .strip_prefix(&canonical_vault)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| {
                canonical_subtree
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("unknown.md")
                    .to_string()
            });
        let indexed_chunks = index_single_vault_note(
            &conn,
            &vault_root,
            &canonical_subtree,
            &relative_path,
            &content,
        )?;
        return Ok(VaultIndexStats {
            indexed_files: 1,
            indexed_chunks,
            vault_path: vault_root,
            cancelled: false,
        });
    }

    let markdown_paths: Vec<PathBuf> = WalkDir::new(&canonical_subtree)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file() && is_markdown_file(path))
        .collect();

    // Directory subtree reindex must clear prior subtree rows first so moved/renamed/deleted
    // notes do not linger in retrieval_chunks for this subtree.
    let _ = delete_vault_chunks_for_subtree(&conn, &vault_root, &canonical_subtree)?;

    let mut indexed_files = 0usize;
    let mut indexed_chunks = 0usize;

    for path in markdown_paths {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let relative_path = path
            .strip_prefix(&canonical_vault)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| path.file_name().and_then(|name| name.to_str()).unwrap_or("unknown.md").to_string());
        indexed_chunks += index_single_vault_note(&conn, &vault_root, &path, &relative_path, &content)?;
        indexed_files += 1;
    }

    Ok(VaultIndexStats {
        indexed_files,
        indexed_chunks,
        vault_path: vault_root,
        cancelled: false,
    })
}

fn embedding_model_from_name(model_name: &str) -> Result<EmbeddingModel, String> {
    match model_name {
        "BAAI/bge-base-en-v1.5" => Ok(EmbeddingModel::BGEBaseENV15),
        "BAAI/bge-small-en-v1.5" => Ok(EmbeddingModel::BGESmallENV15),
        other => Err(format!("Unsupported embedding model: {other}")),
    }
}

fn embedding_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("embedding-cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn with_embedder<T, F>(app: &AppHandle, model_name: &str, f: F) -> Result<T, String>
where
    F: FnOnce(&mut TextEmbedding) -> Result<T, String>,
{
    let cache_dir = embedding_cache_dir(app)?;
    let holder = EMBEDDER.get_or_init(|| Mutex::new(None));
    let mut guard = holder.lock().map_err(|_| "Embedding model lock poisoned".to_string())?;

    let needs_init = guard
        .as_ref()
        .map(|state| state.model_name != model_name)
        .unwrap_or(true);

    if needs_init {
        let init_options = InitOptions::new(embedding_model_from_name(model_name)?)
            .with_cache_dir(cache_dir)
            .with_show_download_progress(false)
            .with_max_length(512);
        let model = TextEmbedding::try_new(init_options).map_err(|e| e.to_string())?;
        *guard = Some(EmbedderState {
            model_name: model_name.to_string(),
            model,
        });
    }

    let state = guard
        .as_mut()
        .ok_or_else(|| "Embedding model not initialized".to_string())?;
    f(&mut state.model)
}

fn reclaim_stale_running_jobs(conn: &Connection) -> Result<(), String> {
    let now = Utc::now().timestamp();
    conn.execute(
        "UPDATE embedding_jobs
         SET status = 'pending', updated_at = ?1
         WHERE status = 'running' AND updated_at <= ?2",
        params![now, now - EMBEDDING_RUNNING_STALE_SECS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn claim_embedding_jobs(conn: &Connection, batch_size: usize) -> Result<Vec<EmbeddingJob>, String> {
    reclaim_stale_running_jobs(conn)?;

    let selected_model = conn
        .query_row(
            "SELECT model_name
             FROM embedding_jobs
             WHERE status IN ('pending', 'failed') AND attempts < ?1
             ORDER BY
               CASE status WHEN 'pending' THEN 0 ELSE 1 END,
               updated_at ASC
             LIMIT 1",
            params![EMBEDDING_MAX_ATTEMPTS],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(model_name) = selected_model else {
        return Ok(Vec::new());
    };

    let mut stmt = conn
        .prepare(
            "SELECT j.id, j.chunk_id, j.model_name, j.attempts, c.chunk_text
             FROM embedding_jobs j
             INNER JOIN retrieval_chunks c ON c.id = j.chunk_id
             WHERE j.model_name = ?1
               AND j.status IN ('pending', 'failed')
               AND j.attempts < ?2
             ORDER BY
               CASE j.status WHEN 'pending' THEN 0 ELSE 1 END,
               j.updated_at ASC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![model_name, EMBEDDING_MAX_ATTEMPTS, batch_size as i64], |row| {
            Ok(EmbeddingJob {
                id: row.get(0)?,
                chunk_id: row.get(1)?,
                model_name: row.get(2)?,
                attempts: row.get(3)?,
                chunk_text: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let jobs: Vec<EmbeddingJob> = rows.filter_map(|row| row.ok()).collect();
    if jobs.is_empty() {
        return Ok(jobs);
    }

    let now = Utc::now().timestamp();
    for job in &jobs {
        conn.execute(
            "UPDATE embedding_jobs SET status = 'running', updated_at = ?1 WHERE id = ?2",
            params![now, job.id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(jobs)
}

fn mark_embedding_jobs_failed(conn: &Connection, jobs: &[EmbeddingJob], error: &str) -> Result<(), String> {
    let now = Utc::now().timestamp();
    for job in jobs {
        conn.execute(
            "UPDATE embedding_jobs
             SET status = 'failed',
                 attempts = ?1,
                 last_error = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![job.attempts + 1, truncate_chars(error, 800), now, job.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn store_embeddings(
    conn: &Connection,
    jobs: &[EmbeddingJob],
    embeddings: Vec<Vec<f32>>,
) -> Result<(), String> {
    if jobs.len() != embeddings.len() {
        return Err(format!(
            "Embedding count mismatch: expected {}, got {}",
            jobs.len(),
            embeddings.len()
        ));
    }

    let now = Utc::now().timestamp();
    for (job, embedding) in jobs.iter().zip(embeddings.into_iter()) {
        let dimensions = embedding.len() as i64;
        let vector_json = serde_json::to_string(&embedding).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO retrieval_embeddings (chunk_id, model_name, dimensions, vector_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(chunk_id) DO UPDATE SET
               model_name = excluded.model_name,
               dimensions = excluded.dimensions,
               vector_json = excluded.vector_json,
               created_at = excluded.created_at",
            params![job.chunk_id, job.model_name, dimensions, vector_json, now],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE embedding_jobs
             SET status = 'completed',
                 attempts = ?1,
                 last_error = NULL,
                 updated_at = ?2
             WHERE id = ?3",
            params![job.attempts + 1, now, job.id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn process_embedding_job_batch(app: &AppHandle) -> Result<usize, String> {
    let conn = crate::intent::db::open(app)?;
    let jobs = claim_embedding_jobs(&conn, EMBEDDING_BATCH_SIZE)?;
    if jobs.is_empty() {
        return Ok(0);
    }

    let documents = jobs
        .iter()
        .map(|job| format!("passage: {}", truncate_chars(&job.chunk_text, MAX_CHUNK_CHARS)))
        .collect::<Vec<_>>();
    let model_name = jobs[0].model_name.clone();

    let embed_result = with_embedder(app, &model_name, |model| {
        model.embed(documents, None).map_err(|e| e.to_string())
    });

    match embed_result {
        Ok(embeddings) => {
            store_embeddings(&conn, &jobs, embeddings)?;
            Ok(jobs.len())
        }
        Err(error) => {
            mark_embedding_jobs_failed(&conn, &jobs, &error)?;
            Err(error)
        }
    }
}

pub fn start_embedding_worker(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let worker_handle = app_handle.clone();
            let processed = tauri::async_runtime::spawn_blocking(move || {
                process_embedding_job_batch(&worker_handle)
            })
            .await;

            let sleep_secs = match processed {
                Ok(Ok(count)) if count > 0 => EMBEDDING_ACTIVE_POLL_SECS,
                Ok(Ok(_)) => EMBEDDING_IDLE_POLL_SECS,
                Ok(Err(error)) => {
                    eprintln!("[retrieval] embedding batch failed: {error}");
                    EMBEDDING_IDLE_POLL_SECS
                }
                Err(error) => {
                    eprintln!("[retrieval] embedding worker join failed: {error}");
                    EMBEDDING_IDLE_POLL_SECS
                }
            };

            tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
        }
    });
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let normalized = normalize_whitespace(input);
    if normalized.chars().count() <= max_chars {
        normalized
    } else {
        normalized.chars().take(max_chars).collect::<String>()
    }
}

fn make_summary(text: &str) -> String {
    truncate_chars(text, MAX_SUMMARY_CHARS)
}

pub fn upsert_retrieval_chunk(conn: &Connection, chunk: ChunkInput<'_>) -> Result<i64, String> {
    let now = Utc::now().timestamp();
    let chunk_text = truncate_chars(chunk.chunk_text, MAX_CHUNK_CHARS);
    if chunk_text.is_empty() {
        return Err("chunk_text cannot be empty".to_string());
    }
    let chunk_summary = chunk.chunk_summary.unwrap_or_else(|| make_summary(&chunk_text));

    conn.execute(
        "INSERT INTO retrieval_chunks
         (entity_type, entity_id, source_type, chunk_text, chunk_summary, project_root, source_ts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(entity_type, entity_id, source_type, chunk_text)
         DO UPDATE SET
           chunk_summary = excluded.chunk_summary,
           project_root = excluded.project_root,
           source_ts = excluded.source_ts,
           updated_at = excluded.updated_at",
        params![
            chunk.entity_type,
            chunk.entity_id,
            chunk.source_type,
            chunk_text,
            chunk_summary,
            chunk.project_root,
            chunk.source_ts,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    let row_id: i64 = conn
        .query_row(
            "SELECT id FROM retrieval_chunks
             WHERE entity_type = ?1 AND entity_id = ?2 AND source_type = ?3 AND chunk_text = ?4",
            params![chunk.entity_type, chunk.entity_id, chunk.source_type, chunk_text],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR REPLACE INTO retrieval_chunks_fts
         (rowid, chunk_text, chunk_summary, entity_type, entity_id, source_type, source_ts, project_root)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row_id,
            chunk_text,
            chunk_summary,
            chunk.entity_type,
            chunk.entity_id,
            chunk.source_type,
            chunk.source_ts,
            chunk.project_root,
        ],
    )
    .map_err(|e| e.to_string())?;

    enqueue_embedding_job(conn, row_id, DEFAULT_EMBED_MODEL)?;
    Ok(row_id)
}

pub fn delete_retrieval_chunks_for_entity(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM retrieval_chunks WHERE entity_type = ?1 AND entity_id = ?2")
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = stmt
        .query_map(params![entity_type, entity_id], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for id in ids {
        conn.execute("DELETE FROM retrieval_chunks_fts WHERE rowid = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "DELETE FROM retrieval_chunks WHERE entity_type = ?1 AND entity_id = ?2",
        params![entity_type, entity_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn enqueue_embedding_job(conn: &Connection, chunk_id: i64, model_name: &str) -> Result<(), String> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO embedding_jobs (chunk_id, model_name, status, attempts, created_at, updated_at)
         VALUES (?1, ?2, 'pending', 0, ?3, ?3)
         ON CONFLICT(chunk_id) DO UPDATE SET
           model_name = excluded.model_name,
           status = 'pending',
           updated_at = excluded.updated_at",
        params![chunk_id, model_name, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn replace_activity_evidence(
    conn: &Connection,
    activity_id: i64,
    evidences: &[EvidenceInput],
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM activity_evidence WHERE activity_id = ?1")
        .map_err(|e| e.to_string())?;
    let existing_ids: Vec<i64> = stmt
        .query_map(params![activity_id], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for id in existing_ids {
        conn.execute("DELETE FROM activity_evidence_fts WHERE rowid = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM activity_evidence WHERE activity_id = ?1", params![activity_id])
        .map_err(|e| e.to_string())?;

    let now = Utc::now().timestamp();
    for evidence in evidences {
        let text = truncate_chars(&evidence.text, MAX_EVIDENCE_CHARS);
        if text.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO activity_evidence (activity_id, evidence_type, text, source_ts, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![activity_id, evidence.evidence_type, text, evidence.source_ts, now],
        )
        .map_err(|e| e.to_string())?;
        let evidence_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO activity_evidence_fts (rowid, text, evidence_type, activity_id, source_ts)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![evidence_id, text, evidence.evidence_type, activity_id, evidence.source_ts],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn extract_activity_evidence(metadata: &ActivityMetadata, source_ts: i64) -> Vec<EvidenceInput> {
    let mut evidences = Vec::new();

    if let Some(url) = metadata.url.as_deref() {
        let text = truncate_chars(url, MAX_EVIDENCE_CHARS);
        if !text.is_empty() {
            evidences.push(EvidenceInput {
                evidence_type: "url".to_string(),
                text,
                source_ts,
            });
        }
    }

    if let Some(screen_text) = metadata.screen_text.as_deref() {
        let text = truncate_chars(screen_text, MAX_EVIDENCE_CHARS);
        if !text.is_empty() {
            evidences.push(EvidenceInput {
                evidence_type: "ocr".to_string(),
                text,
                source_ts,
            });
        }
    }

    if let Some(media) = metadata.media_info.as_ref() {
        let combined = [media.title.as_str(), media.artist.as_str(), media.status.as_str()]
            .iter()
            .filter(|s| !s.trim().is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" | ");
        let text = truncate_chars(&combined, MAX_EVIDENCE_CHARS);
        if !text.is_empty() {
            evidences.push(EvidenceInput {
                evidence_type: "media".to_string(),
                text,
                source_ts,
            });
        }
    }

    if let Some(background_windows) = metadata.background_windows.as_ref() {
        let combined = truncate_chars(&background_windows.join(" | "), MAX_EVIDENCE_CHARS);
        if !combined.is_empty() {
            evidences.push(EvidenceInput {
                evidence_type: "background_windows".to_string(),
                text: combined,
                source_ts,
            });
        }
    }

    evidences
}

pub fn build_hybrid_context(
    app: &AppHandle,
    query: &str,
    start_ts: i64,
    end_ts: i64,
    max_hits: usize,
    filter: Option<&RetrievalScopeFilter>,
) -> Result<HybridRetrievalContext, String> {
    let conn = crate::intent::db::open(app)?;
    let route = detect_retrieval_route(query).to_string();
    let query_terms = tokenize_query_terms(query);
    let mut candidates = Vec::new();
    let structured = fetch_structured_candidates(&conn, start_ts, end_ts, 12, filter)?;
    let fts_query = make_fts_query(query);
    let lexical = if let Some(ref match_query) = fts_query {
        fetch_lexical_candidates(&conn, match_query, start_ts, end_ts, 12, filter)?
    } else {
        Vec::new()
    };

    candidates.extend(structured.iter().cloned());
    candidates.extend(lexical.iter().cloned());

    let mut semantic = Vec::new();
    if route == "semantic" || route == "hybrid" {
        let query_embedding = with_embedder(app, DEFAULT_EMBED_MODEL, |model| {
            let inputs = vec![format!("query: {}", truncate_chars(query, MAX_CHUNK_CHARS))];
            let embeddings = model.embed(inputs, None).map_err(|e| e.to_string())?;
            embeddings
                .into_iter()
                .next()
                .ok_or_else(|| "Embedding model returned no query vector".to_string())
        })?;
        semantic = fetch_semantic_candidates(&conn, &query_embedding, start_ts, end_ts, &route, filter)?;
        candidates.extend(semantic.iter().cloned());
    }

    if candidates.is_empty() {
        return Ok(HybridRetrievalContext {
            route,
            lexical_hits: lexical.len(),
            semantic_hits: semantic.len(),
            structured_hits: structured.len(),
            prompt_context: "No grounded retrieval evidence found in the selected scope.".to_string(),
            hits: Vec::new(),
        });
    }

    let mut deduped: std::collections::HashMap<i64, RetrievalCandidate> = std::collections::HashMap::new();
    for mut candidate in candidates {
        let overlap = lexical_overlap_score(
            &query_terms,
            &format!("{} {}", candidate.chunk_summary, candidate.chunk_text),
        );
        candidate.lexical_score = candidate.lexical_score.max(overlap);
        let entry = deduped.entry(candidate.chunk_id).or_insert_with(|| candidate.clone());
        entry.lexical_score = entry.lexical_score.max(candidate.lexical_score);
        entry.semantic_score = entry.semantic_score.max(candidate.semantic_score);
        entry.structured_score = entry.structured_score.max(candidate.structured_score);
        if entry.chunk_summary.is_empty() && !candidate.chunk_summary.is_empty() {
            entry.chunk_summary = candidate.chunk_summary.clone();
        }
        if entry.project_root.is_none() {
            entry.project_root = candidate.project_root.clone();
        }
        if entry.source_ts.is_none() {
            entry.source_ts = candidate.source_ts;
        }
    }

    let mut scored_hits = deduped
        .into_values()
        .map(|candidate| {
            let route_multiplier = match route.as_str() {
                "semantic" => 0.55 * candidate.semantic_score + 0.25 * candidate.lexical_score + 0.20 * candidate.structured_score,
                "structured" => 0.55 * candidate.structured_score + 0.30 * candidate.lexical_score + 0.15 * candidate.semantic_score,
                "keyword" => 0.65 * candidate.lexical_score + 0.20 * candidate.structured_score + 0.15 * candidate.semantic_score,
                _ => 0.40 * candidate.semantic_score + 0.35 * candidate.lexical_score + 0.25 * candidate.structured_score,
            };
            let score = route_multiplier * source_weight(&candidate.source_type) * recency_weight(candidate.source_ts, end_ts);
            RetrievalHit {
                chunk_id: candidate.chunk_id,
                entity_type: candidate.entity_type,
                entity_id: candidate.entity_id,
                source_type: candidate.source_type,
                summary: if candidate.chunk_summary.trim().is_empty() {
                    make_summary(&candidate.chunk_text)
                } else {
                    candidate.chunk_summary
                },
                snippet: make_snippet(&candidate.chunk_text, 220),
                project_root: candidate.project_root,
                source_ts: candidate.source_ts,
                score,
            }
        })
        .collect::<Vec<_>>();

    scored_hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored_hits.truncate(max_hits.min(recent_candidate_limit(start_ts, end_ts) as usize).max(1));
    let prompt_context = build_prompt_context(&route, &scored_hits);

    Ok(HybridRetrievalContext {
        route,
        lexical_hits: lexical.len(),
        semantic_hits: semantic.len(),
        structured_hits: structured.len(),
        prompt_context,
        hits: scored_hits,
    })
}

pub fn reindex_markdown_vault(app: &AppHandle, vault_path: &str) -> Result<VaultIndexStats, String> {
    let session_id = begin_vault_reindex_session();
    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;
    delete_vault_chunks_for_root(&conn, &vault_root)?;

    let markdown_paths: Vec<PathBuf> = WalkDir::new(&canonical_vault)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
        })
        .collect();

    let mut indexed_files = 0usize;
    let mut indexed_chunks = 0usize;
    let total_files = markdown_paths.len();

    emit_vault_index_progress(
        app,
        &VaultIndexProgress {
            vault_path: vault_root.clone(),
            stage: "started".to_string(),
            total_files,
            processed_files: 0,
            indexed_chunks: 0,
            current_file: None,
        },
    );

    for path in markdown_paths {
        if is_vault_reindex_session_cancelled(session_id) {
            emit_vault_index_progress(
                app,
                &VaultIndexProgress {
                    vault_path: vault_root.clone(),
                    stage: "cancelled".to_string(),
                    total_files,
                    processed_files: indexed_files,
                    indexed_chunks,
                    current_file: None,
                },
            );

            return Ok(VaultIndexStats {
                indexed_files,
                indexed_chunks,
                vault_path: vault_root,
                cancelled: true,
            });
        }

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let relative_path = path
            .strip_prefix(&canonical_vault)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| path.file_name().and_then(|name| name.to_str()).unwrap_or("unknown.md").to_string());
        indexed_chunks += index_single_vault_note(&conn, &vault_root, &path, &relative_path, &content)?;
        indexed_files += 1;
        emit_vault_index_progress(
            app,
            &VaultIndexProgress {
                vault_path: vault_root.clone(),
                stage: "indexing".to_string(),
                total_files,
                processed_files: indexed_files,
                indexed_chunks,
                current_file: Some(relative_path),
            },
        );
    }

    emit_vault_index_progress(
        app,
        &VaultIndexProgress {
            vault_path: vault_root.clone(),
            stage: "completed".to_string(),
            total_files,
            processed_files: indexed_files,
            indexed_chunks,
            current_file: None,
        },
    );

    Ok(VaultIndexStats {
        indexed_files,
        indexed_chunks,
        vault_path: vault_root,
        cancelled: false,
    })
}

pub fn build_vault_context(
    app: &AppHandle,
    vault_path: &str,
    query: &str,
    max_hits: usize,
) -> Result<HybridRetrievalContext, String> {
    let canonical_vault = fs::canonicalize(vault_path).map_err(|e| format!("Invalid vault path: {e}"))?;
    let vault_root = canonical_vault.to_string_lossy().to_string();
    let conn = crate::intent::db::open(app)?;

    let indexed_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM retrieval_chunks WHERE entity_type = 'vault_note' AND project_root = ?1",
            params![vault_root],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if indexed_count == 0 {
        let _ = reindex_markdown_vault(app, vault_path)?;
    }

    let conn = crate::intent::db::open(app)?;
    let route = detect_retrieval_route(query).to_string();
    let query_terms = tokenize_query_terms(query);

    let mut structured = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, source_type, chunk_summary, chunk_text, project_root, source_ts
             FROM retrieval_chunks
             WHERE entity_type = 'vault_note' AND project_root = ?1
             ORDER BY source_ts DESC, updated_at DESC
             LIMIT 18",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![vault_root], |row| {
            Ok(RetrievalCandidate {
                chunk_id: row.get(0)?,
                entity_type: row.get(1)?,
                entity_id: row.get(2)?,
                source_type: row.get(3)?,
                chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                chunk_text: row.get(5)?,
                project_root: row.get(6)?,
                source_ts: row.get(7)?,
                lexical_score: 0.0,
                semantic_score: 0.0,
                structured_score: 1.0,
            })
        })
        .map_err(|e| e.to_string())?;
    structured.extend(rows.filter_map(|row| row.ok()));

    let mut lexical = Vec::new();
    if let Some(fts_query) = make_fts_query(query) {
        let mut stmt = conn
            .prepare(
                "SELECT rc.id, rc.entity_type, rc.entity_id, rc.source_type, rc.chunk_summary, rc.chunk_text, rc.project_root, rc.source_ts, bm25(retrieval_chunks_fts) AS rank
                 FROM retrieval_chunks_fts
                 INNER JOIN retrieval_chunks rc ON rc.id = retrieval_chunks_fts.rowid
                 WHERE retrieval_chunks_fts MATCH ?1
                   AND rc.entity_type = 'vault_note'
                   AND rc.project_root = ?2
                 ORDER BY rank
                 LIMIT 18",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![fts_query, vault_root], |row| {
                let rank = row.get::<_, f64>(8).unwrap_or(0.0) as f32;
                Ok(RetrievalCandidate {
                    chunk_id: row.get(0)?,
                    entity_type: row.get(1)?,
                    entity_id: row.get(2)?,
                    source_type: row.get(3)?,
                    chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    chunk_text: row.get(5)?,
                    project_root: row.get(6)?,
                    source_ts: row.get(7)?,
                    lexical_score: 1.0 / (1.0 + rank.abs()),
                    semantic_score: 0.0,
                    structured_score: 0.0,
                })
            })
            .map_err(|e| e.to_string())?;
        lexical.extend(rows.filter_map(|row| row.ok()));
    }

    let mut semantic = Vec::new();
    if route == "semantic" || route == "hybrid" {
        let query_embedding = with_embedder(app, DEFAULT_EMBED_MODEL, |model| {
            let inputs = vec![format!("query: {}", truncate_chars(query, MAX_CHUNK_CHARS))];
            let embeddings = model.embed(inputs, None).map_err(|e| e.to_string())?;
            embeddings
                .into_iter()
                .next()
                .ok_or_else(|| "Embedding model returned no query vector".to_string())
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT rc.id, rc.entity_type, rc.entity_id, rc.source_type, rc.chunk_summary, rc.chunk_text, rc.project_root, rc.source_ts, re.vector_json
                 FROM retrieval_embeddings re
                 INNER JOIN retrieval_chunks rc ON rc.id = re.chunk_id
                 WHERE rc.entity_type = 'vault_note'
                   AND rc.project_root = ?1
                   AND re.model_name = ?2
                 ORDER BY rc.source_ts DESC
                 LIMIT 800",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![vault_root, DEFAULT_EMBED_MODEL], |row| {
                let vector_json: String = row.get(8)?;
                Ok((
                    RetrievalCandidate {
                        chunk_id: row.get(0)?,
                        entity_type: row.get(1)?,
                        entity_id: row.get(2)?,
                        source_type: row.get(3)?,
                        chunk_summary: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        chunk_text: row.get(5)?,
                        project_root: row.get(6)?,
                        source_ts: row.get(7)?,
                        lexical_score: 0.0,
                        semantic_score: 0.0,
                        structured_score: 0.0,
                    },
                    vector_json,
                ))
            })
            .map_err(|e| e.to_string())?;

        for row in rows.filter_map(|row| row.ok()) {
            let (mut candidate, vector_json) = row;
            let Ok(vector) = serde_json::from_str::<Vec<f32>>(&vector_json) else {
                continue;
            };
            candidate.semantic_score = cosine_similarity(&query_embedding, &vector);
            semantic.push(candidate);
        }
        semantic.sort_by(|a, b| b.semantic_score.partial_cmp(&a.semantic_score).unwrap_or(std::cmp::Ordering::Equal));
        semantic.truncate(12);
    }

    let mut deduped: std::collections::HashMap<i64, RetrievalCandidate> = std::collections::HashMap::new();
    for mut candidate in structured.into_iter().chain(lexical.iter().cloned()).chain(semantic.iter().cloned()) {
        let overlap = lexical_overlap_score(
            &query_terms,
            &format!("{} {}", candidate.chunk_summary, candidate.chunk_text),
        );
        candidate.lexical_score = candidate.lexical_score.max(overlap);
        let entry = deduped.entry(candidate.chunk_id).or_insert_with(|| candidate.clone());
        entry.lexical_score = entry.lexical_score.max(candidate.lexical_score);
        entry.semantic_score = entry.semantic_score.max(candidate.semantic_score);
        entry.structured_score = entry.structured_score.max(candidate.structured_score);
    }

    let mut hits = deduped
        .into_values()
        .map(|candidate| {
            let route_multiplier = match route.as_str() {
                "semantic" => 0.55 * candidate.semantic_score + 0.25 * candidate.lexical_score + 0.20 * candidate.structured_score,
                "structured" => 0.55 * candidate.structured_score + 0.30 * candidate.lexical_score + 0.15 * candidate.semantic_score,
                "keyword" => 0.65 * candidate.lexical_score + 0.20 * candidate.structured_score + 0.15 * candidate.semantic_score,
                _ => 0.40 * candidate.semantic_score + 0.35 * candidate.lexical_score + 0.25 * candidate.structured_score,
            };
            let score = route_multiplier * 1.05;
            let summary = if candidate.chunk_summary.trim().is_empty() {
                make_summary(&candidate.chunk_text)
            } else {
                candidate.chunk_summary
            };
            RetrievalHit {
                chunk_id: candidate.chunk_id,
                entity_type: candidate.entity_type,
                entity_id: candidate.entity_id,
                source_type: candidate.source_type,
                summary,
                snippet: make_snippet(&candidate.chunk_text, 240),
                project_root: candidate.project_root,
                source_ts: candidate.source_ts,
                score,
            }
        })
        .collect::<Vec<_>>();

    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(max_hits.max(1));

    let prompt_lines = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            let rel_path = Path::new(&hit.entity_id)
                .strip_prefix(&canonical_vault)
                .ok()
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| hit.entity_id.clone());
            format!(
                "{}. {}\nPath: {}\nSnippet: {}",
                index + 1,
                hit.summary,
                rel_path,
                hit.snippet
            )
        })
        .collect::<Vec<_>>();

    Ok(HybridRetrievalContext {
        route,
        lexical_hits: lexical.len(),
        semantic_hits: semantic.len(),
        structured_hits: indexed_count as usize,
        prompt_context: if prompt_lines.is_empty() {
            "No markdown notes matched this vault query.".to_string()
        } else {
            format!("VAULT EVIDENCE:\n{}", prompt_lines.join("\n\n"))
        },
        hits,
    })
}

pub fn upsert_daily_summary(
    conn: &Connection,
    date_key: &str,
    summary_type: &str,
    summary_json: &str,
) -> Result<(), String> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO daily_summaries (date_key, summary_type, summary_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(date_key) DO UPDATE SET
           summary_type = excluded.summary_type,
           summary_json = excluded.summary_json,
           updated_at = excluded.updated_at",
        params![date_key, summary_type, summary_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn upsert_weekly_summary(
    conn: &Connection,
    week_key: &str,
    summary_type: &str,
    summary_json: &str,
) -> Result<(), String> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO weekly_summaries (week_key, summary_type, summary_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(week_key, summary_type) DO UPDATE SET
           summary_json = excluded.summary_json,
           updated_at = excluded.updated_at",
        params![week_key, summary_type, summary_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_top_apps(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT app_name, SUM(duration_seconds) AS total_seconds
             FROM activities
             WHERE start_time >= ?1 AND start_time < ?2
             GROUP BY app_name
             ORDER BY total_seconds DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, limit], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn collect_recent_chat_snippets(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT content
             FROM chat_messages
             WHERE created_at >= ?1 AND created_at < ?2 AND role = 'user'
             ORDER BY created_at DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, limit], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|row| row.ok())
        .map(|content| make_snippet(&content, 120))
        .filter(|snippet| !snippet.is_empty())
        .collect())
}

fn collect_diary_snippets(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT content
             FROM diary_entries
             WHERE updated_at >= ?1 AND updated_at < ?2
             ORDER BY updated_at DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, limit], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(|row| row.ok())
        .map(|content| make_snippet(&content, 140))
        .filter(|snippet| !snippet.is_empty())
        .collect())
}

fn collect_file_projects(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT project_root, COUNT(*) AS changes
             FROM code_file_events
             WHERE detected_at >= ?1 AND detected_at < ?2
             GROUP BY project_root
             ORDER BY changes DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, limit], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn count_for_range(conn: &Connection, table: &str, column: &str, start_ts: i64, end_ts: i64) -> Result<i64, String> {
    let sql = format!(
        "SELECT COUNT(*) FROM {table} WHERE {column} >= ?1 AND {column} < ?2"
    );
    conn.query_row(&sql, params![start_ts, end_ts], |row| row.get(0))
        .map_err(|e| e.to_string())
}

fn build_daily_summary_for_day(conn: &Connection, date_key: &str, start_ts: i64, end_ts: i64) -> Result<(), String> {
    let top_apps = collect_top_apps(conn, start_ts, end_ts, 5)?;
    let chat_count = count_for_range(conn, "chat_messages", "created_at", start_ts, end_ts)?;
    let diary_count = count_for_range(conn, "diary_entries", "updated_at", start_ts, end_ts)?;
    let file_count = count_for_range(conn, "code_file_events", "detected_at", start_ts, end_ts)?;
    let activity_count = count_for_range(conn, "activities", "start_time", start_ts, end_ts)?;
    let total_focus_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM activities WHERE start_time >= ?1 AND start_time < ?2",
            params![start_ts, end_ts],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let chat_snippets = collect_recent_chat_snippets(conn, start_ts, end_ts, 3)?;
    let diary_snippets = collect_diary_snippets(conn, start_ts, end_ts, 2)?;
    let file_projects = collect_file_projects(conn, start_ts, end_ts, 3)?;

    let summary_json = serde_json::json!({
        "dateKey": date_key,
        "activityCount": activity_count,
        "totalFocusSeconds": total_focus_seconds,
        "chatCount": chat_count,
        "diaryCount": diary_count,
        "fileCount": file_count,
        "topApps": top_apps.iter().map(|(app, seconds)| serde_json::json!({
            "app": app,
            "seconds": seconds,
        })).collect::<Vec<_>>(),
        "chatSnippets": chat_snippets,
        "diarySnippets": diary_snippets,
        "fileProjects": file_projects.iter().map(|(project, changes)| serde_json::json!({
            "projectRoot": project,
            "changes": changes,
        })).collect::<Vec<_>>(),
    });
    let summary_text = format!(
        "Daily summary for {date_key}\nTop apps: {}\nFocus time: {} minutes\nChat messages: {chat_count}\nDiary entries: {diary_count}\nFile changes: {file_count}\nRecent chat notes: {}\nDiary notes: {}\nProject activity: {}",
        if top_apps.is_empty() {
            "none".to_string()
        } else {
            top_apps
                .iter()
                .map(|(app, seconds)| format!("{app} ({}m)", ((*seconds + 59) / 60).max(1)))
                .collect::<Vec<_>>()
                .join(", ")
        },
        ((total_focus_seconds + 59) / 60).max(0),
        if chat_snippets.is_empty() { "none".to_string() } else { chat_snippets.join(" | ") },
        if diary_snippets.is_empty() { "none".to_string() } else { diary_snippets.join(" | ") },
        if file_projects.is_empty() {
            "none".to_string()
        } else {
            file_projects
                .iter()
                .map(|(project, changes)| format!("{project} ({changes} changes)"))
                .collect::<Vec<_>>()
                .join(", ")
        },
    );
    upsert_daily_summary(conn, date_key, "activity_digest", &summary_json.to_string())?;
    upsert_retrieval_chunk(
        conn,
        ChunkInput {
            entity_type: "daily_summary",
            entity_id: date_key,
            source_type: "summary_daily",
            chunk_text: &summary_text,
            chunk_summary: Some(format!("Daily summary for {date_key}")),
            project_root: None,
            source_ts: Some(start_ts),
        },
    )?;
    Ok(())
}

fn build_weekly_summary_for_week(conn: &Connection, week_key: &str, start_ts: i64, end_ts: i64) -> Result<(), String> {
    let top_apps = collect_top_apps(conn, start_ts, end_ts, 6)?;
    let chat_count = count_for_range(conn, "chat_messages", "created_at", start_ts, end_ts)?;
    let diary_count = count_for_range(conn, "diary_entries", "updated_at", start_ts, end_ts)?;
    let file_count = count_for_range(conn, "code_file_events", "detected_at", start_ts, end_ts)?;
    let activity_days: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT strftime('%Y-%m-%d', start_time, 'unixepoch', 'localtime'))
             FROM activities
             WHERE start_time >= ?1 AND start_time < ?2",
            params![start_ts, end_ts],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let total_focus_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM activities WHERE start_time >= ?1 AND start_time < ?2",
            params![start_ts, end_ts],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let diary_snippets = collect_diary_snippets(conn, start_ts, end_ts, 3)?;
    let file_projects = collect_file_projects(conn, start_ts, end_ts, 4)?;

    let summary_json = serde_json::json!({
        "weekKey": week_key,
        "activityDays": activity_days,
        "totalFocusSeconds": total_focus_seconds,
        "chatCount": chat_count,
        "diaryCount": diary_count,
        "fileCount": file_count,
        "topApps": top_apps.iter().map(|(app, seconds)| serde_json::json!({
            "app": app,
            "seconds": seconds,
        })).collect::<Vec<_>>(),
        "diarySnippets": diary_snippets,
        "fileProjects": file_projects.iter().map(|(project, changes)| serde_json::json!({
            "projectRoot": project,
            "changes": changes,
        })).collect::<Vec<_>>(),
    });
    let summary_text = format!(
        "Weekly summary for {week_key}\nActive days: {activity_days}\nTop apps: {}\nFocus time: {} hours\nChat messages: {chat_count}\nDiary entries: {diary_count}\nFile changes: {file_count}\nDiary themes: {}\nProject activity: {}",
        if top_apps.is_empty() {
            "none".to_string()
        } else {
            top_apps
                .iter()
                .map(|(app, seconds)| format!("{app} ({:.1}h)", *seconds as f64 / 3600.0))
                .collect::<Vec<_>>()
                .join(", ")
        },
        total_focus_seconds as f64 / 3600.0,
        if diary_snippets.is_empty() { "none".to_string() } else { diary_snippets.join(" | ") },
        if file_projects.is_empty() {
            "none".to_string()
        } else {
            file_projects
                .iter()
                .map(|(project, changes)| format!("{project} ({changes} changes)"))
                .collect::<Vec<_>>()
                .join(", ")
        },
    );
    upsert_weekly_summary(conn, week_key, "activity_digest", &summary_json.to_string())?;
    upsert_retrieval_chunk(
        conn,
        ChunkInput {
            entity_type: "weekly_summary",
            entity_id: week_key,
            source_type: "summary_weekly",
            chunk_text: &summary_text,
            chunk_summary: Some(format!("Weekly summary for {week_key}")),
            project_root: None,
            source_ts: Some(start_ts),
        },
    )?;
    Ok(())
}

fn refresh_recent_rollups(app: &AppHandle) -> Result<(), String> {
    let conn = crate::intent::db::open(app)?;

    for days_ago in 0..35i64 {
        let Some(start_ts) = local_day_start_ts(days_ago) else {
            continue;
        };
        let end_ts = local_day_start_ts(days_ago - 1).unwrap_or_else(|| Utc::now().timestamp());
        let Some(date_key) = date_key_from_ts(start_ts) else {
            continue;
        };
        build_daily_summary_for_day(&conn, &date_key, start_ts, end_ts)?;
    }

    for weeks_ago in 0..16i64 {
        let anchor = Utc::now().timestamp() - (weeks_ago * 7 * 86_400);
        let Some(local_dt) = chrono::DateTime::from_timestamp(anchor, 0).map(|dt| dt.with_timezone(&Local)) else {
            continue;
        };
        let weekday = local_dt.weekday().num_days_from_monday() as i64;
        let start_date = local_dt.date_naive() - ChronoDuration::days(weekday);
        let Some(start_naive) = start_date.and_hms_opt(0, 0, 0) else {
            continue;
        };
        let Some(start_ts) = Local.from_local_datetime(&start_naive).single().map(|dt| dt.timestamp()) else {
            continue;
        };
        let end_ts = start_ts + (7 * 86_400);
        let Some(week_key) = week_key_from_ts(start_ts) else {
            continue;
        };
        build_weekly_summary_for_week(&conn, &week_key, start_ts, end_ts)?;
    }

    Ok(())
}

pub fn start_rollup_worker(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let worker_handle = app_handle.clone();
            let result = tauri::async_runtime::spawn_blocking(move || refresh_recent_rollups(&worker_handle)).await;
            if let Ok(Err(error)) = result {
                eprintln!("[retrieval] rollup refresh failed: {error}");
            } else if let Err(error) = result {
                eprintln!("[retrieval] rollup worker join failed: {error}");
            }
            tokio::time::sleep(Duration::from_secs(ROLLUP_REFRESH_SECS)).await;
        }
    });
}

pub fn get_chunk_id(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    source_type: &str,
    chunk_text: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM retrieval_chunks WHERE entity_type = ?1 AND entity_id = ?2 AND source_type = ?3 AND chunk_text = ?4",
        params![entity_type, entity_id, source_type, chunk_text],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_chat_retrieval_filter, RetrievalCandidate};

    fn candidate(source_type: &str, entity_type: &str) -> RetrievalCandidate {
        RetrievalCandidate {
            chunk_id: 1,
            entity_type: entity_type.to_string(),
            entity_id: "entity-1".to_string(),
            source_type: source_type.to_string(),
            chunk_summary: "summary".to_string(),
            chunk_text: "text".to_string(),
            project_root: None,
            source_ts: Some(0),
            lexical_score: 0.0,
            semantic_score: 0.0,
            structured_score: 0.0,
        }
    }

    #[test]
    fn chat_filter_blocks_vault_chunks_without_files_source() {
        let selected_sources = vec!["apps".to_string(), "screen".to_string()];
        let filter = build_chat_retrieval_filter(Some(selected_sources.as_slice()));

        assert!(filter.allows(&candidate("activity_window", "activity")));
        assert!(!filter.allows(&candidate("vault_note_chunk", "note_chunk")));
    }

    #[test]
    fn chat_filter_excludes_chat_history_entities_even_when_files_enabled() {
        let selected_sources = vec!["files".to_string()];
        let filter = build_chat_retrieval_filter(Some(selected_sources.as_slice()));

        assert!(filter.allows(&candidate("vault_note_chunk", "note_chunk")));
        assert!(!filter.allows(&candidate("chat_assistant", "chat_message")));
    }
}
