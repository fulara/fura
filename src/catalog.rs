use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader as StdBufReader},
    path::{Path, PathBuf},
    time::Instant,
};

use serde_json::{Map, Value};
use tracing::warn;

use crate::{
    AppState, GoalModeProjection, SESSION_CATALOG_PRELOAD_LIMIT, ServerMessage, SessionHeader,
    SessionKind, SessionRecord, SessionStatus, SessionSummary, Timestamp, ToolCard,
    TranscriptMessage, append_bridge_debug_event, is_controller_session_record,
    map_goal_mode_projection, project_omp_transcript, save_fura_config,
};

#[derive(Debug)]
pub(crate) struct DiscoveredSession {
    pub(crate) id: String,
    pub(crate) preload_index: usize,
    pub(crate) cwd: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) session_file: String,
    pub(crate) messages: Vec<TranscriptMessage>,
    pub(crate) tool_cards: Vec<ToolCard>,
    pub(crate) messages_loaded: bool,
    pub(crate) goal_mode: Option<GoalModeProjection>,
}

pub(crate) async fn refresh_session_catalog(state: &AppState) -> bool {
    let started_at = Instant::now();
    let discovered = discover_sessions(&state.session_root);
    let discover_ms = started_at.elapsed().as_millis() as u64;
    let mut discovered_ids = HashSet::new();
    let categories = state.session_runtime.session_categories_snapshot().await;
    let modes = state.session_runtime.session_modes_snapshot().await;
    let mut sessions = state.sessions.write().await;
    let before = session_summaries_from_map(&sessions);

    for mut session in discovered {
        discovered_ids.insert(session.id.clone());
        let category = categories.get(&session.id).cloned();
        let session_mode = modes.get(&session.id).copied().unwrap_or_default();
        let should_load_goal_mode = match sessions.get(&session.id) {
            Some(record) if record.kind == SessionKind::Available => {
                record.updated_at != session.updated_at
            }
            Some(_) => false,
            None => true,
        };
        if should_load_goal_mode {
            session.goal_mode = read_session_file_goal_mode(Path::new(&session.session_file));
        }
        if should_preload_discovered_session_messages(&sessions, &session) {
            let path = Path::new(&session.session_file);
            let (messages, tool_cards) = read_session_file_messages(path);
            session.messages = messages;
            session.tool_cards = tool_cards;
            session.messages_loaded = true;
        }
        match sessions.get_mut(&session.id) {
            Some(record) if record.kind == SessionKind::Available => {
                let should_reload_messages = session.messages_loaded
                    && (record.updated_at != session.updated_at || record.messages.is_empty());
                record.cwd = session.cwd;
                record.created_at = session.created_at;
                record.updated_at = session.updated_at;
                record.session_file = Some(session.session_file);
                if session.title.is_some() {
                    record.title = session.title;
                }
                if session.timestamp.is_some() {
                    record.timestamp = session.timestamp;
                }
                record.category = category;
                record.session_mode = session_mode;
                record.goal_mode = session.goal_mode;
                if should_reload_messages {
                    record.messages = session.messages.clone();
                    record.tool_cards = session.tool_cards.clone();
                }
            }
            Some(record) => {
                if record.session_file.is_none() {
                    record.session_file = Some(session.session_file);
                }
                if record.title.is_none() {
                    record.title = session.title;
                }
                if record.timestamp.is_none() {
                    record.timestamp = session.timestamp;
                }
                record.category = category;
                record.session_mode = session_mode;
                if record.goal_mode.is_none() {
                    record.goal_mode = session.goal_mode;
                }
            }
            None => {
                sessions.insert(
                    session.id.clone(),
                    SessionRecord {
                        id: session.id,
                        cwd: session.cwd,
                        args: Vec::new(),
                        status: SessionStatus::Available,
                        created_at: session.created_at,
                        updated_at: session.updated_at,
                        messages: session.messages.clone(),
                        live_message_ids: HashSet::new(),
                        streaming_message: None,
                        tool_cards: session.tool_cards.clone(),
                        active_tool_calls: Vec::new(),
                        todo_phases: None,
                        kind: SessionKind::Available,
                        session_file: Some(session.session_file),
                        title: session.title,
                        timestamp: session.timestamp,
                        category,
                        session_mode,
                        worktree: None,
                        model: None,
                        thinking_level: None,
                        tokens_total: 0,
                        cost_usd: 0.0,
                        context_tokens: None,
                        context_window: None,
                        context_percent: None,
                        plan_mode: None,
                        goal_mode: session.goal_mode,
                        pending_plan_review: None,
                    },
                );
            }
        }
    }

    sessions.retain(|_, record| {
        record.kind != SessionKind::Available || discovered_ids.contains(&record.id)
    });
    let retained_session_ids = sessions.keys().cloned().collect::<HashSet<_>>();
    let sessions_changed = before != session_summaries_from_map(&sessions);
    let session_count = sessions.len() as u64;
    let discovered_count = discovered_ids.len() as u64;
    drop(sessions);

    let metadata_pruned = state
        .session_runtime
        .prune_session_metadata(&retained_session_ids)
        .await;
    if metadata_pruned {
        if let Err(error) = save_fura_config(state).await {
            warn!(%error, "failed to save pruned session metadata");
        }
    }

    let mut fields = Map::new();
    fields.insert(
        "durationMs".to_string(),
        Value::Number((started_at.elapsed().as_millis() as u64).into()),
    );
    fields.insert("discoverMs".to_string(), Value::Number(discover_ms.into()));
    fields.insert(
        "discoveredCount".to_string(),
        Value::Number(discovered_count.into()),
    );
    fields.insert(
        "sessionCount".to_string(),
        Value::Number(session_count.into()),
    );
    fields.insert("changed".to_string(), Value::Bool(sessions_changed));
    fields.insert("metadataPruned".to_string(), Value::Bool(metadata_pruned));
    append_bridge_debug_event(state, "session_catalog.refresh", fields).await;

    sessions_changed
}

