use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader as StdBufReader},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde_json::Value;

use crate::{
    AppState, SESSION_CATALOG_PRELOAD_LIMIT, ServerMessage, SessionHeader, SessionKind,
    SessionRecord, SessionStatus, SessionSummary, ToolCard, TranscriptMessage, now_epoch_seconds,
    project_omp_transcript,
};

#[derive(Debug)]
pub(crate) struct DiscoveredSession {
    pub(crate) id: String,
    pub(crate) preload_index: usize,
    pub(crate) cwd: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) session_file: String,
    pub(crate) messages: Vec<TranscriptMessage>,
    pub(crate) tool_cards: Vec<ToolCard>,
    pub(crate) messages_loaded: bool,
}

pub(crate) async fn refresh_session_catalog(state: &AppState) -> bool {
    let discovered = discover_sessions(&state.session_root);
    let mut discovered_ids = HashSet::new();
    let mut sessions = state.sessions.write().await;
    let before = session_summaries_from_map(&sessions);

    for mut session in discovered {
        discovered_ids.insert(session.id.clone());
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
                record.title = session.title;
                record.timestamp = session.timestamp;
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
                        kind: SessionKind::Available,
                        session_file: Some(session.session_file),
                        title: session.title,
                        timestamp: session.timestamp,
                        model: None,
                        thinking_level: None,
                        tokens_total: 0,
                        cost_usd: 0.0,
                        context_tokens: None,
                        context_window: None,
                        context_percent: None,
                        plan_mode: None,
                    },
                );
            }
        }
    }

    sessions.retain(|_, record| {
        record.kind != SessionKind::Available || discovered_ids.contains(&record.id)
    });

    before != session_summaries_from_map(&sessions)
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
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_session_files(&path, sessions);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            if let Some(session) = read_session_header(&path) {
                sessions.push(session);
            }
        }
    }
}

pub(crate) fn read_session_header(path: &Path) -> Option<DiscoveredSession> {
    let file = fs::File::open(path).ok()?;
    let mut lines = StdBufReader::new(file).lines();
    let header_line = lines.next()?.ok()?;
    let header = serde_json::from_str::<SessionHeader>(&header_line).ok()?;
    if header.entry_type != "session" {
        return None;
    }
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or_else(now_epoch_seconds);
    let created_at = header
        .timestamp
        .as_deref()
        .and_then(parse_timestamp_seconds)
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
        })
        .unwrap_or_else(now_epoch_seconds);

    Some(DiscoveredSession {
        preload_index: usize::MAX,
        id: header.id,
        cwd: header.cwd,
        title: header.title,
        timestamp: header.timestamp,
        created_at,
        updated_at,
        session_file: path.to_string_lossy().to_string(),
        messages: Vec::new(),
        tool_cards: Vec::new(),
        messages_loaded: false,
    })
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
            if let Some(message) = entry.get("message").cloned() {
                message_values.push(message);
            }
        }
    }
    project_omp_transcript(&message_values)
}

pub(crate) fn parse_timestamp_seconds(timestamp: &str) -> Option<u64> {
    let date_time = timestamp.split_once('T')?.0;
    let mut parts = date_time.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    days_from_civil(year, month, day).map(|days| days.saturating_mul(86_400))
}

pub(crate) fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days).ok()
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
