use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader as StdBufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Instant,
};

use serde_json::{Map, Value};
use tracing::warn;

use crate::session_recency::{JournalFact, JournalRecency, SessionFileStamp, read_json_line};
use crate::{
    AppState, GoalModeProjection, SESSION_CATALOG_PRELOAD_LIMIT, ServerMessage, SessionHeader,
    SessionKind, SessionRecord, SessionStatus, SessionSummary, Timestamp, ToolCard,
    TranscriptMessage, append_bridge_debug_event, is_controller_session_record,
    map_goal_mode_projection, project_omp_transcript, save_fura_config,
};

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredSession {
    pub(crate) id: String,
    pub(crate) preload_index: usize,
    pub(crate) cwd: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) last_message_at: Option<Timestamp>,
    pub(crate) file_stamp: Option<SessionFileStamp>,
    pub(crate) session_file: String,
    pub(crate) messages: Vec<TranscriptMessage>,
    pub(crate) tool_cards: Vec<ToolCard>,
    pub(crate) messages_loaded: bool,
    pub(crate) goal_mode: Option<GoalModeProjection>,
}

#[derive(Default)]
pub(crate) struct SessionCatalogCache {
    entries: HashMap<PathBuf, CachedSessionHeader>,
    seen: HashSet<PathBuf>,
    #[cfg(test)]
    pub(crate) content_scans: usize,
    #[cfg(test)]
    pub(crate) transcript_loads: usize,
}

struct CachedSessionHeader {
    stamp: SessionFileStamp,
    // Always unhydrated: never cache transcript/tool payloads here.
    session: Option<DiscoveredSession>,
    messages_hydrated: bool,
}

