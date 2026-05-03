fn detect_query_intent(query: &str) -> QueryIntent {
    let q = query.to_lowercase();
    let wants_music = q.contains("song")
        || q.contains("music")
        || q.contains("spotify")
        || q.contains("hearing")
        || q.contains("listen");
    let wants_ocr = q.contains("ocr")
        || q.contains("whatsapp")
        || q.contains("chat")
        || q.contains("text")
        || q.contains("instagram");
    let wants_files = q.contains("file")
        || q.contains("code")
        || q.contains("project")
        || q.contains("document")
        || q.contains("change");
    let wants_timeline = q.contains("timeline")
        || q.contains("what did i do")
        || q.contains("activity")
        || q.contains("summary")
        || q.contains("overview");
    let broad_summary = q.contains("full summary")
        || q.contains("don't leave anything")
        || q.contains("dont leave anything")
        || q.contains("everything")
        || q.contains("today")
        || q.contains("yesterday")
        || q.contains("this year")
        || q.contains("yearly")
        || q.contains("annual")
        || (wants_timeline && (wants_ocr || wants_files || wants_music));

    QueryIntent {
        wants_music,
        wants_ocr,
        wants_files,
        wants_timeline,
        broad_summary,
    }
}

fn requires_broad_scope(query: &str) -> bool {
    let q = query.to_lowercase();
    
    let time_indicators = [
        "first", "last time", "ever", "always", "never", "usually", "often", 
        "history", "past", "before", "earlier", "since", "overall", "all time",
        "months", "years", "weeks", "days ago", "long time", "recently"
    ];
    
    let general_questions = [
        "how many times", "how often", "when did i", "longest", "best", "worst", 
        "favorite", "most", "top", "frequent"
    ];
    
    let identity_questions = [
        "who is", "what is my", "guess", "crush", "relationship", "friend", "girlfriend", "boyfriend"
    ];

    time_indicators.iter().any(|&w| q.contains(w)) ||
    general_questions.iter().any(|&w| q.contains(w)) ||
    identity_questions.iter().any(|&w| q.contains(w))
}

#[allow(dead_code)]
fn query_has_time_hint(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("today")
        || q.contains("yesterday")
        || q.contains("last ")
        || q.contains("past ")
        || q.contains("this year")
        || q.contains("this week")
        || q.contains("this month")
        || q.contains("right now")
        || q.contains("few mins")
        || q.contains("few days")
        || q.contains("days back")
        || q.contains("days ago")
        || q.contains("recently")
        || q.contains("earlier")
        || q.contains("before")
        || q.contains("the other day")
        || q.contains("not just today")
        || q.contains("from the start")
        || q.contains("from start")
        || q.contains("beginning")
        || q.contains("ever")
        || q.contains("overall")
        || q.contains("always")
        || q.contains("couple day")
        || q.contains("couple week")
        || q.contains("few weeks")
        || q.contains("month ago")
        || q.contains("week ago")
        || q.chars().any(|c| c.is_ascii_digit())
}

fn local_day_bounds(days_ago: i64) -> Option<(i64, i64)> {
    let now = Local::now();
    let target_date = now.date_naive() - Duration::days(days_ago);
    let start_naive = target_date.and_hms_opt(0, 0, 0)?;
    let end_naive = target_date.and_hms_opt(23, 59, 59)?;
    let tz = now.timezone();
    let start = tz.from_local_datetime(&start_naive).single()?.timestamp();
    let end = tz.from_local_datetime(&end_naive).single()?.timestamp();
    Some((start, end))
}

fn resolve_time_scope(explicit_scope: Option<&str>) -> TimeScope {
    let now = chrono::Utc::now().timestamp();
    let scope_id = explicit_scope
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| "today".to_string());

    match scope_id.as_str() {
        "yesterday" => {
            let (start_ts, end_ts) = local_day_bounds(1).unwrap_or((now - 86400, now));
            TimeScope { id: scope_id, label: "Yesterday".to_string(), start_ts, end_ts }
        }
        "last_3_days" => {
            let start_ts = local_day_bounds(2).map(|(s, _)| s).unwrap_or(now - 3 * 86400);
            TimeScope { id: scope_id, label: "Last 3 Days".to_string(), start_ts, end_ts: now }
        }
        "last_7_days" => {
            let start_ts = local_day_bounds(6).map(|(s, _)| s).unwrap_or(now - 7 * 86400);
            TimeScope { id: scope_id, label: "Last 7 Days".to_string(), start_ts, end_ts: now }
        }
        "last_30_days" => {
            let start_ts = local_day_bounds(29).map(|(s, _)| s).unwrap_or(now - 30 * 86400);
            TimeScope { id: scope_id, label: "Last 30 Days".to_string(), start_ts, end_ts: now }
        }
        "this_year" => {
            let local_now = Local::now();
            let year = local_now.year();
            let start_naive = chrono::NaiveDate::from_ymd_opt(year, 1, 1)
                .and_then(|d| d.and_hms_opt(0, 0, 0));
            let start_ts = start_naive
                .and_then(|dt| local_now.timezone().from_local_datetime(&dt).single())
                .map(|dt| dt.timestamp())
                .unwrap_or(now - 365 * 86400);
            TimeScope { id: scope_id, label: "This Year".to_string(), start_ts, end_ts: now }
        }
        "all_time" => TimeScope {
            id: scope_id,
            label: "All Time".to_string(),
            start_ts: 0,
            end_ts: now,
        },
        _ => {
            let start_ts = local_day_bounds(0).map(|(s, _)| s).unwrap_or(now - 86400);
            TimeScope { id: "today".to_string(), label: "Today".to_string(), start_ts, end_ts: now }
        }
    }
}