pub(crate) fn discover_sessions(root: &Path) -> Vec<DiscoveredSession> {
    let mut sessions = Vec::new();
    collect_session_files(root, &mut sessions);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    for (index, session) in sessions.iter_mut().enumerate() {
        session.preload_index = index;
    }
    sessions
}

pub(crate) fn should_preload_discovered_session_messages(
    existing_sessions: &HashMap<String, SessionRecord>,
    discovered: &DiscoveredSession,
) -> bool {
    if discovered.preload_index >= SESSION_CATALOG_PRELOAD_LIMIT {
        return false;
    }

    match existing_sessions.get(&discovered.id) {
        Some(record) if record.kind == SessionKind::Available => {
            record.updated_at != discovered.updated_at || record.messages.is_empty()
        }
        Some(_) => false,
        None => true,
    }
}

pub(crate) fn collect_session_files(path: &Path, sessions: &mut Vec<DiscoveredSession>) {
    let direct_sessions = collect_direct_session_files(path);
    if !direct_sessions.is_empty() {
        sessions.extend(direct_sessions);
        return;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            sessions.extend(collect_direct_session_files(&path));
        }
    }
}

fn collect_direct_session_files(path: &Path) -> Vec<DiscoveredSession> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                return None;
            };
            if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            {
                read_session_header(&path)
            } else {
                None
            }
        })
        .collect()
}

#[derive(Default)]
struct HeaderProbe {
    first_entry_type: Option<String>,
    first_user_prompt: Option<String>,
}

fn probe_entries_after_header<I>(lines: &mut I) -> HeaderProbe
where
    I: Iterator<Item = std::io::Result<String>>,
{
    let mut probe = HeaderProbe::default();
    for line in lines.take(8).flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if probe.first_entry_type.is_none() {
            probe.first_entry_type = value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if probe.first_user_prompt.is_none() {
            probe.first_user_prompt = extract_first_user_prompt(&value);
        }
        if probe.first_entry_type.is_some() && probe.first_user_prompt.is_some() {
            break;
        }
    }
    probe
}

fn extract_goal_mode_change(entry: &Value) -> Option<Option<GoalModeProjection>> {
    if entry.get("type").and_then(Value::as_str) != Some("mode_change") {
        return None;
    }
    match entry.get("mode").and_then(Value::as_str)? {
        "none" => Some(None),
        "goal" | "goal_paused" => {
            let goal = entry.get("data").and_then(|data| data.get("goal"))?;
            let state = serde_json::json!({
                "enabled": entry.get("mode").and_then(Value::as_str) == Some("goal"),
                "mode": "active",
                "goal": goal,
            });
            map_goal_mode_projection(&state).map(Some)
        }
        _ => None,
    }
}

