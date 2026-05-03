fn category_name_from_id(category_id: i64) -> &'static str {
    match category_id {
        1 => "Development",
        2 => "Browser",
        3 => "Communication",
        4 => "Entertainment",
        5 => "Productivity",
        6 => "System",
        _ => "Other",
    }
}

fn transform_activities_for_frontend(tool: &str, tool_activities: &[Value]) -> Vec<Value> {
    if tool == "get_music_history"
        || tool == "get_recent_activities"
        || tool == "get_recent_ocr"
        || tool == "parallel_search"
    {
        return tool_activities.to_vec();
    }

    if tool == "get_recent_file_changes" {
        return tool_activities
            .iter()
            .map(|item| {
                let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let entity_type = item.get("entity_type").and_then(|v| v.as_str()).unwrap_or("file");
                let change_type = item.get("change_type").and_then(|v| v.as_str()).unwrap_or("changed");
                let content_preview = item.get("content_preview").and_then(|v| v.as_str()).unwrap_or("");
                let title = if content_preview.is_empty() {
                    format!("[{} {}] {}", entity_type, change_type, path)
                } else {
                    format!(
                        "[{} {}] {} | {}",
                        entity_type,
                        change_type,
                        path,
                        content_preview.replace('\n', " ")
                    )
                };
                serde_json::json!({
                    "app": "File Monitor",
                    "title": title,
                    "time": item.get("detected_at").and_then(|v| v.as_i64()).unwrap_or(0),
                    "duration_seconds": 0,
                    "category": "Development",
                    "media": Value::Null
                })
            })
            .collect();
    }

    if tool == "query_activities" || tool == "search_ocr" {
        let mut transformed = Vec::new();
        for act in tool_activities {
            let media = act.get("metadata").and_then(|m| m.get("media_info")).cloned();
            let category_id = act.get("category_id").and_then(|v| v.as_i64()).unwrap_or(0);
            transformed.push(serde_json::json!({
                "app": act.get("app_name").and_then(|v| v.as_str()).unwrap_or(""),
                "title": act.get("window_title").and_then(|v| v.as_str()).unwrap_or(""),
                "time": act.get("start_time").and_then(|v| v.as_i64()).unwrap_or(0),
                "duration_seconds": act.get("duration_seconds").and_then(|v| v.as_i64()).unwrap_or(0),
                "category": category_name_from_id(category_id),
                "media": media,
            }));
        }
        return transformed;
    }

    Vec::new()
}

fn format_duration(total_seconds: i64) -> String {
    if total_seconds <= 0 {
        return "0s".to_string();
    }
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, seconds)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, seconds)
    } else {
        format!("{}s", seconds)
    }
}

fn normalize_final_answer(answer: &str) -> String {
    answer
        .replace("â€“", "-")
        .replace("â€”", "-")
        .trim()
        .to_string()
}