pub(crate) async fn refresh_session_catalog(state: &AppState) -> bool {
    let started_at = Instant::now();
    let expected_stamps = state
        .sessions
        .read()
        .await
        .iter()
        .map(|(id, record)| (id.clone(), record.file_stamp))
        .collect::<HashMap<_, _>>();
    let root = state.session_root.clone();
    let cache = state.session_catalog_cache.clone();
    let Ok(discovered) = tokio::task::spawn_blocking(move || {
        let mut cache = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        discover_sessions_cached(&root, &mut cache)
    })
    .await
    else {
        return false;
    };
    let discover_ms = started_at.elapsed().as_millis() as u64;
    let mut discovered_ids = HashSet::new();
    let categories = state.session_runtime.session_categories_snapshot().await;
    let modes = state.session_runtime.session_modes_snapshot().await;
    let mut sessions = state.sessions.write().await;
    let before = session_summaries_from_map(&sessions);

    for mut session in discovered {
        discovered_ids.insert(session.id.clone());
        // Another refresh may have applied while this scan waited for the lock.
        if sessions.get(&session.id).map(|record| record.file_stamp)
            != expected_stamps.get(&session.id).copied()
        {
            continue;
        }
        let category = categories.get(&session.id).cloned();
        let session_mode = modes.get(&session.id).copied().unwrap_or_default();
        let should_load_goal_mode = match sessions.get(&session.id) {
            Some(record) if record.kind == SessionKind::Available => {
                record.file_stamp != session.file_stamp
            }
            Some(_) => false,
            None => true,
        };
        let already_hydrated = sessions.contains_key(&session.id)
            && state
                .session_catalog_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entries
                .get(Path::new(&session.session_file))
                .is_some_and(|cached| {
                    Some(cached.stamp) == session.file_stamp && cached.messages_hydrated
                });
        if !already_hydrated && should_preload_discovered_session_messages(&sessions, &session) {
            let path = Path::new(&session.session_file);
            #[cfg(test)]
            {
                state
                    .session_catalog_cache
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .transcript_loads += 1;
            }
            let (messages, tool_cards) = read_session_file_messages(path);
            session.messages = messages;
            session.tool_cards = tool_cards;
            session.messages_loaded = true;
            if let Some(cached) = state
                .session_catalog_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entries
                .get_mut(path)
                .filter(|cached| Some(cached.stamp) == session.file_stamp)
            {
                cached.messages_hydrated = true;
            }
        }
        match sessions.get_mut(&session.id) {
            Some(record) if record.kind == SessionKind::Available => {
                let should_reload_messages = session.messages_loaded
                    && (record.file_stamp != session.file_stamp || record.messages.is_empty());
                if record.file_stamp != session.file_stamp && !session.messages_loaded {
                    record.messages.clear();
                    record.tool_cards.clear();
                }
                record.cwd = session.cwd;
                record.created_at = session.created_at;
                record.updated_at = session.updated_at;
                record.reconcile_persisted_recency(session.last_message_at, session.file_stamp);
                record.session_file = Some(session.session_file);
                if session.title.is_some() {
                    record.title = session.title;
                }
                if session.timestamp.is_some() {
                    record.timestamp = session.timestamp;
                }
                record.category = category;
                record.session_mode = session_mode;
                if should_load_goal_mode {
                    record.goal_mode = session.goal_mode;
                }
                if should_reload_messages {
                    record.messages = session.messages;
                    record.tool_cards = session.tool_cards;
                }
            }
            Some(record) => {
                record.reconcile_persisted_recency(session.last_message_at, session.file_stamp);
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
                        last_message_at: session.last_message_at,
                        persisted_message_at: session.last_message_at,
                        file_stamp: session.file_stamp,
                        messages: session.messages,
                        live_message_ids: HashSet::new(),
                        streaming_message: None,
                        is_compacting: false,
                        continuation_pending: false,
                        tool_cards: session.tool_cards,
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
                        pending_ask: None,
                        available_commands: Vec::new(),
                    },
                );
            }
        }
    }

    sessions.retain(|_, record| {
        record.kind != SessionKind::Available
            || discovered_ids.contains(&record.id)
            || expected_stamps.get(&record.id).copied() != Some(record.file_stamp)
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

pub(crate) fn discover_sessions_cached(
    root: &Path,
    cache: &mut SessionCatalogCache,
) -> Vec<DiscoveredSession> {
    cache.seen.clear();
    let mut sessions = Vec::new();
    collect_session_files_cached(root, &mut sessions, cache);
    cache.entries.retain(|path, _| cache.seen.contains(path));
    sessions.sort_by(|a, b| {
        b.last_message_at
            .unwrap_or(b.created_at)
            .cmp(&a.last_message_at.unwrap_or(a.created_at))
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
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
            record.file_stamp != discovered.file_stamp || record.messages.is_empty()
        }
        Some(_) => false,
        None => true,
    }
}

fn collect_session_files_cached(
    path: &Path,
    sessions: &mut Vec<DiscoveredSession>,
    cache: &mut SessionCatalogCache,
) {
    let direct_sessions = collect_direct_session_files(path, cache);
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
            sessions.extend(collect_direct_session_files(&path, cache));
        }
    }
}

fn collect_direct_session_files(
    path: &Path,
    cache: &mut SessionCatalogCache,
) -> Vec<DiscoveredSession> {
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
                read_session_header_cached(&path, cache)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn scan_session_header<I>(lines: &mut I) -> Option<(SessionHeader, Option<String>)>
where
    I: Iterator<Item = std::io::Result<String>>,
{
    let mut prelude_title = None;
    for line in lines.take(16).flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                let header = serde_json::from_value::<SessionHeader>(value).ok()?;
                return Some((header, prelude_title));
            }
            Some("title") if prelude_title.is_none() => {
                prelude_title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .and_then(sanitize_session_title);
            }
            _ => {}
        }
    }
    None
}

#[derive(serde::Deserialize)]
struct GoalModeEntry {
    mode: String,
    data: Option<GoalModeData>,
}

#[derive(serde::Deserialize)]
struct GoalModeData {
    goal: Option<Value>,
}