fn extract_first_user_prompt(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = entry.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => blocks.iter().find_map(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        _ => None,
    }
}

fn sanitize_session_title(value: &str) -> Option<String> {
    let first_line = value.lines().next().unwrap_or_default();
    let stripped = first_line
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    let trimmed = stripped.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn read_session_header(path: &Path) -> Option<DiscoveredSession> {
    let file = fs::File::open(path).ok()?;
    let mut lines = StdBufReader::new(file).lines();
    let header_line = lines.next()?.ok()?;
    let header = serde_json::from_str::<SessionHeader>(&header_line).ok()?;
    if header.entry_type != "session" {
        return None;
    }
    let probe = probe_entries_after_header(&mut lines);
    if probe.first_entry_type.as_deref() == Some("session_init") {
        return None;
    }
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|time| Timestamp::try_from(time).ok())
        .unwrap_or_else(Timestamp::now);
    let created_at = header
        .timestamp
        .as_deref()
        .and_then(Timestamp::from_rpc)
        .or_else(|| {
            metadata
                .as_ref()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| Timestamp::try_from(time).ok())
        })
        .unwrap_or_else(Timestamp::now);

    let title = header
        .title
        .as_deref()
        .and_then(sanitize_session_title)
        .or_else(|| {
            probe
                .first_user_prompt
                .as_deref()
                .and_then(sanitize_session_title)
        });

    Some(DiscoveredSession {
        preload_index: usize::MAX,
        id: header.id,
        cwd: header.cwd,
        title,
        timestamp: header.timestamp,
        created_at,
        updated_at,
        session_file: path.to_string_lossy().to_string(),
        messages: Vec::new(),
        tool_cards: Vec::new(),
        messages_loaded: false,
        goal_mode: None,
    })
}

pub(crate) fn read_session_file_goal_mode(path: &Path) -> Option<GoalModeProjection> {
    let Ok(file) = fs::File::open(path) else {
        return None;
    };
    let reader = StdBufReader::new(file);
    let mut latest_goal_mode = None;
    for (i, line) in reader.lines().enumerate() {
        if i == 0 {
            continue; // skip session header
        }
        let Ok(line) = line else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(goal_mode) = extract_goal_mode_change(&entry) {
            latest_goal_mode = goal_mode;
        }
    }
    latest_goal_mode
}

pub(crate) fn read_session_file_messages(path: &Path) -> (Vec<TranscriptMessage>, Vec<ToolCard>) {
    let Ok(file) = fs::File::open(path) else {
        return (Vec::new(), Vec::new());
    };
    let reader = StdBufReader::new(file);
    let mut message_values: Vec<Value> = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        if i == 0 {
            continue; // skip session header
        }
        let Ok(line) = line else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) == Some("message") {
            if let Some(mut message) = entry.get("message").cloned() {
                if let Some(object) = message.as_object_mut() {
                    if !object.contains_key("timestamp") {
                        if let Some(timestamp) =
                            entry.get("timestamp").and_then(Timestamp::from_rpc)
                        {
                            object.insert("timestamp".to_string(), Value::from(timestamp.millis()));
                        }
                    }
                }
                message_values.push(message);
            }
        }
    }
    project_omp_transcript(&message_values)
}

pub(crate) fn default_session_root() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omp")
        .join("agent")
        .join("sessions")
}

pub(crate) fn session_summaries_from_map(
    sessions: &HashMap<String, SessionRecord>,
) -> Vec<SessionSummary> {
    let mut summaries = sessions
        .values()
        .filter(|record| !is_controller_session_record(record))
        .map(SessionRecord::summary)
        .collect::<Vec<_>>();
    summaries.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.updated_at.cmp(&a.updated_at)));
    summaries
}

pub(crate) fn sessions_snapshot_from_map(
    sessions: &HashMap<String, SessionRecord>,
) -> ServerMessage {
    ServerMessage::SessionsSnapshot {
        sessions: session_summaries_from_map(sessions),
    }
}
