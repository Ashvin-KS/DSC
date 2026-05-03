use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::models::{Settings, ActivityMetadata};
use tauri::Emitter;
use chrono::{Datelike, Duration, Local, TimeZone};
use std::time::Duration as StdDuration;

// ─── Constants ───

const MAX_TURNS: usize = 20;
const MAX_TOOL_RETRY_LOOPS: usize = 3;
const LLM_TIMEOUT_SECS: u64 = 60;

// ─── Types ───

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    stream: bool, // Enable streaming
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatRecvMessage,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct ChatRecvMessage {
    content: Option<String>,
    #[allow(dead_code)]
    reasoning_content: Option<String>,
}

// For streaming
#[derive(Deserialize)]
struct ChatStreamResponse {
    choices: Vec<ChatStreamChoice>,
}

#[derive(Deserialize)]
struct ChatStreamChoice {
    delta: ChatStreamDelta,
    #[serde(default)]
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatStreamDelta {
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

// ─── Agent Logic ───

// We define the agent tools and instructions here
const AGENT_SYSTEM_PROMPT: &str = r#"You are Atheletia's AI activity analyst — a smart, conversational assistant embedded inside the desktop app.
You have access to the user's activity history (apps, windows, duration, time) and OCR screen text.

## Your Tools
1. `get_music_history` - For finding songs/music
   - Args: hours (default 24), limit (default 50)
   - Returns formatted list of songs with title, artist, app, and time

2. `get_recent_activities` - For events/tasks/recent activity timeline
   - Args: hours (default 24), limit (default 100), category_id (optional)
   - Returns chronological activity events with app, title, category, duration, and time

3. `query_activities` - SQL queries on the `activities` table
   - Fields: app_name, window_title, start_time (unix timestamp), duration_seconds, category_id, metadata
   - metadata.media_info contains {title, artist, status} for music

4. `get_usage_stats` - Aggregated stats by app
   - Args: start_time_iso, end_time_iso

5. `search_ocr` - Search screen text content
   - Args: keyword, limit (default 100)

6. `get_recent_ocr` - Browse recent OCR captures (including chats) without exact keyword
   - Args: hours (default 24), limit (default 100), app (optional), keyword (optional)
   - Returns recent OCR snippets with app and timestamp

7. `get_recent_file_changes` - Recent code/document file changes from monitored project roots
   - Args: hours (default 24), limit (default 40), change_type (optional: created|modified|deleted)
   - Returns recent file change events with project root and timestamp

8. `parallel_search` - Run multiple tool calls in parallel for broader coverage
   - Args: calls = [{tool: "...", args: {...}}, ...]
   - Use for complex queries that need combining activity + OCR + music evidence quickly

9. `resolve_query_scope` - Widen the time range or request additional data sources
   - Args: suggested_scope (one of: "today", "yesterday", "last_3_days", "last_7_days", "last_30_days", "this_year", "all_time"), enable_sources (optional array of: "apps", "screen", "media", "browser", "files"), reason (string explaining why)
   - Use when user's query implies a different time range than what is currently selected (e.g. "few days back", "from the start", "not just today", "earlier")
   - Use when you need data sources that are not currently enabled
   - Returns a confirmation prompt to the user; after user confirms, the query re-runs with the new scope
   - ALWAYS use this tool when the user says things like "not just today", "days back", "from the start", "earlier", "before", "across days", "overall", "from few days", etc.

## Category IDs
- 1 = Development | 2 = Browser | 3 = Communication | 4 = Entertainment | 5 = Productivity | 6 = System | 7 = Other

## CRITICAL RULES
1. For music/song queries → Use get_music_history tool
2. For "what did I do", "events", "timeline", "recent activity" queries → Use get_recent_activities first
3. For time spent / top apps / summary queries → Use get_usage_stats or query_activities with SUM
4. For "what did I text", "WhatsApp chat", "what did I chat" queries → Use get_recent_ocr with app="whatsapp" first, then search_ocr if needed
5. For "show OCR data" queries → Use get_recent_ocr without keyword
6. NEVER give up after one query if results are empty - try different approaches
7. If a tool returns empty results, try a broader query or different keywords
8. For coding progress or project-change questions, use get_recent_file_changes.
9. For broad/ambiguous requests, prefer parallel_search with 2-3 tool calls
10. Use conversation history to resolve references like "it", "that", "the previous one", "what was it about".
11. Never claim facts without tool evidence from the requested time scope.
12. If evidence is weak or contradictory, ask a clarifying date/day question instead of guessing.
13. For "what am I hearing right now", rely only on very recent records marked as Playing.
14. For underspecified queries (missing source/app or time intent), ask a short clarifying question before searching.
15. If you are asked about people, names, or girls, use `search_ocr` with a high limit and try different keywords or no keywords at all to get all the data.
16. If you are asked about chats, use `get_recent_ocr` with a high limit and try different apps like "whatsapp", "instagram", "telegram", etc.
17. For person-identity queries (for example: "who is my crush"), never guess. Gather evidence using at least 2 distinct tools first; if evidence is weak or conflicting, ask a clarification question.
18. For any non-trivial factual query, fetch tool evidence before giving a final answer. If a final answer is attempted without evidence, call tools first.
19. Never claim the user texted/chatted someone unless there is explicit chat-app evidence (e.g., WhatsApp/Telegram/Instagram chat OCR/activity) in the current time scope.
20. For large-range summaries (like "this year" or "all time"), collect evidence in multiple compact aggregation steps (usage stats + grouped SQL rollups + focused slices) before writing the final answer.
21. For complex queries, especially those about people, relationships, or identifying someone (e.g., "who is my crush"), you MUST make a minimum of 5 distinct tool calls to gather comprehensive evidence across different apps, timeframes, and contexts before providing a final answer. Do not jump to conclusions based on limited recent data.
22. If the user asks a general question about habits, preferences, relationships, history, or asks "when", "how often", "first time", "ever" AND the current scope is narrow (like "Today" or "Last 7 Days"), you MUST call `resolve_query_scope` IMMEDIATELY as your first tool call to widen the scope to "last_30_days" or "all_time". Do NOT attempt to answer general or historical questions with just a few days of data. Also use this tool if the user's query implies a time range broader than the current scope (e.g., "few days back", "not just today", "earlier", "from the start", "before", "overall", "from the beginning", "across days", "the other day", "days ago", "recently" when scope is Today).
23. If you detect the user needs data from sources that are not currently enabled (e.g., asking about files but Files source is disabled, or asking about browser history but Browser source is disabled), call `resolve_query_scope` with the required enable_sources array so the user can enable them.
24. If the grounded retrieval pack already answers the question, synthesize from it instead of making redundant tool calls.

## Response Format
Output JSON for tool calls: { "tool": "tool_name", "args": { ... }, "reasoning": "..." }
Output detailed, crisp, and highly specific final answers. Use markdown (like bolding and bullet points) to make the answer easy to read.
For final answers, include:
- A direct answer first
- Evidence bullets with specific app/window/title + timestamp
- A short confidence statement
- If evidence is incomplete, explicitly say what is missing
Do not be overly brief for non-trivial queries.

Do NOT output markdown code blocks for tool calls. Output RAW JSON only.

## Thinking Quality Rules
- If reasoning content is emitted, keep it user-facing and concise (max 1 short sentence).
- Never include internal planning language such as "the user is asking", "I should", "let me", "likely", or tool-selection analysis.
- Never echo raw tool-call JSON inside thinking text.
- Bad example: "The user says now? Likely they want..."
- Good example: "Checking your recent music activity now."
"#;

#[derive(Deserialize, Serialize, Debug)]
#[serde(untagged)]
enum AgentResponse {
    ToolCall {
        tool: String,
        args: Value,
        #[allow(dead_code)]
        reasoning: Option<String>,
    },
    // If it's not a tool call, we treat it as a final answer string
    FinalAnswer(String),
}

#[derive(Clone, Debug)]
struct TimeScope {
    id: String,
    label: String,
    start_ts: i64,
    end_ts: i64,
}

#[derive(Clone, Debug, Default)]
struct QueryIntent {
    wants_music: bool,
    wants_ocr: bool,
    wants_files: bool,
    wants_timeline: bool,
    broad_summary: bool,
}

#[derive(Clone, Debug)]
struct ChatSourceScope {
    apps: bool,
    screen: bool,
    media: bool,
    browser: bool,
    files: bool,
}

impl Default for ChatSourceScope {
    fn default() -> Self {
        Self {
            apps: true,
            screen: true,
            media: true,
            browser: false,
            files: false,
        }
    }
}

impl ChatSourceScope {
    // Retrieval boundary policy: Chat stays activity-first. File and vault-note evidence
    // is only allowed when the Files source is explicitly enabled.
    fn from_selection(selected_sources: Option<&[String]>) -> Self {
        let Some(selected_sources) = selected_sources else {
            return Self::default();
        };
        if selected_sources.is_empty() {
            return Self::default();
        }

        let mut scope = Self {
            apps: false,
            screen: false,
            media: false,
            browser: false,
            files: false,
        };

        for source in selected_sources {
            match source.trim().to_lowercase().as_str() {
                "apps" => scope.apps = true,
                "screen" => scope.screen = true,
                "media" => scope.media = true,
                "browser" => scope.browser = true,
                "files" => scope.files = true,
                _ => {}
            }
        }

        scope
    }

    fn is_enabled_source_id(&self, source_id: &str) -> bool {
        match source_id {
            "apps" => self.apps,
            "screen" => self.screen,
            "media" => self.media,
            "browser" => self.browser,
            "files" => self.files,
            _ => false,
        }
    }

    fn enabled_ids(&self) -> Vec<String> {
        crate::intent::retrieval::CHAT_SOURCE_IDS
            .iter()
            .copied()
            .filter(|source_id| self.is_enabled_source_id(source_id))
            .map(|source_id| source_id.to_string())
            .collect()
    }

    fn disabled_ids(&self) -> Vec<&'static str> {
        crate::intent::retrieval::CHAT_SOURCE_IDS
            .iter()
            .copied()
            .filter(|source_id| !self.is_enabled_source_id(source_id))
            .collect()
    }

    fn missing_sources_for_tool(&self, tool: &str) -> Vec<String> {
        match tool {
            "get_recent_activities" | "get_usage_stats" | "query_activities" if !self.apps => vec!["apps".to_string()],
            "search_ocr" | "get_recent_ocr" if !self.screen => vec!["screen".to_string()],
            "get_music_history" if !self.media => vec!["media".to_string()],
            "get_recent_file_changes" if !self.files => vec!["files".to_string()],
            _ => Vec::new(),
        }
    }
}

fn missing_sources_for_query(source_scope: &ChatSourceScope, query: &str, intent: &QueryIntent) -> Vec<String> {
    let q = query.to_lowercase();
    let mut required_sources: Vec<&str> = Vec::new();
    let mut push_required = |source_id: &'static str| {
        if !required_sources.iter().any(|existing| existing == &source_id) {
            required_sources.push(source_id);
        }
    };