fn extract_goal_mode_change(entry: GoalModeEntry) -> Option<Option<GoalModeProjection>> {
    match entry.mode.as_str() {
        "none" => Some(None),
        "goal" | "goal_paused" => {
            let goal = entry.data?.goal?;
            let state = serde_json::json!({
                "enabled": entry.mode == "goal",
                "mode": "active",
                "goal": goal,
            });
            map_goal_mode_projection(&state).map(Some)
        }
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
    read_session_header_cached(path, &mut SessionCatalogCache::default())
}

pub(crate) fn read_session_header_cached(
    path: &Path,
    cache: &mut SessionCatalogCache,
) -> Option<DiscoveredSession> {
    cache.seen.insert(path.to_path_buf());
    let metadata = fs::metadata(path).ok()?;
    let stamp = SessionFileStamp::from_metadata(&metadata);
    if let Some(cached) = cache
        .entries
        .get(path)
        .filter(|cached| cached.stamp == stamp)
    {
        return cached.session.clone();
    }
    #[cfg(test)]
    {
        cache.content_scans += 1;
    }
    let session = scan_session_metadata(path, &metadata, stamp);
    // Never mark a racing append/replacement as a complete cached scan.
    if fs::metadata(path)
        .ok()
        .as_ref()
        .map(SessionFileStamp::from_metadata)
        == Some(stamp)
    {
        cache.entries.insert(
            path.to_path_buf(),
            CachedSessionHeader {
                stamp,
                session: session.clone(),
                messages_hydrated: false,
            },
        );
    }
    session
}

fn scan_session_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    stamp: SessionFileStamp,
) -> Option<DiscoveredSession> {
    let file = fs::File::open(path).ok()?;
    let mut reader = StdBufReader::new(file);
    let mut prelude_title = None;
    let mut header = None;
    let mut offset = 0;
    for _ in 0..16 {
        let Some((bytes, line)) = read_json_line::<JournalFact>(&mut reader).ok()? else {
            break;
        };
        offset += bytes;
        let Ok(fact) = line else {
            continue;
        };
        if fact.kind == "session" {
            if fact.id.is_none() {
                return None;
            }
            header = Some(fact);
            break;
        }
        if fact.kind == "title" && prelude_title.is_none() {
            prelude_title = fact.title.as_deref().and_then(sanitize_session_title);
        }
    }
    let header = header?;
    let mut recency = JournalRecency::default();
    let mut first_entry_type = None;
    let mut first_user_offsets = Vec::new();
    let mut mode_offsets = Vec::new();
    let mut after_header = 0;
    loop {
        let entry_offset = offset;
        let Some((bytes, line)) = read_json_line::<JournalFact>(&mut reader).ok()? else {
            break;
        };
        offset += bytes;
        after_header += 1;
        let Ok(fact) = line else {
            continue;
        };
        if after_header <= 8 {
            if first_entry_type.is_none() && !fact.kind.is_empty() {
                first_entry_type = Some(fact.kind.clone());
            }
            if fact.is_user_message() {
                first_user_offsets.push(entry_offset);
            }
        }
        if fact.kind == "mode_change" {
            mode_offsets.push(entry_offset);
        }
        recency.push(fact);
    }
    if first_entry_type.as_deref() == Some("session_init") {
        return None;
    }
    let created_at = header
        .timestamp
        .as_ref()
        .and_then(Timestamp::from_rpc)
        .unwrap_or(Timestamp::UNIX_EPOCH);
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| Timestamp::try_from(time).ok())
        .unwrap_or(created_at);
    let title = header
        .title
        .as_deref()
        .and_then(sanitize_session_title)
        .or(prelude_title)
        .or_else(|| {
            let prompt = first_user_offsets.into_iter().find_map(|offset| {
                reader.seek(SeekFrom::Start(offset)).ok()?;
                let (_, line) = read_json_line::<PromptTitle>(&mut reader).ok()??;
                let entry = line.ok()?;
                entry.message?.content?.0
            })?;
            sanitize_session_title(&prompt)
        });
    let mut goal_mode = None;
    for offset in mode_offsets {
        reader.seek(SeekFrom::Start(offset)).ok()?;
        let Some((_, Ok(entry))) = read_json_line::<GoalModeEntry>(&mut reader).ok()? else {
            continue;
        };
        if let Some(change) = extract_goal_mode_change(entry) {
            goal_mode = change;
        }
    }
    Some(DiscoveredSession {
        preload_index: usize::MAX,
        id: header.id?,
        cwd: header.cwd,
        title,
        timestamp: header
            .timestamp
            .and_then(|value| value.as_str().map(str::to_string)),
        created_at,
        updated_at,
        last_message_at: recency.last_message_at(),
        file_stamp: Some(stamp),
        session_file: path.to_string_lossy().to_string(),
        messages: Vec::new(),
        tool_cards: Vec::new(),
        messages_loaded: false,
        goal_mode,
    })
}