fn format_time_scope_ts(ts: i64) -> String {
    if ts <= 0 {
        return "beginning".to_string();
    }
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| dt.with_timezone(&Local).format("%b %d, %Y %I:%M %p").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn enforce_tool_args_with_scope(tool: &str, args: &Value, scope: &TimeScope, user_query: &str) -> Value {
    if tool == "parallel_search" {
        let mut next = args.clone();
        let root = match next.as_object_mut() {
            Some(v) => v,
            None => return args.clone(),
        };
        if let Some(calls) = root.get_mut("calls").and_then(|v| v.as_array_mut()) {
            for call in calls {
                let Some(call_obj) = call.as_object_mut() else { continue; };
                let call_tool = call_obj
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let base_args = call_obj.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
                call_obj.insert(
                    "args".to_string(),
                    enforce_tool_args_with_scope(&call_tool, &base_args, scope, user_query),
                );
            }
        }
        return next;
    }

    let mut next = args.clone();
    let Some(obj) = next.as_object_mut() else {
        return args.clone();
    };

    obj.insert("start_ts".to_string(), serde_json::json!(scope.start_ts));
    obj.insert("end_ts".to_string(), serde_json::json!(scope.end_ts));
    obj.insert("scope_label".to_string(), serde_json::json!(scope.label));

    let span_seconds = (scope.end_ts - scope.start_ts).max(0);
    let span_hours = ((span_seconds + 3599) / 3600).max(1);
    obj.insert("hours".to_string(), serde_json::json!(span_hours));

    if tool == "get_recent_activities" && !detect_query_intent(user_query).wants_music {
        obj.insert("exclude_media_noise".to_string(), Value::Bool(true));
    }

    if tool == "get_usage_stats" {
        let start_iso = chrono::DateTime::from_timestamp(scope.start_ts, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
        let end_iso = chrono::DateTime::from_timestamp(scope.end_ts, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        obj.insert("start_time_iso".to_string(), Value::String(start_iso));
        obj.insert("end_time_iso".to_string(), Value::String(end_iso));
    }

    next
}

fn resolve_window_from_args(args: &Value, default_hours: i64) -> (i64, i64) {
    let now = chrono::Utc::now().timestamp();
    let hours = args["hours"].as_u64().unwrap_or(default_hours as u64) as i64;
    let mut start_ts = args.get("start_ts").and_then(|v| v.as_i64()).unwrap_or(now - hours * 3600);
    let mut end_ts = args.get("end_ts").and_then(|v| v.as_i64()).unwrap_or(now);

    if end_ts <= 0 {
        end_ts = now;
    }
    if start_ts < 0 {
        start_ts = 0;
    }
    if start_ts > end_ts {
        std::mem::swap(&mut start_ts, &mut end_ts);
    }
    (start_ts, end_ts)
}

fn build_prefetch_parallel_args(scope: &TimeScope, intent: &QueryIntent, source_scope: &ChatSourceScope) -> Value {
    let mut calls = vec![serde_json::json!({
        "tool": "get_recent_activities",
        "args": {
            "limit": if scope.id == "all_time" { 120 } else { 80 },
            "exclude_media_noise": !intent.wants_music
        }
    })];

    if !source_scope.apps {
        calls.clear();
    }

    if source_scope.screen && (intent.wants_ocr || intent.broad_summary) {
        calls.push(serde_json::json!({
            "tool": "get_recent_ocr",
            "args": { "limit": if scope.id == "all_time" { 80 } else { 50 } }
        }));
    }

    if source_scope.files && (intent.wants_files || intent.wants_timeline || intent.broad_summary) {
        calls.push(serde_json::json!({
            "tool": "get_recent_file_changes",
            "args": { "limit": if scope.id == "all_time" { 80 } else { 40 } }
        }));
    }

    if source_scope.media && intent.wants_music {
        calls.push(serde_json::json!({
            "tool": "get_music_history",
            "args": { "limit": if scope.id == "all_time" { 80 } else { 40 } }
        }));
    }

    serde_json::json!({ "calls": calls })
}

fn build_forced_validation_parallel_args(
    scope: &TimeScope,
    intent: &QueryIntent,
    source_scope: &ChatSourceScope,
    query: &str,
) -> Value {
    let mut calls = Vec::new();
    if source_scope.apps {
        calls.push(serde_json::json!({
            "tool": "get_recent_activities",
            "args": { "limit": if scope.id == "all_time" { 120 } else { 80 }, "exclude_media_noise": !intent.wants_music }
        }));
    }
    if source_scope.screen {
        calls.push(serde_json::json!({
            "tool": "get_recent_ocr",
            "args": { "limit": if scope.id == "all_time" { 120 } else { 80 } }
        }));
    }

    if source_scope.files && (intent.wants_files || query.to_lowercase().contains("project") || query.to_lowercase().contains("file") || query.to_lowercase().contains("code")) {
        calls.push(serde_json::json!({
            "tool": "get_recent_file_changes",
            "args": { "limit": if scope.id == "all_time" { 100 } else { 60 } }
        }));
    }

    if source_scope.media && (intent.wants_music || query.to_lowercase().contains("song") || query.to_lowercase().contains("music")) {
        calls.push(serde_json::json!({
            "tool": "get_music_history",
            "args": { "limit": if scope.id == "all_time" { 80 } else { 50 } }
        }));
    }

    serde_json::json!({ "calls": calls })
}

fn should_use_long_range_pipeline(query: &str, scope: &TimeScope, intent: &QueryIntent) -> bool {
    let q = query.to_lowercase();
    let summary_like = q.contains("summary")
        || q.contains("overview")
        || q.contains("recap")
        || q.contains("what did i do")
        || q.contains("this year")
        || q.contains("yearly")
        || q.contains("annual");
    if !summary_like {
        return false;
    }
    let span_days = ((scope.end_ts - scope.start_ts).max(0)) / 86_400;
    scope.id == "this_year" || scope.id == "all_time" || span_days >= 90 || intent.broad_summary
}

fn run_long_range_summary_pipeline(
    db_path: &std::path::Path,
    scope: &TimeScope,
    intent: &QueryIntent,
    source_scope: &ChatSourceScope,
    user_query: &str,
) -> Result<(Vec<AgentStep>, Vec<Value>, String), String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut steps: Vec<AgentStep> = Vec::new();
    let mut all_refs: Vec<Value> = Vec::new();
    let mut digest_parts: Vec<String> = Vec::new();

    // Step 1: Aggregate app usage for the whole range.
    if source_scope.apps {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "get_usage_stats",
            serde_json::json!({}),
            "Aggregate usage baseline for long-range summary",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    // Step 2: Monthly category rollup to avoid feeding raw per-event data.
    let monthly_category_sql = format!(
        "SELECT strftime('%Y-%m', datetime(start_time, 'unixepoch', 'localtime')) AS month, category_id, SUM(duration_seconds) AS total_seconds, COUNT(*) AS events \
         FROM activities WHERE start_time >= {} AND start_time <= {} \
         GROUP BY month, category_id \
         ORDER BY month DESC, total_seconds DESC LIMIT 600",
        scope.start_ts,
        scope.end_ts
    );
    if source_scope.apps {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "query_activities",
            serde_json::json!({ "query": monthly_category_sql }),
            "Monthly category aggregation for long-range compression",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    // Step 3: Top apps over the full range.
    let top_apps_sql = format!(
        "SELECT app_name, SUM(duration_seconds) AS total_seconds, COUNT(*) AS events \
         FROM activities WHERE start_time >= {} AND start_time <= {} \
         GROUP BY app_name \
         ORDER BY total_seconds DESC LIMIT 40",
        scope.start_ts,
        scope.end_ts
    );
    if source_scope.apps {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "query_activities",
            serde_json::json!({ "query": top_apps_sql }),
            "Top apps aggregation for the selected long-range window",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    // Step 4: Recent high-signal activity slice for concrete examples.
    if source_scope.apps {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "get_recent_activities",
            serde_json::json!({
                "limit": if scope.id == "all_time" { 300 } else { 220 },
                "exclude_media_noise": !intent.wants_music
            }),
            "Concrete activity slice for examples and chronology",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    let q = user_query.to_lowercase();
    let needs_files = intent.wants_files || q.contains("project") || q.contains("repo") || q.contains("code");
    if source_scope.files && needs_files {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "get_recent_file_changes",
            serde_json::json!({ "limit": if scope.id == "all_time" { 220 } else { 160 } }),
            "File-change slice for project/work summary",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    let needs_chat = intent.wants_ocr || q.contains("chat") || q.contains("text") || q.contains("message");
    if source_scope.screen && needs_chat {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "get_recent_ocr",
            serde_json::json!({ "limit": if scope.id == "all_time" { 220 } else { 160 } }),
            "OCR/chat slice for communication evidence",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    if source_scope.media && (intent.wants_music || q.contains("music") || q.contains("song")) {
        execute_and_record_long_range_step(
            &conn,
            scope,
            user_query,
            "get_music_history",
            serde_json::json!({ "limit": if scope.id == "all_time" { 140 } else { 100 } }),
            "Music slice for media trend evidence",
            &mut steps,
            &mut all_refs,
            &mut digest_parts,
        )?;
    }

    let digest = digest_parts.join("\n\n");
    Ok((steps, all_refs, digest))
}

fn execute_and_record_long_range_step(
    conn: &Connection,
    scope: &TimeScope,
    user_query: &str,
    tool: &str,
    raw_args: Value,
    reasoning: &str,
    steps: &mut Vec<AgentStep>,
    all_refs: &mut Vec<Value>,
    digest_parts: &mut Vec<String>,
) -> Result<(), String> {
    let enforced_args = enforce_tool_args_with_scope(tool, &raw_args, scope, user_query);
    let (tool_output, tool_activities, attempts_used) =
        execute_tool_with_retries(conn, tool, &enforced_args, MAX_TOOL_RETRY_LOOPS)?;
    let with_retry_note = if attempts_used > 1 {
        format!(
            "Auto-retried with broader search {} time(s).\n{}",
            attempts_used - 1,
            tool_output
        )
    } else {
        tool_output
    };
    let truncated = truncate_for_token_limit(&with_retry_note, 25000);
    steps.push(AgentStep {
        turn: 0,
        tool_name: tool.to_string(),
        tool_args: enforced_args.clone(),
        tool_result: truncated.clone(),
        reasoning: reasoning.to_string(),
    });
    let refs = transform_activities_for_frontend(tool, &tool_activities);
    all_refs.extend(refs);
    digest_parts.push(format!(
        "{} -> {}",
        tool,
        truncate_for_token_limit(&normalize_whitespace(&truncated), 4000)
    ));
    Ok(())
}

fn dedupe_activities(activities: &mut Vec<Value>) {
    let mut seen = std::collections::HashSet::new();
    activities.retain(|item| {
        let app = item.get("app").and_then(|v| v.as_str()).unwrap_or_default();
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or_default();
        let time = item.get("time").and_then(|v| v.as_i64()).unwrap_or_default();
        let key = format!("{}|{}|{}", app, title, time);
        seen.insert(key)
    });
}

fn is_media_activity_ref(item: &Value) -> bool {
    if item.get("media").and_then(|v| v.get("title")).is_some() {
        return true;
    }
    let app = item.get("app").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    app.contains("spotify") || app.contains("youtube music") || app.contains("apple music")
}

fn is_media_noise_event(event: &Value) -> bool {
    let Some(media) = event.get("media_info").and_then(|v| v.as_object()) else {
        return false;
    };
    let title = media.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
    if title.is_empty() {
        return false;
    }
    let app_name = event.get("app_name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    // Keep direct player rows, filter incidental "now playing" reflections from other windows.
    !(app_name.contains("spotify") || app_name.contains("youtube") || app_name.contains("music"))
}

fn is_low_signal_result(tool: &str, output: &str, activities: &[Value]) -> bool {
    if !activities.is_empty() {
        return false;
    }
    let text = output.trim().to_lowercase();
    if text == "[]" {
        return true;
    }
    match tool {
        "get_music_history" => text.contains("no music activity found"),
        "get_recent_activities" => text.contains("no activity events found"),
        "get_recent_file_changes" => text.contains("no file changes found"),
        "search_ocr" | "get_recent_ocr" => text.contains("no ocr") || text.contains("no matches"),
        "query_activities" => text.contains("[]") || text.contains("no rows"),
        _ => false,
    }
}

fn broaden_tool_args(tool: &str, args: &Value, attempt: usize) -> Value {
    let mut next = args.clone();
    let obj = match next.as_object_mut() {
        Some(v) => v,
        None => return args.clone(),
    };

    let limit = obj.get("limit").and_then(|v| v.as_u64()).unwrap_or(20);
    let hours = obj.get("hours").and_then(|v| v.as_u64()).unwrap_or(24);
    let has_fixed_window = obj.get("start_ts").and_then(|v| v.as_i64()).is_some()
        && obj.get("end_ts").and_then(|v| v.as_i64()).is_some();

    match tool {
        "get_music_history" | "get_recent_activities" | "get_recent_ocr" | "get_recent_file_changes" => {
            let new_limit = std::cmp::min(limit + 20, 250);
            obj.insert("limit".to_string(), Value::Number(serde_json::Number::from(new_limit)));
            if !has_fixed_window {
                let new_hours = std::cmp::min(hours * 2, 168);
                obj.insert("hours".to_string(), Value::Number(serde_json::Number::from(new_hours)));
            }
        }
        "search_ocr" => {
            let new_limit = std::cmp::min(limit + 20, 200);
            obj.insert("limit".to_string(), Value::Number(serde_json::Number::from(new_limit)));
            if attempt == 1 {
                if let Some(keyword) = obj.get("keyword").and_then(|v| v.as_str()) {
                    if keyword.contains(' ') {
                        if let Some(first) = keyword.split_whitespace().next() {
                            obj.insert("keyword".to_string(), Value::String(first.to_string()));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    next
}

fn execute_tool_with_retries(
    conn: &Connection,
    tool: &str,
    args: &Value,
    max_loops: usize,
) -> Result<(String, Vec<Value>, usize), String> {
    let loops = std::cmp::max(max_loops, 1);
    let mut current_args = args.clone();

    for attempt in 1..=loops {
        let (output, activities) = execute_tool(conn, tool, &current_args)?;
        if attempt == loops || !is_low_signal_result(tool, &output, &activities) {
            return Ok((output, activities, attempt));
        }
        current_args = broaden_tool_args(tool, &current_args, attempt);
    }

    Err("Tool execution failed after retries".to_string())
}

fn execute_parallel_search(
    db_path: &std::path::Path,
    args: &Value,
    scope: Option<&TimeScope>,
    source_scope: Option<&ChatSourceScope>,
    user_query: &str,
) -> Result<(String, Vec<Value>), String> {
    let calls = args
        .get("calls")
        .and_then(|v| v.as_array())
        .ok_or("parallel_search requires args.calls array")?;
    if calls.is_empty() {
        return Err("parallel_search requires at least one tool call".to_string());
    }

    let mut handles = Vec::new();
    for call in calls {
        let tool = call
            .get("tool")
            .and_then(|v| v.as_str())
            .ok_or("Each parallel call needs a tool field")?
            .to_string();
        if tool == "parallel_search" {
            return Err("Nested parallel_search is not allowed".to_string());
        }
        if let Some(active_sources) = source_scope {
            let missing_sources = active_sources.missing_sources_for_tool(&tool);
            if !missing_sources.is_empty() {
                handles.push(std::thread::spawn(move || -> Result<(String, String, Vec<Value>, usize), String> {
                    Ok((
                        tool,
                        format!("Skipped because the following sources are disabled: {}", missing_sources.join(", ")),
                        Vec::new(),
                        1usize,
                    ))
                }));
                continue;
            }
        }
        let raw_tool_args = call.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
        let tool_args = if let Some(active_scope) = scope {
            enforce_tool_args_with_scope(&tool, &raw_tool_args, active_scope, user_query)
        } else {
            raw_tool_args
        };
        let db_path = db_path.to_path_buf();

        handles.push(std::thread::spawn(move || -> Result<(String, String, Vec<Value>, usize), String> {
            let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
            let (output, activities, attempts) =
                execute_tool_with_retries(&conn, &tool, &tool_args, MAX_TOOL_RETRY_LOOPS)?;
            Ok((tool, output, activities, attempts))
        }));
    }

    let mut combined_output = format!("Parallel search executed {} tool calls:\n", calls.len());
    let mut combined_activities: Vec<Value> = Vec::new();

    for handle in handles {
        let (tool, output, activities, attempts) = handle
            .join()
            .map_err(|_| "Parallel search worker panicked".to_string())??;
        combined_output.push_str(&format!(
            "- {} (attempts: {})\n",
            tool, attempts
        ));
        combined_output.push_str(&format!(
            "  {}\n",
            truncate_for_token_limit(&normalize_whitespace(&output), 5000)
        ));
        combined_activities.extend(transform_activities_for_frontend(&tool, &activities));
    }

    Ok((combined_output, combined_activities))
}