    if intent.wants_timeline
        || q.contains("app ")
        || q.contains("application")
        || q.contains("window")
    {
        push_required("apps");
    }
    if intent.wants_ocr {
        push_required("screen");
    }
    if intent.wants_music {
        push_required("media");
    }
    if intent.wants_files {
        push_required("files");
    }
    if q.contains("browser history")
        || q.contains("website")
        || q.contains("websites")
        || q.contains("url")
        || q.contains("tab")
        || q.contains("tabs")
        || q.contains("visited")
        || q.contains("search history")
        || q.contains("google")
        || q.contains("youtube")
    {
        push_required("browser");
    }

    required_sources
        .into_iter()
        .filter(|source_id| !source_scope.is_enabled_source_id(source_id))
        .map(|source_id| source_id.to_string())
        .collect()
}

// ─── Public API ───

#[allow(dead_code)]
pub async fn run_agentic_search(
    app_handle: &tauri::AppHandle,
    user_query: &str,
    settings: &Settings,
) -> Result<String, String> {
    // Delegate to the step-tracking version, just return the answer
    let result = run_agentic_search_with_steps_and_scope(app_handle, user_query, settings, None).await?;
    Ok(result.answer)
}

// ─── Structured Agent Result (for Chat UI) ───

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentStep {
    pub turn: usize,
    pub tool_name: String,
    pub tool_args: Value,
    pub tool_result: String,
    pub reasoning: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentResult {
    pub answer: String,
    pub steps: Vec<AgentStep>,
    pub activities_referenced: Vec<Value>,
}

#[allow(dead_code)]
pub async fn run_agentic_search_with_steps(
    app_handle: &tauri::AppHandle,
    user_query: &str,
    settings: &Settings,
) -> Result<AgentResult, String> {
    run_agentic_search_with_steps_and_scope(app_handle, user_query, settings, None).await
}

#[allow(dead_code)]
pub async fn run_agentic_search_with_steps_and_scope(
    app_handle: &tauri::AppHandle,
    user_query: &str,
    settings: &Settings,
    time_scope: Option<&str>,
) -> Result<AgentResult, String> {
    run_agentic_search_with_steps_and_history_and_scope(
        app_handle,
        user_query,
        settings,
        &[],
        time_scope,
        None,
    ).await
}

#[allow(dead_code)]
pub async fn run_agentic_search_with_steps_and_history(
    app_handle: &tauri::AppHandle,
    user_query: &str,
    settings: &Settings,
    prior_messages: &[ChatMessage],
) -> Result<AgentResult, String> {
    run_agentic_search_with_steps_and_history_and_scope(
        app_handle,
        user_query,
        settings,
        prior_messages,
        None,
        None,
    ).await
}

pub async fn run_agentic_search_with_steps_and_history_and_scope(
    app_handle: &tauri::AppHandle,
    user_query: &str,
    settings: &Settings,
    prior_messages: &[ChatMessage],
    time_scope: Option<&str>,
    selected_sources: Option<&[String]>,
) -> Result<AgentResult, String> {
    let api_key = crate::utils::config::resolve_api_key(&settings.ai.api_key);
    let model = &settings.ai.model;
    let provider = &settings.ai.provider;
    let use_local_llm = settings.ai.local_only
        || settings.ai.provider.to_lowercase() == "local"
        || settings.ai.provider.to_lowercase() == "lmstudio";
    let lmstudio_url = settings.ai.lmstudio_url.as_deref();

    if !use_local_llm && api_key.is_empty() {
        return Err("AI is disabled or API key is missing".to_string());
    }

    let db_path = crate::intent::db::db_path(app_handle)?;
    
    let mut steps: Vec<AgentStep> = Vec::new();
    let mut all_activities: Vec<Value> = Vec::new();
    let resolved_scope = resolve_time_scope(time_scope);
    let intent = detect_query_intent(user_query);
    let active_sources = ChatSourceScope::from_selection(selected_sources);
    let enabled_source_ids = active_sources.enabled_ids();
    let disabled_source_ids = active_sources.disabled_ids();
    let missing_query_sources = missing_sources_for_query(&active_sources, user_query, &intent);

    if !missing_query_sources.is_empty() {
        let reason = format!(
            "This request needs additional sources before Chat can answer reliably: {}.",
            missing_query_sources.join(", ")
        );
        let tool_args = serde_json::json!({
            "suggested_scope": resolved_scope.id,
            "enable_sources": missing_query_sources,
            "reason": reason,
        });
        let payload = serde_json::json!({
            "kind": "confirm_scope_or_sources",
            "reason": reason,
            "suggested_time_range": resolved_scope.id,
            "enable_sources": tool_args["enable_sources"].clone(),
            "retry_message": user_query,
        });

        steps.push(AgentStep {
            turn: 1,
            tool_name: "resolve_query_scope".to_string(),
            tool_args,
            tool_result: "Blocked before retrieval because the required Chat sources are disabled.".to_string(),
            reasoning: "Requesting source confirmation before searching.".to_string(),
        });

        return Ok(AgentResult {
            answer: format!(
                "I need additional sources enabled before I can answer that.\n\n[[IF_ACTION:{}]]",
                payload
            ),
            steps,
            activities_referenced: Vec::new(),
        });
    }
    
    // Initial messages
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: AGENT_SYSTEM_PROMPT.to_string(),
    }];

    // Include recent chat history so follow-up questions keep context.
    for msg in prior_messages.iter().rev().take(6).rev() {
        if msg.content.trim().is_empty() {
            continue;
        }
        let role = if msg.role.eq_ignore_ascii_case("assistant") {
            "assistant"
        } else {
            "user"
        };
        messages.push(ChatMessage {
            role: role.to_string(),
            content: truncate_for_token_limit(&msg.content, 4000),
        });
    }

    let needs_broad_scope = requires_broad_scope(user_query);
    let scope_warning = if needs_broad_scope && (resolved_scope.id == "today" || resolved_scope.id == "yesterday" || resolved_scope.id == "last_3_days" || resolved_scope.id == "last_7_days") {
        "\nCRITICAL: Your current search scope is narrow, but the user's query requires historical data, aggregation, or general knowledge about their habits/relationships. You MUST call `resolve_query_scope` immediately to widen the scope to 'last_30_days' or 'all_time' before doing anything else."
    } else {
        ""
    };

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: format!(
            "User query: \"{}\"\nCurrent Time: {}\nSelected Time Scope: {} ({} to {})\nAlways keep retrieval strictly inside this scope unless the user asks to change it. If you need to search for people, names, or girls, use `search_ocr` with a high limit and try different keywords or no keywords at all to get all the data. If you need to search for chats, use `get_recent_ocr` with a high limit and try different apps like \"whatsapp\", \"instagram\", \"telegram\", etc.{}",
            user_query,
            chrono::Local::now().to_rfc3339(),
            resolved_scope.label,
            format_time_scope_ts(resolved_scope.start_ts),
            format_time_scope_ts(resolved_scope.end_ts),
            scope_warning
        ),
    });

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: format!(
            "Enabled data sources: {}.\nDisabled data sources: {}.\nDo not call tools that require disabled sources. Files is the only bridge that allows note/file evidence into Chat. Recent chat turns are follow-up context only, not evidence.",
            if enabled_source_ids.is_empty() { "none".to_string() } else { enabled_source_ids.join(", ") },
            if disabled_source_ids.is_empty() { "none".to_string() } else { disabled_source_ids.join(", ") }
        ),
    });

    if let Ok(Ok(hybrid_context)) = tauri::async_runtime::spawn_blocking({
        let app = app_handle.clone();
        let query = user_query.to_string();
        let start_ts = resolved_scope.start_ts;
        let end_ts = resolved_scope.end_ts;
        let selected_sources = enabled_source_ids.clone();
        move || {
            let filter = crate::intent::retrieval::build_chat_retrieval_filter(Some(selected_sources.as_slice()));
            crate::intent::retrieval::build_hybrid_context(&app, &query, start_ts, end_ts, 15, Some(&filter))
        }
    }).await {
        if !hybrid_context.hits.is_empty() {
            steps.push(AgentStep {
                turn: 0,
                tool_name: "hybrid_retrieval".to_string(),
                tool_args: serde_json::json!({
                    "route": hybrid_context.route,
                    "scope": resolved_scope.id,
                    "start_ts": resolved_scope.start_ts,
                    "end_ts": resolved_scope.end_ts,
                    "max_hits": hybrid_context.hits.len(),
                }),
                tool_result: truncate_for_token_limit(&hybrid_context.prompt_context, 12000),
                reasoning: "Prefetched normalized retrieval chunks using lexical, structured, and semantic ranking.".to_string(),
            });

            all_activities.extend(hybrid_context.hits.iter().map(|hit| {
                serde_json::json!({
                    "app": hit.source_type,
                    "title": hit.summary,
                    "time": hit.source_ts,
                    "duration_seconds": 0,
                    "category": "hybrid_retrieval",
                    "entity_type": hit.entity_type,
                    "entity_id": hit.entity_id,
                    "score": hit.score,
                })
            }));
            dedupe_activities(&mut all_activities);

            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Grounded retrieval pack for this question (route: {}, lexical_hits: {}, semantic_hits: {}, structured_hits: {}):\n{}\nUse this evidence first, then call more tools only if there are clear gaps or conflicts.",
                    hybrid_context.route,
                    hybrid_context.lexical_hits,
                    hybrid_context.semantic_hits,
                    hybrid_context.structured_hits,
                    truncate_for_token_limit(&hybrid_context.prompt_context, 12000)
                ),
            });
        }
    }

    let use_long_range_pipeline = should_use_long_range_pipeline(user_query, &resolved_scope, &intent);
    if use_long_range_pipeline {
        let _ = app_handle.emit("chat://status", "Building long-range evidence (multi-step)...");
        if let Ok((pipeline_steps, pipeline_activities, digest)) =
            run_long_range_summary_pipeline(&db_path, &resolved_scope, &intent, &active_sources, user_query)
        {
            let start_turn = steps.len();
            for (idx, mut step) in pipeline_steps.into_iter().enumerate() {
                step.turn = start_turn + idx + 1;
                steps.push(step);
            }
            if !pipeline_activities.is_empty() {
                all_activities.extend(pipeline_activities);
                dedupe_activities(&mut all_activities);
                if !intent.wants_music {
                    all_activities.retain(|item| !is_media_activity_ref(item));
                }
            }
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Pre-aggregated long-range evidence:\n{}\nUse this structured evidence first. Only call extra tools if there are clear gaps.",
                    truncate_for_token_limit(&digest, 15000)
                ),
            });
        }
    } else if intent.broad_summary {
        let prefetch_args = build_prefetch_parallel_args(&resolved_scope, &intent, &active_sources);
        if let Ok((prefetch_output, prefetch_activities)) =
            execute_parallel_search(&db_path, &prefetch_args, Some(&resolved_scope), Some(&active_sources), user_query)
        {
            if !prefetch_activities.is_empty() {
                all_activities.extend(prefetch_activities);
            }
            steps.push(AgentStep {
                turn: 0,
                tool_name: "parallel_search".to_string(),
                tool_args: prefetch_args,
                tool_result: truncate_for_token_limit(&prefetch_output, 15000),
                reasoning: "Prefetch evidence for broad multi-source summary".to_string(),
            });
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Prefetched evidence before tool-planning:\n{}",
                    truncate_for_token_limit(&prefetch_output, 15000)
                ),
            });
        }
    }

    let must_validate_with_tools = requires_evidence_for_query(user_query);
    let mut final_without_evidence_attempts = 0usize;
    let mut forced_parallel_runs = 0usize;

    for turn in 0..MAX_TURNS {
        let _ = app_handle.emit("chat://status", format!("Thinking (step {}/{})", turn + 1, MAX_TURNS));
        // 1. Call LLM with streaming callback
        // We accumulate the full content here, while also streaming it to the frontend
        let mut full_response = String::new();
        let mut decision_made = false;
        let mut suppress_stream = false;
        let mut sniff = String::new();
        // Callback to handle streaming chunks
        let on_token = |chunk: &str| {
            sniff.push_str(chunk);
            if !decision_made && sniff.trim_start().len() >= 6 {
                decision_made = true;
            }
            if sniff.contains("\"tool\"") && sniff.contains("\"args\"") {
                suppress_stream = true;
            }
            // Suppress any content containing "reasoning" key — this is always from tool-call JSON
            if sniff.contains("\"reasoning\"") {
                suppress_stream = true;
            }
            if contains_internal_tool_markup(&sniff) {
                suppress_stream = true;
            }

            if !suppress_stream {
                let cleaned = strip_internal_stream_markup(chunk);
                if !cleaned.trim().is_empty() {
                    let _ = app_handle.emit("chat://token", &cleaned);
                }
            }
        };

        call_llm_stream_with_provider(&provider, model, &api_key, use_local_llm, lmstudio_url, &messages, &mut full_response, on_token).await?;

        // 2. Parse Response
        let parsed_response = try_parse_tool_call_response(&full_response)
            .unwrap_or_else(|| AgentResponse::FinalAnswer(full_response.clone()));

        // 3. Handle Action
        match parsed_response {
            AgentResponse::FinalAnswer(answer) => {
                let cleaned_answer = strip_internal_stream_markup(&answer)
                    .replace("<think>", "")
                    .replace("</think>", "");
                let normalized = normalize_final_answer_hardened(&cleaned_answer);
                let normalized = scrub_unsupported_communication_claims(&normalized, user_query, &steps);
                if must_validate_with_tools && steps.is_empty() && forced_parallel_runs < 2 {
                    let forced_args = build_forced_validation_parallel_args(&resolved_scope, &intent, &active_sources, user_query);
                    let (out, activities) = execute_parallel_search(
                        &db_path,
                        &forced_args,
                        Some(&resolved_scope),
                        Some(&active_sources),
                        user_query,
                    )?;
                    forced_parallel_runs += 1;
                    if !activities.is_empty() {
                        all_activities.extend(activities);
                        dedupe_activities(&mut all_activities);
                    }
                    let truncated = truncate_for_token_limit(&out, 20000);
                    steps.push(AgentStep {
                        turn: turn + 1,
                        tool_name: "parallel_search".to_string(),
                        tool_args: forced_args,
                        tool_result: truncated.clone(),
                        reasoning: "Forced evidence validation before final answer".to_string(),
                    });
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: full_response.clone(),
                    });
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: format!(
                            "You attempted to answer without evidence. Use this forced evidence and continue with additional tool calls if needed:\n{}",
                            truncate_for_token_limit(&truncated, 15000)
                        ),
                    });
                    continue;
                }
                if contains_internal_tool_markup(&normalized) && turn + 1 < MAX_TURNS {
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: full_response.clone(),
                    });
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: "Your last response leaked internal tool-call markup. Re-emit either valid RAW JSON tool call {\"tool\":\"...\",\"args\":{...}} or a normal final answer. Never output internal markers like <|tool_call_begin|>.".to_string(),
                    });
                    continue;
                }
                
                let is_complex_query = user_query.to_lowercase().contains("who") || user_query.to_lowercase().contains("crush") || user_query.to_lowercase().contains("relationship");
                if is_complex_query && steps.len() < 5 && turn + 1 < MAX_TURNS {
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: full_response.clone(),
                    });
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: format!("You have only made {} tool calls. For this type of query, you MUST make at least 5 distinct tool calls to gather comprehensive evidence before answering. Please make another tool call.", steps.len()),
                    });
                    continue;
                }

                if !has_minimum_evidence_for_query(user_query, &steps) {
                    final_without_evidence_attempts += 1;
                    if must_validate_with_tools && final_without_evidence_attempts >= 2 && forced_parallel_runs < 2 {
                        let forced_args = build_forced_validation_parallel_args(&resolved_scope, &intent, &active_sources, user_query);
                        let (out, activities) = execute_parallel_search(
                            &db_path,
                            &forced_args,
                            Some(&resolved_scope),
                            Some(&active_sources),
                            user_query,
                        )?;
                        forced_parallel_runs += 1;
                        if !activities.is_empty() {
                            all_activities.extend(activities);
                            dedupe_activities(&mut all_activities);
                        }
                        let truncated = truncate_for_token_limit(&out, 20000);
                        steps.push(AgentStep {
                            turn: turn + 1,
                            tool_name: "parallel_search".to_string(),
                            tool_args: forced_args,
                            tool_result: truncated.clone(),
                            reasoning: "Forced cross-tool evidence after weak finalization attempt".to_string(),
                        });
                        messages.push(ChatMessage {
                            role: "assistant".to_string(),
                            content: full_response.clone(),
                        });
                        messages.push(ChatMessage {
                            role: "user".to_string(),
                            content: format!(
                                "Your answer was not sufficiently evidenced. Continue using this tool output and fetch more if needed:\n{}",
                                truncate_for_token_limit(&truncated, 15000)
                            ),
                        });
                        continue;
                    }
                    if turn + 1 < MAX_TURNS {
                        messages.push(ChatMessage {
                            role: "assistant".to_string(),
                            content: full_response.clone(),
                        });
                        messages.push(ChatMessage {
                            role: "user".to_string(),
                            content: "Do not finalize yet. First gather stronger evidence with multiple relevant tools (for example OCR + activity/chat/file-change tools), then answer only from that evidence. If evidence is still weak, say so explicitly and ask a clarifying question.".to_string(),
                        });
                        continue;
                    }
                    let _ = app_handle.emit("chat://done", "final_answer");
                    let action_marker = build_insufficient_evidence_action_marker(user_query, &resolved_scope);
                    return Ok(AgentResult {
                        answer: format!(
                            "I don't have enough cross-checked evidence to answer confidently. Try widening the time range (Last 7 Days or All Time) and enabling Browser History / Files & Documents, then ask me to retry.{}",
                            action_marker
                        ),
                        steps,
                        activities_referenced: all_activities,
                    });
                }
                // Done!
                let _ = app_handle.emit("chat://done", "final_answer");
                return Ok(AgentResult {
                    answer: normalized,
                    steps,
                    activities_referenced: all_activities,
                });
            }
            AgentResponse::ToolCall { tool, args, reasoning } => {
                // Handle resolve_query_scope as a special case — it returns a user-facing action prompt
                if tool == "resolve_query_scope" {
                    let suggested_scope = args["suggested_scope"].as_str().unwrap_or("last_7_days");
                    let reason = args["reason"].as_str().unwrap_or("Your query requires a wider search range.");
                    let enable_sources: Vec<String> = args.get("enable_sources")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();

                    steps.push(AgentStep {
                        turn: turn + 1,
                        tool_name: "resolve_query_scope".to_string(),
                        tool_args: args.clone(),
                        tool_result: format!("Requesting scope change to {} with sources {:?}", suggested_scope, enable_sources),
                        reasoning: reasoning.as_deref().unwrap_or("").to_string(),
                    });

                    let payload = serde_json::json!({
                        "kind": "confirm_scope_or_sources",
                        "reason": reason,
                        "suggested_time_range": suggested_scope,
                        "enable_sources": enable_sources,
                        "retry_message": user_query
                    });

                    let _ = app_handle.emit("chat://done", "final_answer");
                    return Ok(AgentResult {
                        answer: format!(
                            "I can answer this more accurately after your confirmation.\n\n[[IF_ACTION:{}]]",
                            payload
                        ),
                        steps,
                        activities_referenced: all_activities,
                    });
                }

                let missing_sources = active_sources.missing_sources_for_tool(&tool);
                if !missing_sources.is_empty() {
                    steps.push(AgentStep {
                        turn: turn + 1,
                        tool_name: "resolve_query_scope".to_string(),
                        tool_args: serde_json::json!({
                            "suggested_scope": resolved_scope.id,
                            "enable_sources": missing_sources,
                            "reason": format!("{} needs a disabled source in the current Chat filter.", tool),
                        }),
                        tool_result: format!("Blocked {} because it needs disabled sources.", tool),
                        reasoning: reasoning.as_deref().unwrap_or("").to_string(),
                    });

                    let payload = serde_json::json!({
                        "kind": "confirm_scope_or_sources",
                        "reason": format!("This request needs additional sources before {} can run.", tool),
                        "suggested_time_range": resolved_scope.id,
                        "enable_sources": active_sources.missing_sources_for_tool(&tool),
                        "retry_message": user_query
                    });

                    let _ = app_handle.emit("chat://done", "final_answer");
                    return Ok(AgentResult {
                        answer: format!(
                            "I need one more data source before I can continue.\n\n[[IF_ACTION:{}]]",
                            payload
                        ),
                        steps,
                        activities_referenced: all_activities,
                    });
                }

                let enforced_args = enforce_tool_args_with_scope(&tool, &args, &resolved_scope, user_query);
                println!("[Agent] Turn {}: Calling {} ({:?})", turn + 1, tool, enforced_args);
                let _ = app_handle.emit("chat://status", format!("Running {}", tool));
                // Notify frontend of agent step (tool call) start?
                // For now, frontend just sees tokens.
                
                // Add assistant message to history
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: full_response.clone(),
                });

                // Execute tool with bounded retry loops and optional parallelization
                let (tool_output, tool_activities, attempts_used) = if tool == "parallel_search" {
                    let parallel_count = enforced_args
                        .get("calls")
                        .and_then(|v| v.as_array())
                        .map(|v| v.len())
                        .unwrap_or(0);
                    let _ = app_handle.emit(
                        "chat://status",
                        format!("Running {} searches in parallel", parallel_count),
                    );
                    let (out, activities) = execute_parallel_search(
                        &db_path,
                        &enforced_args,
                        Some(&resolved_scope),
                        Some(&active_sources),
                        user_query,
                    )?;
                    (out, activities, 1usize)
                } else {
                    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
                    execute_tool_with_retries(&conn, &tool, &enforced_args, MAX_TOOL_RETRY_LOOPS)?
                };

                // Add activities from tool result to referenced activities
                all_activities.extend(transform_activities_for_frontend(&tool, &tool_activities));
                dedupe_activities(&mut all_activities);
                if !intent.wants_music {
                    all_activities.retain(|item| !is_media_activity_ref(item));
                }
                let _ = app_handle.emit(
                    "chat://status",
                    format!("{} completed ({} referenced items)", tool, tool_activities.len())
                );
                
                // Truncate output if too long to save tokens
                let with_retry_note = if attempts_used > 1 {
                    format!(
                        "Auto-retried with broader search {} time(s).\n{}",
                        attempts_used - 1,
                        tool_output
                    )
                } else {
                    tool_output
                };
                let truncated_output = truncate_for_token_limit(&with_retry_note, 25000);
                
                // Record step
                steps.push(AgentStep {
                    turn: turn + 1,
                    tool_name: tool.clone(),
                    tool_args: enforced_args.clone(),
                    tool_result: truncated_output.clone(),
                    reasoning: reasoning.as_deref().unwrap_or("").to_string(),
                });

                // Add tool output to history
                messages.push(ChatMessage {
                    role: "user".to_string(),
                    content: format!("<TOOL_RESULT>\n{}\n</TOOL_RESULT>", truncated_output),
                });
            }
        }
    }

    let _ = app_handle.emit("chat://status", "Finalizing answer from gathered evidence...");
    let answer = synthesize_answer_from_evidence(
        app_handle,
        &provider,
        model,
        &api_key,
        use_local_llm,
        lmstudio_url,
        user_query,
        &resolved_scope,
        &steps,
        &all_activities,
    ).await.unwrap_or_else(|_| "I checked your activity and found partial evidence, but not enough for a fully confident answer. Ask with a specific date/app and I will give exact details.".to_string());
    Ok(AgentResult { answer, steps, activities_referenced: all_activities })
}