#[derive(serde::Deserialize)]
struct PromptTitle {
    message: Option<PromptTitleMessage>,
}

#[derive(serde::Deserialize)]
struct PromptTitleMessage {
    content: Option<PromptTitleContent>,
}

struct PromptTitleContent(Option<String>);

impl<'de> serde::Deserialize<'de> for PromptTitleContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ContentVisitor;
        impl<'de> serde::de::Visitor<'de> for ContentVisitor {
            type Value = PromptTitleContent;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("user content")
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
                Ok(PromptTitleContent(Some(text.to_string())))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                #[derive(serde::Deserialize)]
                struct Block {
                    text: Option<String>,
                }
                let mut text = None;
                while let Some(block) = sequence.next_element::<Block>()? {
                    if text.is_none() {
                        text = block.text;
                    }
                }
                Ok(PromptTitleContent(text))
            }
        }
        deserializer.deserialize_any(ContentVisitor)
    }
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
    summaries.sort_by(|a, b| {
        b.last_message_at
            .cmp(&a.last_message_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    summaries
}

pub(crate) fn sessions_snapshot_from_map(
    sessions: &HashMap<String, SessionRecord>,
) -> ServerMessage {
    ServerMessage::SessionsSnapshot {
        sessions: session_summaries_from_map(sessions),
    }
}

#[cfg(test)]
mod recency_tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs::FileTimes,
        io::Write,
        time::{Duration, UNIX_EPOCH},
    };

    fn write_session(path: &Path, id: &str, created: Value, entries: &[Value]) {
        let mut file = fs::File::create(path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session","id":id,"timestamp":created,"cwd":"/test","title":id})
        )
        .unwrap();
        for entry in entries {
            writeln!(file, "{entry}").unwrap();
        }
    }

    fn user(id: &str, timestamp: u64) -> Value {
        json!({"type":"message","id":id,"message":{"role":"user","timestamp":timestamp,"content":"prompt"}})
    }

    fn set_mtime(path: &Path, nanos: u64) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_nanos(nanos)))
            .unwrap();
    }

    #[test]
    fn discovery_orders_actual_messages_not_mtime_or_creation() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.jsonl");
        let b = root.path().join("b.jsonl");
        write_session(&a, "a", json!(1000), &[user("a1", 300)]);
        write_session(&b, "b", json!(2000), &[user("b1", 200)]);
        set_mtime(&a, 10_000_000);
        set_mtime(&b, 20_000_000);
        let sessions = discover_sessions_cached(root.path(), &mut SessionCatalogCache::default());
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(sessions[0].last_message_at.unwrap().millis(), 300);
        assert!(sessions[0].updated_at < sessions[1].updated_at);
    }

    #[test]
    fn metadata_append_and_touch_invalidate_without_advancing_conversation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        write_session(&path, "s", json!(10), &[user("a", 100)]);
        let mut cache = SessionCatalogCache::default();
        let before = read_session_header_cached(&path, &mut cache).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"mode_change","id":"m","parentId":"a","mode":"none","timestamp":99999})
        )
        .unwrap();
        let appended = read_session_header_cached(&path, &mut cache).unwrap();
        set_mtime(&path, 50_000_001);
        let touched = read_session_header_cached(&path, &mut cache).unwrap();
        assert_eq!(before.last_message_at, appended.last_message_at);
        assert_eq!(before.last_message_at, touched.last_message_at);
        assert_ne!(before.file_stamp, appended.file_stamp);
        assert_ne!(appended.file_stamp, touched.file_stamp);
        assert_eq!(cache.content_scans, 3);
    }

    #[test]
    fn unchanged_positive_and_excluded_discovery_do_no_content_scans() {
        let root = tempfile::tempdir().unwrap();
        write_session(
            &root.path().join("good.jsonl"),
            "s",
            json!(10),
            &[user("a", 100)],
        );
        write_session(
            &root.path().join("subagent.jsonl"),
            "task",
            json!(20),
            &[json!({"type":"session_init"})],
        );
        let mut cache = SessionCatalogCache::default();
        assert_eq!(discover_sessions_cached(root.path(), &mut cache).len(), 1);
        let scans = cache.content_scans;
        for _ in 0..3 {
            let sessions = discover_sessions_cached(root.path(), &mut cache);
            assert_eq!(sessions[0].last_message_at.unwrap().millis(), 100);
        }
        assert_eq!(
            cache.content_scans, scans,
            "warm discovery must not reopen unchanged logs, including exclusions"
        );
        fs::remove_file(root.path().join("good.jsonl")).unwrap();
        assert!(discover_sessions_cached(root.path(), &mut cache).is_empty());
    }

    #[test]
    fn empty_invalid_and_legacy_times_use_stable_header_or_epoch() {
        let root = tempfile::tempdir().unwrap();
        let empty = root.path().join("empty.jsonl");
        let legacy = root.path().join("legacy.jsonl");
        let invalid = root.path().join("invalid.jsonl");
        write_session(&empty, "empty", json!("2026-01-01T00:00:00Z"), &[]);
        write_session(
            &legacy,
            "legacy",
            json!(123),
            &[json!({"type":"message","message":{"role":"user","content":"undated"}})],
        );
        write_session(
            &invalid,
            "invalid",
            json!("bad"),
            &[
                json!({"type":"message","timestamp":"bad","message":{"role":"assistant","timestamp":-1,"content":"undated"}}),
            ],
        );
        let empty = read_session_header(&empty).unwrap();
        let legacy = read_session_header(&legacy).unwrap();
        let invalid = read_session_header(&invalid).unwrap();
        assert_eq!(empty.last_message_at, None);
        assert_eq!(
            empty.created_at,
            Timestamp::from_rpc("2026-01-01T00:00:00Z").unwrap()
        );
        assert_eq!(legacy.last_message_at, None);
        assert_eq!(legacy.created_at.millis(), 123);
        assert_eq!(invalid.last_message_at, None);
        assert_eq!(invalid.created_at, Timestamp::UNIX_EPOCH);
    }

    #[test]
    fn same_millisecond_changes_invalidate_hydrated_messages() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        write_session(&path, "s", json!(10), &[user("a", 100)]);
        set_mtime(&path, 100_000_001);
        let mut cache = SessionCatalogCache::default();
        let before = read_session_header_cached(&path, &mut cache).unwrap();
        let mut existing =
            crate::opened_session_record(&before, path.to_string_lossy().into_owned(), None, None);
        existing.kind = SessionKind::Available;
        existing.messages = crate::project_omp_transcript(&[
            json!({"role":"user","timestamp":100,"content":"prompt"}),
        ])
        .0;
        write_session(&path, "s", json!(10), &[user("b", 200)]);
        set_mtime(&path, 100_000_002);
        let mut after = read_session_header_cached(&path, &mut cache).unwrap();
        after.preload_index = 0;
        assert_eq!(before.updated_at, after.updated_at);
        assert_ne!(before.file_stamp, after.file_stamp);
        assert_eq!(after.last_message_at.unwrap().millis(), 200);
        assert!(should_preload_discovered_session_messages(
            &HashMap::from([("s".into(), existing)]),
            &after
        ));
    }

    #[cfg(unix)]
    #[test]
    fn replacing_same_size_same_mtime_file_invalidates_by_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let replacement = root.path().join("replacement");
        write_session(&path, "s", json!(10), &[user("a", 100)]);
        write_session(&replacement, "s", json!(10), &[user("b", 200)]);
        set_mtime(&path, 100_000_000);
        set_mtime(&replacement, 100_000_000);
        assert_eq!(
            fs::metadata(&path).unwrap().len(),
            fs::metadata(&replacement).unwrap().len()
        );
        let mut cache = SessionCatalogCache::default();
        let before = read_session_header_cached(&path, &mut cache).unwrap();
        fs::rename(replacement, &path).unwrap();
        let after = read_session_header_cached(&path, &mut cache).unwrap();
        assert_eq!(before.updated_at, after.updated_at);
        assert_ne!(before.file_stamp, after.file_stamp);
        assert_eq!(after.last_message_at.unwrap().millis(), 200);
    }

    #[test]
    fn cached_file_rewind_restores_ancestral_activity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let mut first = user("a", 100);
        first["archived"] = json!(true);
        write_session(&path, "s", json!(10), &[first, user("b", 200)]);
        let mut cache = SessionCatalogCache::default();
        assert_eq!(
            read_session_header_cached(&path, &mut cache)
                .unwrap()
                .last_message_at
                .unwrap()
                .millis(),
            200
        );
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", json!({"type":"branch_summary","id":"r","parentId":"a","timestamp":300,"summary":"rewind"})).unwrap();
        assert_eq!(
            read_session_header_cached(&path, &mut cache)
                .unwrap()
                .last_message_at
                .unwrap()
                .millis(),
            100
        );
    }

    #[test]
    fn title_prelude_and_prompt_fallback_survive_streamed_image_payload() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        fs::write(&path, format!(
            "{{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"image\",\"data\":\"{}\"}}]}}}}\n\
             {{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"timestamp\":100,\"content\":[{{\"type\":\"image\",\"data\":\"{}\"}},{{\"type\":\"text\",\"text\":\"First request\\nDetails\"}}]}}}}\n",
            "x".repeat(1024 * 1024), "x".repeat(1024 * 1024)
        )).unwrap();
        let session = read_session_header(&path).unwrap();
        assert_eq!(session.title.as_deref(), Some("First request"));
        assert_eq!(session.last_message_at.unwrap().millis(), 100);
        fs::write(
            &path,
            concat!(
                "{\"type\":\"title\",\"title\":\"Prelude title\"}\n",
                "{\"type\":\"session\",\"id\":\"s\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"fallback\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            read_session_header(&path).unwrap().title.as_deref(),
            Some("Prelude title")
        );
    }

    #[test]
    fn cached_goal_metadata_changes_without_message_activity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        write_session(
            &path,
            "s",
            json!(10),
            &[
                user("a", 100),
                json!({"type":"mode_change","id":"g","parentId":"a","mode":"goal","timestamp":200,
                "data":{"goal":{"id":"goal-1","objective":"Standing objective","status":"active",
                    "tokenBudget":50000,"tokensUsed":1200,"timeUsedSeconds":90,"createdAt":10,"updatedAt":20}}}),
            ],
        );
        let mut cache = SessionCatalogCache::default();
        let before = read_session_header_cached(&path, &mut cache).unwrap();
        assert_eq!(
            before.goal_mode.as_ref().unwrap().goal.objective,
            "Standing objective"
        );
        let warm = read_session_header_cached(&path, &mut cache).unwrap();
        assert!(warm.goal_mode.unwrap().enabled);
        assert_eq!(cache.content_scans, 1);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"mode_change","id":"off","parentId":"g","mode":"none","timestamp":300})
        )
        .unwrap();
        let after = read_session_header_cached(&path, &mut cache).unwrap();
        assert!(after.goal_mode.is_none());
        assert_eq!(after.last_message_at, before.last_message_at);
        assert_ne!(after.file_stamp, before.file_stamp);
    }
}