fn normalize_final_answer_hardened(answer: &str) -> String {
    let cleaned = normalize_final_answer(answer);
    let cleaned = strip_think_blocks(&cleaned);
    let cleaned = strip_internal_stream_markup(&cleaned);
    let cleaned = strip_reasoning_fragments(&cleaned);
    cleaned
        .lines()
        .filter(|line| !contains_internal_tool_markup(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Strip leaked `"reasoning": "..."` fragments and partial JSON tool-call debris from text.
fn strip_reasoning_fragments(text: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    static RE1: OnceLock<Regex> = OnceLock::new();
    static RE2: OnceLock<Regex> = OnceLock::new();

    let re1 = RE1.get_or_init(|| Regex::new(r#"(?m)^\s*,?\s*"reasoning"\s*:\s*"[^}]*$"#).unwrap());
    let re2 = RE2.get_or_init(|| Regex::new(r#"(?m)^\s*,\s*"\w+"\s*:\s*"[^"]*"\s*\}?\s*$"#).unwrap());

    let result = re1.replace_all(text, "").to_string();
    let result = re2.replace_all(&result, "").to_string();

    // Strip any remaining lines that are just `}` with no context
    result
        .lines()
        .filter(|&line| {
            let trimmed = line.trim();
            // Keep non-empty lines that aren't just JSON debris
            !trimmed.is_empty() || true // keep blank lines for formatting
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn try_parse_tool_call_response(full_response: &str) -> Option<AgentResponse> {
    let cleaned = strip_internal_stream_markup(full_response);
    // Also strip <think>...</think> blocks that may wrap the tool call
    let cleaned = strip_think_blocks(&cleaned);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 1. Try direct parse
    if let Ok(resp) = serde_json::from_str::<AgentResponse>(trimmed) {
        if matches!(resp, AgentResponse::ToolCall { .. }) {
            return Some(resp);
        }
    }

    if trimmed.contains("\"tool\"") && trimmed.contains("\"args\"") {
        // 2. Try extracting a top-level JSON object
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        if end > start {
            let candidate = &trimmed[start..=end];
            if let Ok(resp) = serde_json::from_str::<AgentResponse>(candidate) {
                if matches!(resp, AgentResponse::ToolCall { .. }) {
                    return Some(resp);
                }
            }

            // 3. Try stripping the "reasoning" field entirely (it often has unescaped quotes)
            if let Some(fixed) = try_fix_broken_reasoning_json(candidate) {
                if let Ok(resp) = serde_json::from_str::<AgentResponse>(&fixed) {
                    if matches!(resp, AgentResponse::ToolCall { .. }) {
                        return Some(resp);
                    }
                }
            }
        }
    }

    None
}

/// Strip <think>...</think> blocks (potentially unclosed) from a string.
fn strip_think_blocks(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut remaining = text;
    loop {
        let lower = remaining.to_lowercase();
        if let Some(open_pos) = lower.find("<think") {
            // Find end of opening tag
            let tag_end = remaining[open_pos..].find('>').map(|i| open_pos + i + 1).unwrap_or(remaining.len());
            result.push_str(&remaining[..open_pos]);
            if let Some(close_pos) = lower[tag_end..].find("</think>") {
                remaining = &remaining[tag_end + close_pos + 8..];
            } else {
                // Unclosed tag - strip everything after it
                break;
            }
        } else {
            result.push_str(remaining);
            break;
        }
    }
    result
}

/// Try to fix broken JSON where the "reasoning" field has unescaped quotes.
/// Uses regex to safely remove only the "reasoning" key/value pair, avoiding the
/// destructive rfind('}') approach that could corrupt other fields.
fn try_fix_broken_reasoning_json(json_str: &str) -> Option<String> {
    use regex::Regex;
    use std::sync::OnceLock;

    if !json_str.contains("\"reasoning\"") {
        return None;
    }

    // Remove the reasoning field using a regex that matches the key + its string value
    // (?s) = DOTALL mode so `.` matches newlines
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?s),?\s*"reasoning"\s*:\s*".*?""#).unwrap()
    });

    let fixed = re.replace(json_str, "").trim().to_string();

    if fixed != json_str {
        return Some(fixed);
    }

    // Fallback: legacy slice approach if regex didn't match
    let reasoning_key = json_str.find("\"reasoning\"") ?;
    let last_brace = json_str.rfind('}') ?;
    let before_reasoning = json_str[..reasoning_key].trim_end();
    let stripped_before = if before_reasoning.ends_with(',') {
        &before_reasoning[..before_reasoning.len() - 1]
    } else {
        before_reasoning
    };
    Some(format!("{}\n{}", stripped_before.trim_end(), &json_str[last_brace..]))
}

fn requires_multi_tool_validation(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("who")
        || q.contains("which")
        || q.contains("name")
        || q.contains("chat")
        || q.contains("message")
        || q.contains("project")
        || q.contains("code")
        || q.contains("file")
        || q.contains("did i")
        || q.contains("what did")
        || q.contains("evidence")
        || q.contains("confirm")
}

fn is_smalltalk_query(query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.len() <= 12 && (q == "hi" || q == "hello" || q == "hey" || q == "yo") {
        return true;
    }
    q.contains("how are you")
        || q.contains("thanks")
        || q.contains("thank you")
        || q.contains("good morning")
        || q.contains("good night")
}

fn requires_evidence_for_query(query: &str) -> bool {
    if is_smalltalk_query(query) {
        return false;
    }
    true
}

fn build_insufficient_evidence_action_marker(query: &str, scope: &TimeScope) -> String {
    let mut enable_sources: Vec<&str> = Vec::new();
    let q = query.to_lowercase();
    if q.contains("project") || q.contains("repo") || q.contains("code") || q.contains("file") {
        enable_sources.push("files");
    }
    if q.contains("browser") || q.contains("website") || q.contains("history") || q.contains("linkedin") {
        enable_sources.push("browser");
    }
    if q.contains("chat") || q.contains("text") || q.contains("message") {
        enable_sources.push("screen");
    }

    let suggested_scope = if q.contains("this year") && scope.id != "this_year" {
        "this_year"
    } else if scope.id != "all_time" {
        "all_time"
    } else if scope.id != "last_7_days" {
        "last_7_days"
    } else {
        ""
    };

    if suggested_scope.is_empty() && enable_sources.is_empty() {
        return String::new();
    }

    let payload = serde_json::json!({
        "kind": "confirm_scope_or_sources",
        "reason": "Evidence is insufficient in the current scope/source settings.",
        "suggested_time_range": if suggested_scope.is_empty() { Value::Null } else { Value::String(suggested_scope.to_string()) },
        "enable_sources": enable_sources,
        "retry_message": query
    });
    format!("\n\n[[IF_ACTION:{}]]", payload)
}

fn has_minimum_evidence_for_query(query: &str, steps: &[AgentStep]) -> bool {
    if !requires_evidence_for_query(query) {
        return true;
    }
    let evidence_steps = collect_evidence_tool_names(steps);
    if evidence_steps.is_empty() {
        return false;
    }
    if requires_multi_tool_validation(query) {
        if evidence_steps.len() < 2 {
            return false;
        }
        if is_project_query(query) && !has_project_evidence(steps) {
            return false;
        }
        if is_identity_or_romance_query(query) {
            return has_explicit_chat_evidence(steps) || has_non_chat_strong_identity_evidence(steps);
        }
        return true;
    }
    if is_project_query(query) {
        return has_project_evidence(steps);
    }
    evidence_steps.len() >= 1
}

fn is_project_query(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("project")
        || q.contains("projects")
        || q.contains("code")
        || q.contains("repo")
        || q.contains("worked on")
        || q.contains("work i did")
}

fn has_project_evidence(steps: &[AgentStep]) -> bool {
    for step in steps {
        let name = step.tool_name.as_str();
        if name == "get_recent_file_changes" {
            return step_has_material_evidence(step);
        }
        let out = step.tool_result.to_lowercase();
        if out.contains(".ts")
            || out.contains(".tsx")
            || out.contains(".js")
            || out.contains(".rs")
            || out.contains(".py")
            || out.contains("github")
            || out.contains("repo")
            || out.contains("pull request")
        {
            return true;
        }
    }
    false
}

fn is_identity_or_romance_query(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("crush")
        || q.contains("girl")
        || q.contains("boy")
        || q.contains("name")
        || q.contains("whom do i")
        || q.contains("who do i")
        || q.contains("love")
}

fn has_explicit_chat_evidence(steps: &[AgentStep]) -> bool {
    for step in steps {
        let out = step.tool_result.to_lowercase();
        if out.contains("whatsapp")
            || out.contains("telegram")
            || out.contains("instagram")
            || out.contains("chat")
            || out.contains("message")
        {
            return true;
        }
    }
    false
}

fn has_non_chat_strong_identity_evidence(steps: &[AgentStep]) -> bool {
    let mut support_hits = 0usize;
    for step in steps {
        if !step_has_material_evidence(step) {
            continue;
        }
        let out = step.tool_result.to_lowercase();
        if out.contains("linkedin")
            || out.contains("profile")
            || out.contains("call log")
            || out.contains("contact")
            || out.contains("frequent")
        {
            support_hits += 1;
        }
    }
    support_hits >= 2
}

fn scrub_unsupported_communication_claims(answer: &str, query: &str, steps: &[AgentStep]) -> String {
    if !is_identity_or_romance_query(query) || has_explicit_chat_evidence(steps) {
        return answer.to_string();
    }

    let lower = answer.to_lowercase();
    let likely_chat_claim = lower.contains("texted")
        || lower.contains("chatted")
        || lower.contains("whatsapp")
        || lower.contains("messaged");
    if !likely_chat_claim {
        return answer.to_string();
    }

    format!(
        "{}\n\nNote: I don't have explicit chat-app evidence in this time range, so I cannot claim texting/chats.",
        answer
    )
}

fn collect_evidence_tool_names(steps: &[AgentStep]) -> std::collections::HashSet<String> {
    let mut distinct = std::collections::HashSet::new();
    for step in steps {
        if !step_has_material_evidence(step) {
            continue;
        }
        match step.tool_name.as_str() {
            "get_recent_ocr" | "search_ocr" | "get_recent_activities" | "query_activities" | "get_recent_file_changes" | "get_music_history" | "get_usage_stats" => {
                distinct.insert(step.tool_name.clone());
            }
            "parallel_search" => {
                if let Some(calls) = step.tool_args.get("calls").and_then(|v| v.as_array()) {
                    for call in calls {
                        if let Some(tool) = call.get("tool").and_then(|v| v.as_str()) {
                            distinct.insert(tool.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    distinct
}

fn step_has_material_evidence(step: &AgentStep) -> bool {
    let out = step.tool_result.trim();
    if out.is_empty() || out == "[]" || out == "{}" {
        return false;
    }
    let lower = out.to_lowercase();
    !(lower.contains("no results")
        || lower.contains("0 result")
        || lower.contains("no matching")
        || lower.contains("\"results\":[]")
        || lower.contains("\"items\":[]"))
}

fn contains_internal_tool_markup(text: &str) -> bool {
    let lower = text.to_lowercase();
    text.contains("<|tool_")
        || lower.contains("tool_calls_section_begin")
        || lower.contains("tool_call_begin")
        || lower.contains("tool_call_argument_begin")
        || lower.contains("tool_calls_section_end")
}

fn strip_internal_stream_markup(text: &str) -> String {
    text
        .replace("<|tool_calls_section_begin|>", "")
        .replace("<|tool_calls_section_end|>", "")
        .replace("<|tool_call_begin|>", "")
        .replace("<|tool_call_end|>", "")
        .replace("<|tool_call_argument_begin|>", "")
}

fn parse_iso_to_unix(iso: &str) -> Option<i64> {
    if iso.is_empty() { return None; }
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|dt| dt.timestamp())
        .or_else(|| {
             chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
                .map(|dt| dt.timestamp())
        })
}

fn truncate_for_token_limit(text: &str, limit_chars: usize) -> String {
    if text.len() <= limit_chars {
        text.to_string()
    } else {
        // Safe char boundary truncation
        let end = text.char_indices().nth(limit_chars).map(|(i, _)| i).unwrap_or(text.len());
        format!("{}... [truncated]", &text[..end])
    }
}

fn truncate_snippet(text: &str, keyword: &str) -> String {
    if let Some(idx) = text.to_lowercase().find(keyword) {
        // Safe char boundary calculation
        let start_char_idx = text[..idx].chars().count().saturating_sub(150);
        let start = text.char_indices().nth(start_char_idx).map(|(i, _)| i).unwrap_or(0);
        
        // Find end byte safely
        let end_char_idx = start_char_idx + 300 + keyword.len(); // approximate
        let end = text.char_indices().nth(end_char_idx).map(|(i, _)| i).unwrap_or(text.len());

        format!("...{}...", &text[start..end])
    } else {
        text.chars().take(300).collect()
    }
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sanitize_ocr_for_query(text: &str) -> String {
    let compact = normalize_whitespace(text);
    if compact.is_empty() {
        return String::new();
    }

    let filtered: String = compact
        .chars()
        .filter(|c| {
            c.is_alphanumeric()
                || c.is_whitespace()
                || ",.;:!?()[]{}'\"/@#&+-_|".contains(*c)
        })
        .collect();
    let cleaned = normalize_whitespace(&filtered);
    if cleaned.len() < 3 {
        return String::new();
    }
    if looks_like_gibberish(&cleaned) {
        return String::new();
    }
    cleaned
}

fn looks_like_gibberish(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return true;
    }
    let total = chars.len() as f64;
    let letters = chars.iter().filter(|c| c.is_alphabetic()).count() as f64;
    let digits = chars.iter().filter(|c| c.is_ascii_digit()).count() as f64;
    let symbols = chars
        .iter()
        .filter(|c| !c.is_alphanumeric() && !c.is_whitespace())
        .count() as f64;
    let vowels = chars
        .iter()
        .filter(|c| "aeiouAEIOU".contains(**c))
        .count() as f64;

    let symbol_ratio = symbols / total;
    let alpha_ratio = letters / total;
    let digit_ratio = digits / total;
    let vowel_ratio = if letters > 0.0 { vowels / letters } else { 0.0 };

    symbol_ratio > 0.35 || alpha_ratio < 0.18 || (letters > 10.0 && vowel_ratio < 0.06) || digit_ratio > 0.7
}

async fn synthesize_answer_from_evidence(
    app_handle: &tauri::AppHandle,
    provider: &str,
    model: &str,
    api_key: &str,
    use_local_llm: bool,
    lmstudio_url: Option<&str>,
    user_query: &str,
    scope: &TimeScope,
    steps: &[AgentStep],
    activities: &[Value],
) -> Result<String, String> {
    let mut evidence_lines: Vec<String> = Vec::new();
    for (i, step) in steps.iter().take(8).enumerate() {
        evidence_lines.push(format!(
            "{}. {} -> {}",
            i + 1,
            step.tool_name,
            truncate_for_token_limit(&step.tool_result, 20000)
        ));
    }

    let summary_prompt = format!(
        "User query: {query}\nTime scope: {label} ({start} to {end})\nEvidence items: {count}\nTool evidence:\n{evidence}\n\nReturn a detailed, crisp, and highly specific final answer. Start with a direct answer, then provide evidence bullets with exact times, app names, and window titles. Break down activities chronologically or by major tasks. Do not just give a high-level summary of time spent. Include a short confidence statement and explicitly list missing evidence when uncertain. Do not call tools.",
        query = user_query,
        label = scope.label,
        start = format_time_scope_ts(scope.start_ts),
        end = format_time_scope_ts(scope.end_ts),
        count = activities.len(),
        evidence = evidence_lines.join("\n\n"),
    );

    let mut out = String::new();
    let on_token = |chunk: &str| {
        let _ = app_handle.emit("chat://token", chunk);
    };
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a precise assistant. Produce one final answer from provided evidence only. Be detailed, specific, and not overly brief. Include direct answer, evidence bullets, and confidence. No tool JSON.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: summary_prompt,
        },
    ];
    call_llm_stream_with_provider(provider, model, api_key, use_local_llm, lmstudio_url, &messages, &mut out, on_token).await?;
    if matches!(try_parse_tool_call_response(&out), Some(AgentResponse::ToolCall { .. })) {
        return Ok("I gathered evidence but could not produce a stable final summary. Please ask with a specific app/date and I’ll answer exactly.".to_string());
    }
    let cleaned = strip_internal_stream_markup(&out)
        .replace("<think>", "")
        .replace("</think>", "");
    let normalized = normalize_final_answer_hardened(&cleaned);
    Ok(scrub_unsupported_communication_claims(&normalized, user_query, steps))
}

// Streaming LLM Call
#[allow(dead_code)]
async fn call_llm_stream<F>(
    model: &str,
    api_key: &str,
    messages: &[ChatMessage],
    output_buffer: &mut String,
    on_token: F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    call_llm_stream_with_provider("nvidia", model, api_key, false, None, messages, output_buffer, on_token).await
}

async fn call_llm_stream_with_provider<F>(
    provider: &str,
    model: &str,
    api_key: &str,
    use_local_llm: bool,
    lmstudio_url: Option<&str>,
    messages: &[ChatMessage],
    output_buffer: &mut String,
    mut on_token: F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    let client = reqwest::Client::builder()
        .timeout(StdDuration::from_secs(LLM_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to init HTTP client: {}", e))?;

    let provider_lower = provider.to_lowercase();

    // ─── Gemini: completely different schema ───────────────────────────────
    if !use_local_llm && provider_lower == "gemini" {
        let mut contents = Vec::new();
        let mut system_text = String::new();
        for msg in messages {
            if msg.role == "system" {
                system_text.push_str(&msg.content);
                system_text.push('\n');
                continue;
            }
            let role = if msg.role == "assistant" { "model" } else { "user" };
            let mut text = msg.content.clone();
            if !system_text.is_empty() && msg.role == "user" && contents.is_empty() {
                text = format!("{}\n\n{}", system_text.trim(), text);
                system_text.clear();
            }
            contents.push(serde_json::json!({
                "role": role,
                "parts": [{ "text": text }]
            }));
        }
        if !system_text.is_empty() {
            contents.insert(0, serde_json::json!({
                "role": "user",
                "parts": [{ "text": system_text.trim() }]
            }));
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            model, api_key
        );
        let body = serde_json::json!({
            "contents": contents,
            "generationConfig": { "temperature": 0.0, "maxOutputTokens": 8192 }
        });

        let mut response = client.post(&url)
            .header("Content-Type", "application/json")
            .json(&body).send().await
            .map_err(|e| format!("Net err: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("API Error {}: {}", status, text));
        }

        let mut buffer = String::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            let chunk_str = String::from_utf8_lossy(&chunk);
            buffer.push_str(&chunk_str);
            let lines: Vec<&str> = buffer.split('\n').collect();
            let last_part = if chunk_str.ends_with('\n') { String::new() } else { lines.last().unwrap_or(&"").to_string() };
            for line in &lines {
                let line = line.trim();
                if line.starts_with("data: ") {
                    let data = &line[6..];
                    if data == "[DONE]" { break; }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(text) = parsed.get("candidates").and_then(|v| v.as_array()).and_then(|a| a.first())
                            .and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(|p| p.as_array())
                            .and_then(|parts| parts.first()).and_then(|part| part.get("text")).and_then(|t| t.as_str())
                        {
                            output_buffer.push_str(text);
                            on_token(text);
                        }
                    }
                }
            }
            buffer = last_part;
        }
        return Ok(());
    }

    // ─── Anthropic: different schema + SSE events ─────────────────────────
    if !use_local_llm && provider_lower == "anthropic" {
        let mut system_prompt = String::new();
        let mut api_messages = Vec::new();
        for msg in messages {
            if msg.role == "system" {
                system_prompt.push_str(&msg.content);
                system_prompt.push('\n');
            } else {
                api_messages.push(serde_json::json!({ "role": msg.role, "content": msg.content }));
            }
        }
        let mut body = serde_json::json!({
            "model": model,
            "messages": api_messages,
            "max_tokens": 8192,
            "stream": true
        });
        if !system_prompt.trim().is_empty() {
            body.as_object_mut().unwrap().insert("system".to_string(), serde_json::Value::String(system_prompt.trim().to_string()));
        }

        let mut response = client.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body).send().await
            .map_err(|e| format!("Net err: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("API Error {}: {}", status, text));
        }

        let mut buffer = String::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            let chunk_str = String::from_utf8_lossy(&chunk);
            buffer.push_str(&chunk_str);
            let lines: Vec<&str> = buffer.split('\n').collect();
            let last_part = if chunk_str.ends_with('\n') { String::new() } else { lines.last().unwrap_or(&"").to_string() };
            for line in &lines {
                let line = line.trim();
                if line.starts_with("data: ") {
                    let data = &line[6..];
                    if data == "[DONE]" { break; }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        if parsed.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                            if let Some(text) = parsed.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                                output_buffer.push_str(text);
                                on_token(text);
                            }
                        }
                    }
                }
            }
            buffer = last_part;
        }
        return Ok(());
    }

    // ─── OpenAI-compatible: NVIDIA, OpenAI, Groq ──────────────────────────
    let request = ChatRequest {
        model: model.to_string(),
        messages: messages.to_vec(),
        temperature: 0.0,
        max_tokens: 8192,
        stream: true,
    };

    let endpoint = if use_local_llm {
        let base = lmstudio_url.unwrap_or("http://127.0.0.1:1234");
        format!("{}/v1/chat/completions", base.trim_end_matches('/'))
    } else {
        match provider_lower.as_str() {
            "openai" => "https://api.openai.com/v1/chat/completions".to_string(),
            "groq" => "https://api.groq.com/openai/v1/chat/completions".to_string(),
            _ => "https://integrate.api.nvidia.com/v1/chat/completions".to_string(),
        }
    };

    let mut req = client.post(&endpoint).header("Content-Type", "application/json").json(&request);
    if !use_local_llm || !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let mut response = req.send().await.map_err(|e| format!("Net err: {}", e))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API Error {}: {}", status, text));
    }

    let mut buffer = String::new();
    let mut reasoning_open = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        let chunk_str = String::from_utf8_lossy(&chunk);
        buffer.push_str(&chunk_str);
        let lines: Vec<&str> = buffer.split('\n').collect();
        let last_part = if chunk_str.ends_with('\n') { String::new() } else { lines.last().unwrap_or(&"").to_string() };
        for line in lines {
            let line = line.trim();
            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" { break; }
                if let Ok(stream_resp) = serde_json::from_str::<ChatStreamResponse>(data) {
                    if let Some(choice) = stream_resp.choices.first() {
                        if let Some(ref reasoning) = choice.delta.reasoning_content {
                            if !reasoning.is_empty() {
                                if !reasoning_open {
                                    output_buffer.push_str("<think>");
                                    on_token("<think>");
                                    reasoning_open = true;
                                }
                                output_buffer.push_str(reasoning);
                                on_token(reasoning);
                            }
                        }
                        if let Some(ref content) = choice.delta.content {
                            if reasoning_open {
                                output_buffer.push_str("</think>");
                                on_token("</think>");
                                reasoning_open = false;
                            }
                            output_buffer.push_str(content);
                            on_token(content);
                        }
                    }
                }
            }
        }
        buffer = last_part;
    }

    if reasoning_open {
        output_buffer.push_str("</think>");
        on_token("</think>");
    }

    Ok(())
}

// Kept for backward compat if needed, but we don't really use it now
#[allow(dead_code)]
async fn call_llm(model: &str, api_key: &str, messages: &[ChatMessage]) -> Result<String, String> {
    let mut out = String::new();
    call_llm_stream(model, api_key, messages, &mut out, |_| {}).await?;
    Ok(out)
}