// ─── Tool Execution ───

include!("query_engine_execution_helpers.incl.rs");
fn execute_tool(conn: &Connection, tool: &str, args: &Value) -> Result<(String, Vec<Value>), String> {
    match tool {
        // Dedicated music history tool - finds songs from Spotify, YouTube, etc.
        "get_music_history" => {
            let limit = args["limit"].as_u64().unwrap_or(100) as i32;
            let hours = args["hours"].as_u64().unwrap_or(24) as i64;
            let scan_limit = std::cmp::max(limit.saturating_mul(20), 500);
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            let scope_label = args["scope_label"].as_str().unwrap_or("the selected time range");
            
            // Query a broad slice of recent activity and filter by media_info in Rust.
            // Music can be present while the active app is not an entertainment app.
            let mut stmt = conn.prepare(
                "SELECT app_name, window_title, start_time, duration_seconds, metadata, category_id
                 FROM activities 
                 WHERE start_time >= ?1 AND start_time <= ?2 AND metadata IS NOT NULL
                 ORDER BY start_time DESC 
                 LIMIT ?3"
            ).map_err(|e| format!("SQL Error: {}", e))?;
            
            let rows = stmt.query_map(rusqlite::params![start_ts, end_ts, scan_limit], |row| {
                let app_name: String = row.get(0)?;
                let window_title: String = row.get(1)?;
                let start_time: i64 = row.get(2)?;
                let duration_seconds: i32 = row.get(3)?;
                let metadata_blob: Option<Vec<u8>> = row.get(4)?;
                let category_id: i32 = row.get(5)?;
                
                // Parse metadata to extract media_info
                let media_info = if let Some(blob) = &metadata_blob {
                    if let Ok(meta) = serde_json::from_slice::<ActivityMetadata>(blob) {
                        meta.media_info
                    } else {
                        None
                    }
                } else {
                    None
                };
                
                Ok(serde_json::json!({
                    "app_name": app_name,
                    "window_title": window_title,
                    "start_time": start_time,
                    "duration_seconds": duration_seconds,
                    "media_info": media_info,
                    "category_id": category_id
                }))
            }).map_err(|e| e.to_string())?;
            
            let mut results: Vec<Value> = Vec::new();
            let mut seen_songs: std::collections::HashSet<String> = std::collections::HashSet::new();
            
            for r in rows {
                if let Ok(val) = r {
                    let app_name = val.get("app_name").and_then(|a| a.as_str()).unwrap_or("");
                    
                    // Check if it's Spotify by checking raw bytes (handles encoding issues)
                    // Spotify app name can be "Spotify\u00008\u0016\u0001FileV" with embedded nulls
                    let is_spotify = app_name.as_bytes().windows(7).any(|w| w == b"Spotify") ||
                                     app_name.starts_with("Spotify");
                    
                    // Get media info to check if it's actual music
                    let media = val.get("media_info").and_then(|m| m.as_object());
                    let title = media.as_ref().and_then(|m| m.get("title"))
                        .and_then(|t| t.as_str()).unwrap_or("");
                    let artist = media.as_ref().and_then(|m| m.get("artist"))
                        .and_then(|a| a.as_str()).unwrap_or("");
                    
                    // Structurally validate: valid music must have both title AND artist.
                    // This replaces the previous hardcoded video keyword list.
                    let is_song = !title.is_empty() && !artist.is_empty();
                    
                    // Create a unique key for deduplication
                    let song_key = format!("{}-{}", title, artist);
                    
                    // Include if:
                    // 1. It's Spotify with media info, OR
                    // 2. It has media info that looks structurally like a song
                    // And we haven't seen this song before (dedupe)
                    let should_include = (is_spotify && media.is_some()) || 
                                         (media.is_some() && is_song);
                    
                    if should_include && !seen_songs.contains(&song_key) {
                        seen_songs.insert(song_key);
                        results.push(val);
                        if results.len() as i32 >= limit {
                            break;
                        }
                    }
                }
            }
            
            // Create activity references for frontend (transform to expected format)
            let activity_refs: Vec<Value> = results.iter().map(|track| {
                let media = track.get("media_info").and_then(|m| m.as_object());
                let category_id = track.get("category_id").and_then(|v| v.as_i64()).unwrap_or(4);
                let category_name = category_name_from_id(category_id);
                // Normalize app name for display (handle Spotify encoding issues)
                let app_raw = track.get("app_name").and_then(|a| a.as_str()).unwrap_or("");
                let is_spotify = app_raw.as_bytes().windows(7).any(|w| w == b"Spotify") || app_raw.starts_with("Spotify");
                let app_display = if is_spotify {
                    "Spotify"
                } else if app_raw.to_lowercase().contains("youtube") {
                    "YouTube"
                } else {
                    app_raw
                };
                serde_json::json!({
                    "app": app_display,
                    "title": track.get("window_title").and_then(|t| t.as_str()).unwrap_or(""),
                    "time": track.get("start_time").and_then(|t| t.as_i64()).unwrap_or(0),
                    "duration_seconds": track.get("duration_seconds").and_then(|d| d.as_i64()).unwrap_or(0),
                    "category": category_name,
                    "media": media.cloned()
                })
            }).collect();
            
                                    // Format for chat display in plain text (no markdown markers)
            let formatted = if results.is_empty() {
                "No music activity found in the specified time range.".to_string()
            } else {
                let mut f = format!("Here are the songs you've listened to in {}:\n\n", scope_label);
                for (i, track) in results.iter().enumerate() {
                    let media = track.get("media_info").and_then(|m| m.as_object());
                    let app_raw = track.get("app_name").and_then(|a| a.as_str()).unwrap_or("");
                    // Normalize Spotify app name (handle encoding issues)
                    let is_spotify = app_raw.as_bytes().windows(7).any(|w| w == b"Spotify") || app_raw.starts_with("Spotify");
                    let app = if is_spotify {
                        "Spotify"
                    } else if app_raw.to_lowercase().contains("youtube") {
                        "YouTube"
                    } else {
                        app_raw
                    };
                    let time = track.get("start_time").and_then(|t| t.as_i64()).unwrap_or(0);
                    // Convert Unix timestamp to local time
                    let dt = chrono::DateTime::from_timestamp(time, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_default();

                    if let Some(m) = media {
                        let title = m.get("title").and_then(|t| t.as_str()).unwrap_or("Unknown");
                        let artist = m.get("artist").and_then(|a| a.as_str()).unwrap_or("Unknown");
                        let status = m.get("status").and_then(|s| s.as_str()).unwrap_or("");
                        f.push_str(&format!(
                            "{}. {} - {}\n   {} | {} | {}\n",
                            i + 1,
                            title,
                            artist,
                            app,
                            status,
                            dt
                        ));
                    } else {
                        f.push_str(&format!(
                            "{}. [Unknown track]\n   {} | {}\n",
                            i + 1,
                            app,
                            dt
                        ));
                    }
                }
                f
            };

            Ok((formatted, activity_refs))
        },
        "get_recent_activities" => {
            let limit = args["limit"].as_u64().unwrap_or(100) as i32;
            let hours = args["hours"].as_u64().unwrap_or(24) as i64;
            let category_filter = args["category_id"].as_i64();
            let exclude_media_noise = args["exclude_media_noise"].as_bool().unwrap_or(false);
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            let scope_label = args["scope_label"].as_str().unwrap_or("the selected time range");

            let (sql, params): (&str, Vec<rusqlite::types::Value>) = if let Some(cat) = category_filter {
                (
                    "SELECT app_name, window_title, start_time, duration_seconds, category_id, metadata
                     FROM activities
                     WHERE start_time >= ?1 AND start_time <= ?2 AND category_id = ?3
                     ORDER BY start_time DESC
                     LIMIT ?4",
                    vec![
                        rusqlite::types::Value::Integer(start_ts),
                        rusqlite::types::Value::Integer(end_ts),
                        rusqlite::types::Value::Integer(cat),
                        rusqlite::types::Value::Integer(limit as i64),
                    ],
                )
            } else {
                (
                    "SELECT app_name, window_title, start_time, duration_seconds, category_id, metadata
                     FROM activities
                     WHERE start_time >= ?1 AND start_time <= ?2
                     ORDER BY start_time DESC
                     LIMIT ?3",
                    vec![
                        rusqlite::types::Value::Integer(start_ts),
                        rusqlite::types::Value::Integer(end_ts),
                        rusqlite::types::Value::Integer(limit as i64),
                    ],
                )
            };

            let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL Error: {}", e))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let metadata_blob: Option<Vec<u8>> = row.get(5)?;
                let media_info = metadata_blob
                    .as_ref()
                    .and_then(|blob| serde_json::from_slice::<ActivityMetadata>(blob).ok())
                    .and_then(|m| m.media_info);

                Ok(serde_json::json!({
                    "app_name": row.get::<_, String>(0)?,
                    "window_title": row.get::<_, String>(1)?,
                    "start_time": row.get::<_, i64>(2)?,
                    "duration_seconds": row.get::<_, i32>(3)?,
                    "category_id": row.get::<_, i32>(4)?,
                    "media_info": media_info
                }))
            }).map_err(|e| e.to_string())?;

            let mut events: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
            if exclude_media_noise {
                events.retain(|event| !is_media_noise_event(event));
            }
            let activity_refs: Vec<Value> = events
                .iter()
                .map(|event| {
                    let app = event.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
                    let title = event.get("window_title").and_then(|v| v.as_str()).unwrap_or("");
                    let time = event.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                    let duration = event.get("duration_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
                    let category_id = event.get("category_id").and_then(|v| v.as_i64()).unwrap_or(7);
                    let media = event.get("media_info").cloned();
                    serde_json::json!({
                        "app": app,
                        "title": title,
                        "time": time,
                        "duration_seconds": duration,
                        "category": category_name_from_id(category_id),
                        "media": media
                    })
                })
                .collect();

            let formatted = if events.is_empty() {
                "No activity events found in the selected time range.".to_string()
            } else {
                let mut out = format!(
                    "Here are your recent activity events from {}:\n\n",
                    scope_label
                );
                for (i, event) in events.iter().enumerate() {
                    let app = event.get("app_name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let title = event.get("window_title").and_then(|v| v.as_str()).unwrap_or("");
                    let start_time = event.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                    let duration = event.get("duration_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
                    let category_id = event.get("category_id").and_then(|v| v.as_i64()).unwrap_or(7);
                    let dt = chrono::DateTime::from_timestamp(start_time, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_else(|| "Unknown time".to_string());
                    out.push_str(&format!(
                        "{}. {} | {} | {} | {}\n   {}\n",
                        i + 1,
                        app,
                        category_name_from_id(category_id),
                        dt,
                        format_duration(duration),
                        if title.is_empty() { "(No window title)".to_string() } else { title.to_string() }
                    ));
                }
                out
            };

            Ok((formatted, activity_refs))
        },
        "get_recent_file_changes" => {
            let limit = args["limit"].as_u64().unwrap_or(40) as i64;
            let hours = args["hours"].as_u64().unwrap_or(24) as i64;
            let change_type = args["change_type"].as_str();
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            let scope_label = args["scope_label"].as_str().unwrap_or("the selected time range");
            println!(
                "[Timeline][FileChanges] Query start: start_ts={}, end_ts={}, limit={}, change_type={}",
                start_ts,
                end_ts,
                limit,
                change_type.unwrap_or("any")
            );

            let (sql, params): (&str, Vec<rusqlite::types::Value>) = if let Some(kind) = change_type {
                (
                    "SELECT path, project_root, entity_type, change_type, content_preview, detected_at
                     FROM code_file_events
                     WHERE detected_at >= ?1 AND detected_at <= ?2 AND change_type = ?3
                     ORDER BY detected_at DESC
                     LIMIT ?4",
                    vec![
                        rusqlite::types::Value::Integer(start_ts),
                        rusqlite::types::Value::Integer(end_ts),
                        rusqlite::types::Value::Text(kind.to_string()),
                        rusqlite::types::Value::Integer(limit),
                    ],
                )
            } else {
                (
                    "SELECT path, project_root, entity_type, change_type, content_preview, detected_at
                     FROM code_file_events
                     WHERE detected_at >= ?1 AND detected_at <= ?2
                     ORDER BY detected_at DESC
                     LIMIT ?3",
                    vec![
                        rusqlite::types::Value::Integer(start_ts),
                        rusqlite::types::Value::Integer(end_ts),
                        rusqlite::types::Value::Integer(limit),
                    ],
                )
            };

            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                    Ok(serde_json::json!({
                        "path": row.get::<_, String>(0)?,
                        "project_root": row.get::<_, String>(1)?,
                        "entity_type": row.get::<_, String>(2)?,
                        "change_type": row.get::<_, String>(3)?,
                        "content_preview": row.get::<_, Option<String>>(4)?,
                        "detected_at": row.get::<_, i64>(5)?,
                    }))
                })
                .map_err(|e| e.to_string())?;

            let changes: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
            println!(
                "[Timeline][FileChanges] Retrieved {} rows (start_ts={}, end_ts={})",
                changes.len(),
                start_ts,
                end_ts
            );
            for item in &changes {
                let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let change = item.get("change_type").and_then(|v| v.as_str()).unwrap_or("");
                let entity_type = item.get("entity_type").and_then(|v| v.as_str()).unwrap_or("file");
                let preview = item.get("content_preview").and_then(|v| v.as_str());
                let detected = item.get("detected_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let dt = chrono::DateTime::from_timestamp(detected, 0)
                    .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %I:%M:%S %p").to_string())
                    .unwrap_or_else(|| "Unknown time".to_string());
                println!(
                    "[Timeline][FileChanges] {} | {} {} | {}{}",
                    dt,
                    entity_type,
                    change,
                    path,
                    preview.map(|p| format!(" | {}", p.replace('\n', " "))).unwrap_or_default()
                );
            }
            let formatted = if changes.is_empty() {
                "No file changes found in the selected time range.".to_string()
            } else {
                let mut out = format!("Recent file changes ({}):\n\n", scope_label);
                for (idx, item) in changes.iter().enumerate() {
                    let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let project_root = item.get("project_root").and_then(|v| v.as_str()).unwrap_or("");
                    let entity_type = item.get("entity_type").and_then(|v| v.as_str()).unwrap_or("file");
                    let change = item.get("change_type").and_then(|v| v.as_str()).unwrap_or("");
                    let preview = item.get("content_preview").and_then(|v| v.as_str()).unwrap_or("");
                    let detected = item.get("detected_at").and_then(|v| v.as_i64()).unwrap_or(0);
                    let dt = chrono::DateTime::from_timestamp(detected, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_else(|| "Unknown time".to_string());
                    out.push_str(&format!(
                        "{}. [{} {}] {} ({})\n   {}\n",
                        idx + 1,
                        entity_type,
                        change,
                        path,
                        dt,
                        project_root
                    ));
                    if !preview.is_empty() {
                        out.push_str(&format!("   Change: {}\n", preview.replace('\n', " ")));
                    }
                }
                out
            };

            Ok((formatted, changes))
        }
        "resolve_query_scope" => {
            // This tool lets the LLM request a wider time scope or additional sources.
            // It returns a confirmation action marker that the frontend will show to the user.
            let suggested_scope = args["suggested_scope"].as_str().unwrap_or("last_7_days");
            let reason = args["reason"].as_str().unwrap_or("Your query requires a wider search range.");
            let enable_sources: Vec<String> = args.get("enable_sources")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();

            let payload = serde_json::json!({
                "kind": "confirm_scope_or_sources",
                "reason": reason,
                "suggested_time_range": suggested_scope,
                "enable_sources": enable_sources,
                "retry_message": "" // Will use the original query on retry
            });

            let output = format!(
                "Scope change requested: time range → {}, additional sources → [{}]. Reason: {}",
                suggested_scope,
                enable_sources.join(", "),
                reason
            );

            Ok((output, vec![payload]))
        }
        "query_activities" => {
            let sql = args["query"].as_str().or_else(|| args["sql"].as_str())
                .ok_or("Missing 'query' argument")?;
            
            // Hardened allowlist: only SELECT or WITH (CTEs) are permitted.
            let upper = sql.trim().to_uppercase();
            if !upper.starts_with("SELECT") && !upper.starts_with("WITH") {
                return Err("Security Violation: Only SELECT or WITH queries are permitted.".to_string());
            }

            // Denylist: block access to sensitive tables even via SELECT
            const FORBIDDEN_TABLES: &[&str] = &[
                "APP_SETTINGS", "CHAT_SESSIONS", "CHAT_MESSAGES",
                "DIARY_ENTRIES", "RETRIEVAL_CHUNKS",
            ];
            for table in FORBIDDEN_TABLES {
                if upper.contains(table) {
                    return Err(format!(
                        "Security Violation: Queries against '{}' are not permitted.",
                        table.to_lowercase()
                    ));
                }
            }

            let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL Error: {}", e))?;
            
            // Map columns to JSON
            let col_count = stmt.column_count();
            let col_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
            
            let rows = stmt.query_map([], |row| {
                let mut map = serde_json::Map::new();
                for i in 0..col_count {
                    let val = match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => Value::Number(n.into()),
                        rusqlite::types::ValueRef::Real(n) => serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null),
                        rusqlite::types::ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).to_string()),
                        rusqlite::types::ValueRef::Blob(b) => {
                            // Try to parse metadata blob as JSON
                             if let Ok(meta) = serde_json::from_slice::<ActivityMetadata>(b) {
                                serde_json::json!(meta)
                             } else {
                                Value::String(format!("<blob {} bytes>", b.len()))
                             }
                        }
                    };
                    map.insert(col_names[i].clone(), val);
                }
                Ok(Value::Object(map))
            }).map_err(|e| e.to_string())?;

            let results: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
            Ok((serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string()), results))
        },
        "search_ocr" => {
            let keyword = args["keyword"].as_str().ok_or("Missing keyword")?;
            let limit = parse_json_u64(args.get("limit"), 100) as usize;
            let hours = parse_json_u64(args.get("hours"), 24) as i64;
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            
            // Use json_extract to search only the screen_text field, avoiding
            // false positives from matching JSON key names in the full metadata blob.
            let mut stmt = conn.prepare(
                "SELECT start_time, app_name, window_title, duration_seconds, category_id, metadata FROM activities 
                 WHERE start_time >= ?1 AND start_time <= ?2
                 AND LOWER(json_extract(CAST(metadata AS TEXT), '$.screen_text')) LIKE ?3
                 ORDER BY start_time DESC LIMIT 20000"
            ).map_err(|e| e.to_string())?;
            
            let mut matches: Vec<Value> = Vec::new();
            let mut seen_snippets = std::collections::HashSet::new();
            let kw_param = format!("%{}%", keyword.to_lowercase());
            
            let rows = stmt.query_map(rusqlite::params![start_ts, end_ts, kw_param], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?
                ))
            }).map_err(|e| e.to_string())?;
            
            for r in rows {
                if let Ok((start_time, app_name, window_title, duration_seconds, category_id, meta_blob)) = r {
                     if app_name.to_lowercase().contains("intentflow") {
                         continue;
                     }
                     if let Some(blob) = meta_blob {
                        if let Ok(meta) = serde_json::from_slice::<ActivityMetadata>(&blob) {
                            if let Some(text) = meta.screen_text {
                                let cleaned = sanitize_ocr_for_query(&text);
                                if cleaned.is_empty() {
                                    continue;
                                }
                                if cleaned.to_lowercase().contains(&keyword.to_lowercase()) {
                                    let snippet = truncate_snippet(&cleaned, &keyword.to_lowercase());
                                    let short = normalize_whitespace(&snippet.chars().take(3000).collect::<String>());
                                    if !seen_snippets.insert(short.clone()) {
                                        continue;
                                    }
                                    matches.push(serde_json::json!({
                                        "app_name": app_name,
                                        "window_title": window_title,
                                        "start_time": start_time,
                                        "duration_seconds": duration_seconds,
                                        "category_id": category_id,
                                        "metadata": {
                                            "screen_text": cleaned,
                                            "ocr_snippet": snippet
                                        }
                                    }));
                                    if matches.len() >= limit { break; }
                                }
                            }
                        }
                     }
                }
            }
            let formatted = if matches.is_empty() {
                format!("No OCR results found for '{}'.", keyword)
            } else {
                let mut out = format!("Found {} OCR matches for '{}':\n\n", matches.len(), keyword);
                for (i, item) in matches.iter().enumerate() {
                    let app = item.get("app_name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let start_time = item.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                    let dt = chrono::DateTime::from_timestamp(start_time, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_else(|| "Unknown time".to_string());
                    let snippet = item
                        .get("metadata")
                        .and_then(|m| m.get("ocr_snippet"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    out.push_str(&format!("{}. {} at {}\n   {}\n", i + 1, app, dt, snippet));
                }
                out
            };
            Ok((formatted, matches))
        },
        "get_recent_ocr" => {
            let limit = args["limit"].as_u64().unwrap_or(100) as usize;
            let hours = args["hours"].as_u64().unwrap_or(24) as i64;
            let app_filter = args["app"].as_str().map(|s| s.to_lowercase());
            let keyword = args["keyword"].as_str().map(|s| s.to_lowercase());
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            let scope_label = args["scope_label"].as_str().unwrap_or("the selected time range");
            let scan_limit = std::cmp::max((limit as i64) * 50, 10000);

            let mut stmt = conn.prepare(
                "SELECT start_time, app_name, window_title, duration_seconds, category_id, metadata
                 FROM activities
                 WHERE start_time >= ?1 AND start_time <= ?2 AND metadata IS NOT NULL
                 AND (?4 IS NULL OR LOWER(app_name) LIKE ?4)
                 AND (?5 IS NULL OR LOWER(CAST(metadata AS TEXT)) LIKE ?5)
                 ORDER BY start_time DESC
                 LIMIT ?3"
            ).map_err(|e| e.to_string())?;

            let app_param = app_filter.as_ref().map(|a| format!("%{}%", a));
            let kw_param = keyword.as_ref().map(|k| format!("%{}%", k));

            let rows = stmt.query_map(rusqlite::params![start_ts, end_ts, scan_limit, app_param, kw_param], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?
                ))
            }).map_err(|e| e.to_string())?;

            let mut seen_snippets = std::collections::HashSet::new();
            let mut results: Vec<Value> = Vec::new();
            for row in rows {
                if let Ok((start_time, app_name, window_title, duration_seconds, category_id, metadata_blob)) = row {
                    if app_name.to_lowercase().contains("intentflow") {
                        continue;
                    }
                    if let Some(blob) = metadata_blob {
                        if let Ok(meta) = serde_json::from_slice::<ActivityMetadata>(&blob) {
                            if let Some(text) = meta.screen_text {
                                let normalized_text = sanitize_ocr_for_query(&text);
                                if normalized_text.is_empty() {
                                    continue;
                                }

                                if let Some(ref app_q) = app_filter {
                                    if !app_name.to_lowercase().contains(app_q) {
                                        continue;
                                    }
                                }
                                if let Some(ref kw) = keyword {
                                    if !normalized_text.to_lowercase().contains(kw) {
                                        continue;
                                    }
                                }

                                let short = normalize_whitespace(&normalized_text.chars().take(3000).collect::<String>());
                                if !seen_snippets.insert(short.clone()) {
                                    continue;
                                }

                                results.push(serde_json::json!({
                                    "app_name": app_name,
                                    "window_title": window_title,
                                    "start_time": start_time,
                                    "duration_seconds": duration_seconds,
                                    "category_id": category_id,
                                    "metadata": {
                                        "screen_text": normalized_text,
                                        "ocr_snippet": short
                                    }
                                }));

                                if results.len() >= limit {
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            let activity_refs: Vec<Value> = results.iter().map(|item| {
                let app = item.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
                let title = item.get("window_title").and_then(|v| v.as_str()).unwrap_or("");
                let time = item.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = item.get("duration_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
                let category_id = item.get("category_id").and_then(|v| v.as_i64()).unwrap_or(7);
                serde_json::json!({
                    "app": app,
                    "title": title,
                    "time": time,
                    "duration_seconds": duration,
                    "category": category_name_from_id(category_id),
                    "media": Value::Null
                })
            }).collect();

            let formatted = if results.is_empty() {
                "No OCR snippets found in the selected time range.".to_string()
            } else {
                let mut out = format!("Recent OCR snippets ({}):\n\n", scope_label);
                for (i, item) in results.iter().enumerate() {
                    let app = item.get("app_name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let start_time = item.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                    let dt = chrono::DateTime::from_timestamp(start_time, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_else(|| "Unknown time".to_string());
                    let snippet = item
                        .get("metadata")
                        .and_then(|m| m.get("ocr_snippet"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    out.push_str(&format!("{}. {} at {}\n   {}\n", i + 1, app, dt, snippet));
                }
                out
            };

            Ok((formatted, activity_refs))
        },
        "get_usage_stats" => {
             let start = args["start_time_iso"].as_str().unwrap_or("");
            let end = args["end_time_iso"].as_str().unwrap_or("");
            
            let s_ts = parse_iso_to_unix(start).unwrap_or(0);
            let e_ts = parse_iso_to_unix(end).unwrap_or(chrono::Utc::now().timestamp());
            
            let mut stmt = conn.prepare(
                "SELECT app_name, SUM(duration_seconds) as total_dur, COUNT(*) as cnt
                 FROM activities 
                 WHERE start_time >= ?1 AND start_time <= ?2 
                 GROUP BY app_name
                 ORDER BY total_dur DESC LIMIT 20"
            ).map_err(|e| e.to_string())?;
            
            let rows = stmt.query_map(rusqlite::params![s_ts, e_ts], |row: &rusqlite::Row| {
                Ok(serde_json::json!({
                    "app": row.get::<_, String>(0)?,
                    "total_seconds": row.get::<_, i64>(1)?,
                    "count": row.get::<_, i32>(2)?
                }))
            }).map_err(|e| e.to_string())?;
            
            let results: Vec<Value> = rows.filter_map(|r: Result<Value, rusqlite::Error>| r.ok()).collect();
            Ok((serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string()), results))
        },
        "query_history" => {
             // Alias for old query_activities call?
              Err("Use query_activities instead".to_string()) 
        },
        "get_browser_history" => {
            let limit = parse_json_u64(args.get("limit"), 50) as i64;
            let hours = parse_json_u64(args.get("hours"), 24) as i64;
            let (start_ts, end_ts) = resolve_window_from_args(args, hours);
            let scope_label = args["scope_label"].as_str().unwrap_or("the selected time range");

            let mut stmt = conn.prepare(
                "SELECT app_name, window_title, json_extract(CAST(metadata AS TEXT), '$.url') as url, start_time 
                 FROM activities 
                 WHERE start_time >= ?1 AND start_time <= ?2
                 AND json_extract(CAST(metadata AS TEXT), '$.url') IS NOT NULL
                 ORDER BY start_time DESC LIMIT ?3"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map(rusqlite::params![start_ts, end_ts, limit], |row| {
                Ok(serde_json::json!({
                    "app_name": row.get::<_, String>(0)?,
                    "window_title": row.get::<_, String>(1)?,
                    "url": row.get::<_, Option<String>>(2)?,
                    "start_time": row.get::<_, i64>(3)?,
                }))
            }).map_err(|e| e.to_string())?;

            let results: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
            let activity_refs: Vec<Value> = results.iter().map(|item| {
                serde_json::json!({
                    "app": item.get("app_name").and_then(|v| v.as_str()).unwrap_or(""),
                    "title": item.get("url").and_then(|v| v.as_str()).unwrap_or(
                        item.get("window_title").and_then(|v| v.as_str()).unwrap_or("")
                    ),
                    "time": item.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0),
                    "duration_seconds": 0,
                    "category": "Browser",
                    "media": Value::Null
                })
            }).collect();

            let formatted = if results.is_empty() {
                format!("No browser history found in {}.", scope_label)
            } else {
                let mut out = format!("Browser history ({}):\n\n", scope_label);
                for (i, item) in results.iter().enumerate() {
                    let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let app = item.get("app_name").and_then(|v| v.as_str()).unwrap_or("Browser");
                    let ts = item.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0);
                    let dt = chrono::DateTime::from_timestamp(ts, 0)
                        .map(|dt| dt.with_timezone(&chrono::Local).format("%I:%M %p").to_string())
                        .unwrap_or_default();
                    out.push_str(&format!("{}. {} | {} | {}\n", i + 1, app, dt, url));
                }
                out
            };

            Ok((formatted, activity_refs))
        },
        _ => Err(format!("Unknown tool: {}", tool))
    }
}

/// Parse a JSON value as u64, tolerating both number and string-encoded integers.
/// This handles the common LLM bug of sending `"limit": "100"` instead of `"limit": 100`.
fn parse_json_u64(val: Option<&Value>, default: u64) -> u64 {
    val.and_then(|v| {
        v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    }).unwrap_or(default)
}

// ─── Helpers ───

include!("query_engine_post_helpers.incl.rs");
