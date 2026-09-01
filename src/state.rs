use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Map, Value};
use tokio::{
    sync::{Mutex, RwLock, broadcast, mpsc, oneshot},
    task::JoinHandle,
};
use tracing::warn;

use crate::{
    CodeWorkspaceRegistry, ControlCandidate, DiffDetailMode, DiffFileSelector,
    DiffReviewWorktreeRegistry, DiffScope, FrontendUiSnapshot, GoalModeProjection,
    PlanModeProjection, PreparedDiff, ProposedModelConfig, ServerMessage, SessionKind, SessionMode,
    SessionProjectionDelta, SessionRecord, SessionStatus, ThinkingVisibilityPreference, Timestamp,
    TodoPhaseProjection, VoiceCommand, append_bridge_debug_event, save_fura_config,
    sessions_snapshot_from_map,
};
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) token: Arc<String>,
    pub(crate) auth_sessions: Arc<RwLock<HashMap<String, AuthSession>>>,
    /// Owner for coupled session/runtime maps; selected top-level aliases below point to the same locks during the staged migration.
    pub(crate) session_runtime: SessionRuntimeState,
    pub(crate) sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    /// Regular prompt payloads waiting for OMP to either start streaming or reject as busy.
    pub(crate) pending_prompt_drafts: Arc<RwLock<HashMap<String, PendingPromptDraft>>>,
    pub(crate) pending_session_change_snapshots:
        Arc<RwLock<HashMap<String, PendingSessionChangesSnapshot>>>,
    pub(crate) code_workspaces: Arc<RwLock<CodeWorkspaceRegistry>>,
    pub(crate) review_worktrees: Arc<RwLock<DiffReviewWorktreeRegistry>>,
    pub(crate) proposed_models: Arc<RwLock<Vec<ProposedModelConfig>>>,
    pub(crate) model_catalog: Arc<RwLock<ModelCatalogState>>,
    pub(crate) bridge_controller: Arc<RwLock<BridgeControllerState>>,
    pub(crate) voice_sessions: Arc<RwLock<HashMap<String, VoiceSessionHandle>>>,
    pub(crate) diff_jobs: Arc<RwLock<DiffJobRegistry>>,
    pub(crate) review_comment_db_path: PathBuf,
    pub(crate) active_review_contexts: Arc<RwLock<HashMap<String, ActiveReviewContext>>>,
    pub(crate) events: WsEventCoordinator,
    pub(crate) session_host_tools: Arc<RwLock<HashMap<String, Vec<Value>>>>,
    pub(crate) rpc_config: Arc<RpcConfig>,
    pub(crate) rust_analyzer_bin: Arc<String>,
    /// Per-rust-root gate that serializes lazy rust-analyzer cold-start spawns so
    /// concurrent navigation requests for the same root do not each launch a
    /// child, while spawns for different roots still proceed in parallel.
    pub(crate) analyzer_spawn_locks: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
    pub(crate) log_frames: bool,
    pub(crate) bridge_debug_file: Option<PathBuf>,
    pub(crate) event_debug_file: Option<PathBuf>,
    pub(crate) forward_raw_frames: bool,
    pub(crate) session_root: PathBuf,
    pub(crate) default_cwd: Arc<RwLock<String>>,
    pub(crate) config_path: Option<PathBuf>,
    pub(crate) voice_language: Arc<RwLock<String>>,
    pub(crate) show_tools: Arc<RwLock<bool>>,
    pub(crate) show_edit_diffs: Arc<RwLock<bool>>,
    pub(crate) thinking_visibility: Arc<RwLock<ThinkingVisibilityPreference>>,
    pub(crate) textile_redmine_root_url: Arc<RwLock<Option<String>>>,
    pub(crate) allowed_origins: Option<Arc<Vec<String>>>,
    pub(crate) secure_auth_cookie: bool,
}
#[derive(Clone)]
pub(crate) struct WsEventCoordinator {
    sender: broadcast::Sender<ServerMessage>,
    gate: Arc<Mutex<()>>,
    pending_deltas: Arc<Mutex<PendingSessionDeltas>>,
    session_seqs: Arc<std::sync::Mutex<HashMap<String, u64>>>,
}

const SESSION_DELTA_THROTTLE_WINDOW: Duration = Duration::from_millis(250);

#[derive(Default)]
struct PendingSessionDeltas {
    sessions: HashMap<String, PendingSessionDelta>,
    order: Vec<String>,
    flush_scheduled: bool,
    flush_generation: u64,
    flush_due_at: Option<Instant>,
}

struct PendingSessionDelta {
    min_replace_from: usize,
}

impl WsEventCoordinator {
    pub(crate) fn new(sender: broadcast::Sender<ServerMessage>) -> Self {
        Self {
            sender,
            gate: Arc::new(Mutex::new(())),
            pending_deltas: Arc::new(Mutex::new(PendingSessionDeltas::default())),
            session_seqs: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.sender.subscribe()
    }

    pub(crate) async fn emit(&self, state: &AppState, message: ServerMessage) {
        self.emit_many(state, vec![message]).await;
    }

    pub(crate) async fn emit_many(&self, state: &AppState, messages: Vec<ServerMessage>) {
        if messages.is_empty() {
            return;
        }

        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let (messages, schedule_generation) = self.prepare_external_messages(state, messages).await;
        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        self.schedule_timer_flush_if_needed(state, schedule_generation);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
    }

    async fn prepare_external_messages(
        &self,
        state: &AppState,
        messages: Vec<ServerMessage>,
    ) -> (Vec<ServerMessage>, Option<u64>) {
        let mut prepared = Vec::with_capacity(messages.len());
        let mut schedule_generation = None;
        let now = Instant::now();
        let sessions = state.sessions.read().await;
        let mut pending = self.pending_deltas.lock().await;

        for message in messages {
            if let ServerMessage::SessionDelta { session_id, state } = message {
                pending.record_delta(&session_id, state.transcript_replace_from);
                if schedule_generation.is_none() {
                    schedule_generation = pending.schedule_flush(now);
                }
            } else {
                prepared.extend(drain_pending_delta_messages_locked(&mut pending, &sessions));
                prepared.push(message);
            }
        }

        (prepared, schedule_generation)
    }

    fn schedule_timer_flush_if_needed(&self, state: &AppState, generation: Option<u64>) {
        if let Some(generation) = generation {
            let coordinator = self.clone();
            let state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(SESSION_DELTA_THROTTLE_WINDOW).await;
                coordinator
                    .flush_pending_deltas_for_timer(&state, generation)
                    .await;
            });
        }
    }

    fn send_all(&self, messages: impl IntoIterator<Item = ServerMessage>) {
        let mut seqs = self
            .session_seqs
            .lock()
            .expect("session seq map should not be poisoned");
        for mut message in messages {
            stamp_session_seq(&mut seqs, &mut message);
            let _ = self.sender.send(message);
        }
    }

    pub(crate) async fn mutate_session_snapshot<F>(
        &self,
        state: &AppState,
        session_id: &str,
        mutate: F,
    ) -> bool
    where
        F: FnOnce(&mut SessionRecord),
    {
        self.mutate_session_and_emit(state, session_id, |record| {
            mutate(record);
            Some(ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            })
        })
        .await
    }

    pub(crate) async fn mutate_session_delta<F>(
        &self,
        state: &AppState,
        session_id: &str,
        build_delta: F,
    ) -> bool
    where
        F: FnOnce(&mut SessionRecord) -> Option<SessionProjectionDelta>,
    {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let (messages, schedule_generation) = {
            let mut sessions = state.sessions.write().await;
            let Some(record) = sessions.get_mut(session_id) else {
                return false;
            };
            let Some(delta) = build_delta(record) else {
                return false;
            };
            let mut pending = self.pending_deltas.lock().await;
            pending.record_delta(session_id, delta.transcript_replace_from);
            if pending.flush_due(started_at) {
                (
                    drain_pending_delta_messages_locked(&mut pending, &sessions),
                    None,
                )
            } else {
                (Vec::new(), pending.schedule_flush(started_at))
            }
        };

        if !messages.is_empty() {
            let fields = session_event_timing_fields(started_at, &messages);
            self.send_all(messages);
            drop(_event_guard);
            append_bridge_debug_event(state, "session_event.emit", fields).await;
        } else {
            drop(_event_guard);
        }

        self.schedule_timer_flush_if_needed(state, schedule_generation);
        true
    }

    pub(crate) async fn mutate_session_and_emit<F>(
        &self,
        state: &AppState,
        session_id: &str,
        build: F,
    ) -> bool
    where
        F: FnOnce(&mut SessionRecord) -> Option<ServerMessage>,
    {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let messages = {
            let mut sessions = state.sessions.write().await;
            let Some(record) = sessions.get_mut(session_id) else {
                return false;
            };
            let Some(message) = build(record) else {
                return false;
            };
            let mut pending = self.pending_deltas.lock().await;
            let mut messages = drain_pending_delta_messages_locked(&mut pending, &sessions);
            messages.push(message);
            messages
        };

        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
        true
    }

    pub(crate) async fn mutate_sessions_and_emit<F>(&self, state: &AppState, build: F) -> usize
    where
        F: FnOnce(&mut HashMap<String, SessionRecord>) -> Vec<ServerMessage>,
    {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let (sent, messages) = {
            let mut sessions = state.sessions.write().await;
            let mut messages = build(&mut sessions);
            let sent = messages.len();
            if !messages.is_empty() {
                let mut pending = self.pending_deltas.lock().await;
                let mut flushed = drain_pending_delta_messages_locked(&mut pending, &sessions);
                flushed.append(&mut messages);
                messages = flushed;
            }
            (sent, messages)
        };
        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
        sent
    }

    pub(crate) async fn coordinate_sessions_and_emit<R, F>(&self, state: &AppState, build: F) -> R
    where
        F: FnOnce(&mut HashMap<String, SessionRecord>) -> (R, Vec<ServerMessage>),
    {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let (result, messages) = {
            let mut sessions = state.sessions.write().await;
            let (result, mut messages) = build(&mut sessions);
            if !messages.is_empty() {
                let mut pending = self.pending_deltas.lock().await;
                let mut flushed = drain_pending_delta_messages_locked(&mut pending, &sessions);
                flushed.append(&mut messages);
                messages = flushed;
            }
            (result, messages)
        };
        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
        result
    }

    pub(crate) async fn emit_current_session_snapshot(
        &self,
        state: &AppState,
        session_id: &str,
    ) -> bool {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let messages = {
            let sessions = state.sessions.read().await;
            let Some(record) = sessions.get(session_id) else {
                return false;
            };
            let mut pending = self.pending_deltas.lock().await;
            let mut messages = drain_pending_delta_messages_locked(&mut pending, &sessions);
            messages.push(ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            });
            messages
        };
        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
        true
    }

    pub(crate) async fn emit_sessions_snapshot(&self, state: &AppState) {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let messages = {
            let sessions = state.sessions.read().await;
            let mut pending = self.pending_deltas.lock().await;
            let mut messages = drain_pending_delta_messages_locked(&mut pending, &sessions);
            messages.push(sessions_snapshot_from_map(&sessions));
            messages
        };
        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
    }

    async fn flush_pending_deltas_for_timer(&self, state: &AppState, generation: u64) {
        let started_at = Instant::now();
        let _event_guard = self.gate.lock().await;
        let messages = {
            let sessions = state.sessions.read().await;
            let mut pending = self.pending_deltas.lock().await;
            if !pending.flush_scheduled || pending.flush_generation != generation {
                return;
            }
            drain_pending_delta_messages_locked(&mut pending, &sessions)
        };

        if messages.is_empty() {
            return;
        }

        let fields = session_event_timing_fields(started_at, &messages);
        self.send_all(messages);
        drop(_event_guard);
        append_bridge_debug_event(state, "session_event.emit", fields).await;
    }
}

impl PendingSessionDeltas {
    fn record_delta(&mut self, session_id: &str, replace_from: usize) {
        if let Some(pending) = self.sessions.get_mut(session_id) {
            pending.min_replace_from = pending.min_replace_from.min(replace_from);
            return;
        }

        self.order.push(session_id.to_string());
        self.sessions.insert(
            session_id.to_string(),
            PendingSessionDelta {
                min_replace_from: replace_from,
            },
        );
    }

    fn schedule_flush(&mut self, now: Instant) -> Option<u64> {
        if self.flush_scheduled {
            return None;
        }

        self.flush_scheduled = true;
        self.flush_due_at = Some(now + SESSION_DELTA_THROTTLE_WINDOW);
        self.flush_generation = self.flush_generation.wrapping_add(1);
        Some(self.flush_generation)
    }

    fn flush_due(&self, now: Instant) -> bool {
        self.flush_scheduled && self.flush_due_at.is_some_and(|due_at| now >= due_at)
    }
}

/// Stamp the per-session broadcast sequence onto an outgoing snapshot/delta so
/// clients can detect dropped/missed messages (disconnect, broadcast lag,
/// conflation) and request a fresh snapshot. A snapshot carries the absolute
/// `seq`; a delta carries the `base_seq` it must apply on top of plus the new
/// `seq`. Every broadcast advances the counter by one, so a client whose stored
/// seq does not equal a delta's `base_seq` knows it has a gap.
fn stamp_session_seq(seqs: &mut HashMap<String, u64>, message: &mut ServerMessage) {
    match message {
        ServerMessage::SessionSnapshot { session_id, state } => {
            let seq = seqs.entry(session_id.clone()).or_insert(0);
            *seq += 1;
            state.seq = *seq;
        }
        ServerMessage::SessionDelta { session_id, state } => {
            let seq = seqs.entry(session_id.clone()).or_insert(0);
            state.base_seq = *seq;
            *seq += 1;
            state.seq = *seq;
        }
        _ => {}
    }
}

fn drain_pending_delta_messages_locked(
    pending: &mut PendingSessionDeltas,
    sessions: &HashMap<String, SessionRecord>,
) -> Vec<ServerMessage> {
    pending.flush_scheduled = false;
    pending.flush_due_at = None;
    let pending_by_session = std::mem::take(&mut pending.sessions);
    let pending_order = std::mem::take(&mut pending.order);
    let mut messages = Vec::with_capacity(pending_by_session.len());

    for session_id in pending_order {
        let Some(pending_delta) = pending_by_session.get(&session_id) else {
            continue;
        };
        let Some(record) = sessions.get(&session_id) else {
            continue;
        };
        let projection = record.projection();
        let replace_from = pending_delta
            .min_replace_from
            .min(projection.transcript.len());
        messages.push(ServerMessage::SessionDelta {
            session_id,
            state: SessionProjectionDelta::from_projection_replace_tail(replace_from, &projection),
        });
    }

    messages
}

fn session_event_timing_fields(
    started_at: Instant,
    messages: &[ServerMessage],
) -> Map<String, Value> {
    let mut fields = Map::new();
    fields.insert(
        "durationMs".to_string(),
        Value::Number((started_at.elapsed().as_millis() as u64).into()),
    );
    fields.insert(
        "messageCount".to_string(),
        Value::Number((messages.len() as u64).into()),
    );

    let mut message_types = Vec::new();
    let mut session_id = None;
    let mut transcript_len = None;
    let mut session_count = None;
    for message in messages {
        message_types.push(Value::String(
            session_event_message_type(message).to_string(),
        ));
        match message {
            ServerMessage::SessionSnapshot {
                session_id: id,
                state,
            } => {
                if session_id.is_none() {
                    session_id = Some(id.clone());
                }
                if transcript_len.is_none() {
                    transcript_len = Some(state.transcript.len() as u64);
                }
            }
            ServerMessage::SessionDelta {
                session_id: id,
                state,
            } => {
                if session_id.is_none() {
                    session_id = Some(id.clone());
                }
                if transcript_len.is_none() {
                    transcript_len = Some(
                        state.transcript_replace_from as u64 + state.transcript_append.len() as u64,
                    );
                }
            }
            ServerMessage::SessionsSnapshot { sessions } => {
                if session_count.is_none() {
                    session_count = Some(sessions.len() as u64);
                }
            }
            _ => {}
        }
    }

    fields.insert("messageTypes".to_string(), Value::Array(message_types));
    if let Some(session_id) = session_id {
        fields.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(transcript_len) = transcript_len {
        fields.insert(
            "transcriptLen".to_string(),
            Value::Number(transcript_len.into()),
        );
    }
    if let Some(session_count) = session_count {
        fields.insert(
            "sessionCount".to_string(),
            Value::Number(session_count.into()),
        );
    }
    fields
}

fn session_event_message_type(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::SessionsSnapshot { .. } => "sessions.snapshot",
        ServerMessage::SessionSnapshot { .. } => "session.snapshot",
        ServerMessage::SessionDelta { .. } => "session.delta",
        ServerMessage::PlanReview { .. } => "plan.review",
        ServerMessage::SessionExited { .. } => "session.exited",
        _ => "other",
    }
}

#[derive(Clone)]
pub(crate) struct SessionRuntimeState {
    pub(crate) sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    pub(crate) rpc_sessions: Arc<RwLock<HashMap<String, RpcSessionHandle>>>,
    pub(crate) rpc_session_targets: Arc<RwLock<HashMap<String, String>>>,
    /// Persisted Fura-owned session metadata, keyed by OMP session id.
    pub(crate) session_categories: Arc<RwLock<HashMap<String, String>>>,
    pub(crate) session_modes: Arc<RwLock<HashMap<String, SessionMode>>>,
    /// Metadata for a newly spawned RPC child before OMP reports its real session id.
    pub(crate) pending_created_sessions: Arc<RwLock<HashMap<String, PendingCreatedSession>>>,
    pub(crate) recent_rpc_stderr: Arc<RwLock<HashMap<String, Vec<String>>>>,
    /// Name to apply after a session switch or in-place handoff on this transport.
    pub(crate) pending_new_session_names: Arc<RwLock<HashMap<String, String>>>,
    /// Approved plan metadata waiting for / attached to the execution session spawned by OMP.
    pub(crate) plan_execution_carryovers: Arc<RwLock<HashMap<String, PlanExecutionCarryover>>>,
    pub(crate) rpc_protocol_versions: Arc<RwLock<HashMap<String, u8>>>,
    pub(crate) pending_rpc_message_pages: Arc<RwLock<HashMap<String, PendingRpcMessagesPage>>>,
    pub(crate) btw_requests: Arc<RwLock<HashMap<String, BtwRequestRoute>>>,
    pub(crate) pending_btw_commands: Arc<RwLock<HashMap<String, PendingBtwCommand>>>,
    /// `/compact` requests routed through OMP's builtin slash-command handler, keyed by RPC command id.
    pub(crate) pending_compaction_commands: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingRpcMessagesPage {
    pub(crate) transport_session_id: String,
    pub(crate) messages: Vec<Value>,
    pub(crate) restart_count: u8,
}

#[derive(Clone, Debug)]
pub(crate) struct BtwRequestRoute {
    pub(crate) target_client_id: String,
    pub(crate) owner_connection_id: u64,
    pub(crate) source_session_id: String,
    pub(crate) transport_session_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PendingBtwCommandKind {
    Start,
    Cancel,
    Release,
    Promote,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingBtwCommand {
    pub(crate) btw_id: String,
    pub(crate) kind: PendingBtwCommandKind,
}

pub(crate) struct RemovedRpcTransport {
    pub(crate) handle: RpcSessionHandle,
    pub(crate) target_session_id: String,
    pub(crate) btw_requests: Vec<(String, BtwRequestRoute)>,
}

impl SessionRuntimeState {
    pub(crate) fn new(
        session_categories: HashMap<String, String>,
        session_modes: HashMap<String, SessionMode>,
    ) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_session_targets: Arc::new(RwLock::new(HashMap::new())),
            session_categories: Arc::new(RwLock::new(session_categories)),
            session_modes: Arc::new(RwLock::new(session_modes)),
            pending_created_sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_new_session_names: Arc::new(RwLock::new(HashMap::new())),
            recent_rpc_stderr: Arc::new(RwLock::new(HashMap::new())),
            plan_execution_carryovers: Arc::new(RwLock::new(HashMap::new())),
            rpc_protocol_versions: Arc::new(RwLock::new(HashMap::new())),
            pending_rpc_message_pages: Arc::new(RwLock::new(HashMap::new())),
            btw_requests: Arc::new(RwLock::new(HashMap::new())),
            pending_btw_commands: Arc::new(RwLock::new(HashMap::new())),
            pending_compaction_commands: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn register_transport(
        &self,
        transport_session_id: String,
        handle: RpcSessionHandle,
    ) {
        self.rpc_sessions
            .write()
            .await
            .insert(transport_session_id.clone(), handle);
        self.rpc_session_targets
            .write()
            .await
            .insert(transport_session_id.clone(), transport_session_id);
    }

    pub(crate) async fn map_transport_to_session(
        &self,
        transport_session_id: &str,
        target_session_id: String,
    ) {
        self.rpc_session_targets
            .write()
            .await
            .insert(transport_session_id.to_string(), target_session_id);
    }

    pub(crate) async fn remove_transport(
        &self,
        transport_session_id: &str,
    ) -> Option<RemovedRpcTransport> {
        let handle = self
            .rpc_sessions
            .write()
            .await
            .remove(transport_session_id)?;
        let target_session_id = self
            .rpc_session_targets
            .write()
            .await
            .remove(transport_session_id)
            .unwrap_or_else(|| transport_session_id.to_string());
        self.rpc_protocol_versions
            .write()
            .await
            .remove(transport_session_id);
        self.pending_rpc_message_pages
            .write()
            .await
            .retain(|_request_id, pending| pending.transport_session_id != transport_session_id);
        let btw_requests = {
            let mut requests = self.btw_requests.write().await;
            let ids = requests
                .iter()
                .filter(|(_btw_id, route)| route.transport_session_id == transport_session_id)
                .map(|(btw_id, _route)| btw_id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|btw_id| requests.remove(&btw_id).map(|route| (btw_id, route)))
                .collect::<Vec<_>>()
        };
        let removed_btw_ids = btw_requests
            .iter()
            .map(|(btw_id, _route)| btw_id.as_str())
            .collect::<HashSet<_>>();
        self.pending_btw_commands
            .write()
            .await
            .retain(|_id, command| !removed_btw_ids.contains(command.btw_id.as_str()));
        self.pending_compaction_commands
            .write()
            .await
            .retain(|_id, session_id| session_id != &target_session_id);
        Some(RemovedRpcTransport {
            handle,
            target_session_id,
            btw_requests,
        })
    }

    pub(crate) async fn target_session_id_for_transport(
        &self,
        transport_session_id: &str,
    ) -> String {
        self.rpc_session_targets
            .read()
            .await
            .get(transport_session_id)
            .cloned()
            .unwrap_or_else(|| transport_session_id.to_string())
    }

    pub(crate) async fn transport_session_id_for(&self, session_id: &str) -> Option<String> {
        let (direct_target, target_transport) = {
            let targets = self.rpc_session_targets.read().await;
            (
                targets.get(session_id).cloned(),
                targets
                    .iter()
                    .find(|(_, target_id)| target_id.as_str() == session_id)
                    .map(|(transport_id, _)| transport_id.clone()),
            )
        };

        if let Some(transport_id) = target_transport {
            return Some(transport_id);
        }

        if direct_target.is_some() {
            if self.sessions.read().await.contains_key(session_id) {
                return None;
            }
            return self
                .rpc_sessions
                .read()
                .await
                .contains_key(session_id)
                .then(|| session_id.to_string());
        }

        Some(session_id.to_string())
    }

    pub(crate) async fn contains_transport(&self, transport_session_id: &str) -> bool {
        self.rpc_sessions
            .read()
            .await
            .contains_key(transport_session_id)
    }

    pub(crate) fn try_contains_transport(&self, transport_session_id: &str) -> bool {
        self.rpc_sessions
            .try_read()
            .map(|sessions| sessions.contains_key(transport_session_id))
            .unwrap_or(false)
    }

    pub(crate) async fn stdin_for_transport(
        &self,
        transport_session_id: &str,
    ) -> Option<mpsc::Sender<Value>> {
        self.rpc_sessions
            .read()
            .await
            .get(transport_session_id)
            .map(|handle| handle.stdin.clone())
    }

    pub(crate) async fn set_rpc_protocol_version(&self, transport_session_id: &str, version: u8) {
        self.rpc_protocol_versions
            .write()
            .await
            .insert(transport_session_id.to_string(), version);
    }
    pub(crate) async fn has_rpc_protocol_version(&self, transport_session_id: &str) -> bool {
        self.rpc_protocol_versions
            .read()
            .await
            .contains_key(transport_session_id)
    }

    pub(crate) async fn rpc_protocol_version(&self, transport_session_id: &str) -> u8 {
        self.rpc_protocol_versions
            .read()
            .await
            .get(transport_session_id)
            .copied()
            .unwrap_or(1)
    }

    pub(crate) async fn insert_pending_rpc_message_page(
        &self,
        request_id: String,
        pending: PendingRpcMessagesPage,
    ) {
        self.pending_rpc_message_pages
            .write()
            .await
            .insert(request_id, pending);
    }

    pub(crate) async fn take_pending_rpc_message_page(
        &self,
        request_id: &str,
    ) -> Option<PendingRpcMessagesPage> {
        self.pending_rpc_message_pages
            .write()
            .await
            .remove(request_id)
    }

    pub(crate) async fn clear_pending_rpc_message_pages_for_transport(
        &self,
        transport_session_id: &str,
    ) {
        self.pending_rpc_message_pages
            .write()
            .await
            .retain(|_request_id, pending| pending.transport_session_id != transport_session_id);
    }

    pub(crate) async fn insert_btw_request(&self, btw_id: String, route: BtwRequestRoute) -> bool {
        let mut requests = self.btw_requests.write().await;
        if requests.contains_key(&btw_id) {
            return false;
        }
        requests.insert(btw_id, route);
        true
    }

    pub(crate) async fn btw_request(&self, btw_id: &str) -> Option<BtwRequestRoute> {
        self.btw_requests.read().await.get(btw_id).cloned()
    }

    pub(crate) async fn btw_requests_for_owner(
        &self,
        owner_connection_id: u64,
    ) -> Vec<(String, BtwRequestRoute)> {
        self.btw_requests
            .read()
            .await
            .iter()
            .filter(|(_btw_id, route)| route.owner_connection_id == owner_connection_id)
            .map(|(btw_id, route)| (btw_id.clone(), route.clone()))
            .collect()
    }

    pub(crate) async fn remove_btw_request(&self, btw_id: &str) -> Option<BtwRequestRoute> {
        self.btw_requests.write().await.remove(btw_id)
    }

    pub(crate) async fn insert_pending_btw_command(
        &self,
        command_id: String,
        command: PendingBtwCommand,
    ) {
        self.pending_btw_commands
            .write()
            .await
            .insert(command_id, command);
    }

    pub(crate) async fn take_pending_btw_command(
        &self,
        command_id: &str,
    ) -> Option<PendingBtwCommand> {
        self.pending_btw_commands.write().await.remove(command_id)
    }

    pub(crate) async fn insert_pending_compaction_command(
        &self,
        command_id: String,
        session_id: String,
    ) {
        self.pending_compaction_commands
            .write()
            .await
            .insert(command_id, session_id);
    }

    pub(crate) async fn take_pending_compaction_command(&self, command_id: &str) -> Option<String> {
        self.pending_compaction_commands
            .write()
            .await
            .remove(command_id)
    }

    pub(crate) async fn register_pending_create(
        &self,
        transport_session_id: String,
        pending: PendingCreatedSession,
    ) {
        self.pending_created_sessions
            .write()
            .await
            .insert(transport_session_id, pending);
    }

    pub(crate) async fn pending_create(
        &self,
        transport_session_id: &str,
    ) -> Option<PendingCreatedSession> {
        self.pending_created_sessions
            .read()
            .await
            .get(transport_session_id)
            .cloned()
    }

    pub(crate) async fn remove_pending_create(
        &self,
        transport_session_id: &str,
    ) -> Option<PendingCreatedSession> {
        self.pending_created_sessions
            .write()
            .await
            .remove(transport_session_id)
    }

    pub(crate) async fn remember_rpc_stderr(
        &self,
        transport_session_id: &str,
        line: String,
        line_limit: usize,
    ) {
        let mut recent = self.recent_rpc_stderr.write().await;
        let lines = recent
            .entry(transport_session_id.to_string())
            .or_insert_with(Vec::new);
        if lines.len() == line_limit {
            lines.remove(0);
        }
        lines.push(line);
    }

    pub(crate) async fn take_recent_rpc_stderr(&self, transport_session_id: &str) -> Vec<String> {
        self.recent_rpc_stderr
            .write()
            .await
            .remove(transport_session_id)
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) async fn has_pending_create(&self, transport_session_id: &str) -> bool {
        self.pending_created_sessions
            .read()
            .await
            .contains_key(transport_session_id)
    }

    pub(crate) async fn set_pending_session_name(
        &self,
        transport_session_id: String,
        name: String,
    ) {
        self.pending_new_session_names
            .write()
            .await
            .insert(transport_session_id, name);
    }

    pub(crate) async fn pending_session_name(&self, transport_session_id: &str) -> Option<String> {
        self.pending_new_session_names
            .read()
            .await
            .get(transport_session_id)
            .cloned()
    }

    pub(crate) async fn remove_pending_session_name(
        &self,
        transport_session_id: &str,
    ) -> Option<String> {
        self.pending_new_session_names
            .write()
            .await
            .remove(transport_session_id)
    }

    #[cfg(test)]
    pub(crate) async fn has_pending_session_name(&self, transport_session_id: &str) -> bool {
        self.pending_new_session_names
            .read()
            .await
            .contains_key(transport_session_id)
    }

    pub(crate) async fn set_plan_execution_carryover(
        &self,
        session_id: String,
        carryover: PlanExecutionCarryover,
    ) {
        self.plan_execution_carryovers
            .write()
            .await
            .insert(session_id, carryover);
    }

    pub(crate) async fn plan_execution_carryover(
        &self,
        session_id: &str,
    ) -> Option<PlanExecutionCarryover> {
        self.plan_execution_carryovers
            .read()
            .await
            .get(session_id)
            .cloned()
    }

    pub(crate) async fn remove_plan_execution_carryover(
        &self,
        session_id: &str,
    ) -> Option<PlanExecutionCarryover> {
        self.plan_execution_carryovers
            .write()
            .await
            .remove(session_id)
    }

    pub(crate) async fn session_categories_snapshot(&self) -> HashMap<String, String> {
        self.session_categories.read().await.clone()
    }

    pub(crate) async fn session_modes_snapshot(&self) -> HashMap<String, SessionMode> {
        self.session_modes.read().await.clone()
    }

    pub(crate) async fn session_category(&self, session_id: &str) -> Option<String> {
        self.session_categories
            .read()
            .await
            .get(session_id)
            .cloned()
    }

    pub(crate) async fn set_session_category(&self, session_id: String, category: Option<String>) {
        let mut categories = self.session_categories.write().await;
        if let Some(category) = category {
            categories.insert(session_id, category);
        } else {
            categories.remove(&session_id);
        }
    }

    pub(crate) async fn set_remapped_session_metadata(
        &self,
        session_id: String,
        category: Option<String>,
        session_mode: SessionMode,
    ) {
        self.set_session_category(session_id.clone(), category)
            .await;
        let mut modes = self.session_modes.write().await;
        if session_mode == SessionMode::Standard {
            modes.remove(&session_id);
        } else {
            modes.insert(session_id, session_mode);
        }
    }

    pub(crate) async fn prune_session_metadata(
        &self,
        retained_session_ids: &std::collections::HashSet<String>,
    ) -> bool {
        let mut changed = false;
        {
            let mut categories = self.session_categories.write().await;
            let before_len = categories.len();
            categories.retain(|session_id, _| retained_session_ids.contains(session_id));
            changed |= categories.len() != before_len;
        }
        {
            let mut modes = self.session_modes.write().await;
            let before_len = modes.len();
            modes.retain(|session_id, mode| {
                retained_session_ids.contains(session_id) && *mode != SessionMode::Standard
            });
            changed |= modes.len() != before_len;
        }
        changed
    }

    #[cfg(test)]
    pub(crate) async fn extend_session_metadata(
        &self,
        categories: impl IntoIterator<Item = (String, String)>,
        modes: impl IntoIterator<Item = (String, SessionMode)>,
    ) {
        self.session_categories.write().await.extend(categories);
        self.session_modes.write().await.extend(modes);
    }

    #[cfg(test)]
    pub(crate) async fn has_session_category(&self, session_id: &str) -> bool {
        self.session_categories
            .read()
            .await
            .contains_key(session_id)
    }

    #[cfg(test)]
    pub(crate) async fn session_mode(&self, session_id: &str) -> Option<SessionMode> {
        self.session_modes.read().await.get(session_id).copied()
    }
}

pub(crate) fn apply_rpc_state_to_record(
    record: &mut SessionRecord,
    is_streaming: bool,
    is_compacting: bool,
    session_name: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
    session_file: Option<String>,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    plan_mode: Option<Option<PlanModeProjection>>,
    goal_mode: Option<Option<GoalModeProjection>>,
    todo_phases: Option<Vec<TodoPhaseProjection>>,
) {
    record.status = if is_streaming {
        SessionStatus::Busy
    } else {
        SessionStatus::Idle
    };
    record.is_compacting = is_compacting;
    if let Some(name) = session_name {
        if record.title.is_none() || record.title.as_deref() != Some(&name) {
            record.title = Some(name);
        }
    }
    if let Some(model) = model {
        record.model = Some(model);
    }
    if let Some(thinking_level) = thinking_level {
        record.thinking_level = Some(thinking_level);
    }
    if let Some(session_file) = session_file {
        record.session_file = Some(session_file);
    }
    record.context_tokens = context_tokens;
    record.context_window = context_window;
    record.context_percent = context_percent;
    if let Some(plan_mode) = plan_mode {
        let keep_pending_plan = plan_mode.as_ref().is_some_and(|mode| mode.enabled);
        record.plan_mode = plan_mode;
        if !keep_pending_plan {
            record.pending_plan_review = None;
        }
    }
    if let Some(goal_mode) = goal_mode {
        record.goal_mode = goal_mode;
    }
    if let Some(todo_phases) = todo_phases {
        record.todo_phases = Some(todo_phases);
    }
}

pub(crate) struct RpcStateUpdate {
    pub(crate) current_session_id: String,
    pub(crate) target_session_id: String,
    pub(crate) is_streaming: bool,
    pub(crate) is_compacting: bool,
    pub(crate) session_name: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) session_file: Option<String>,
    pub(crate) context_tokens: Option<u64>,
    pub(crate) context_window: Option<u64>,
    pub(crate) context_percent: Option<f64>,
    pub(crate) plan_mode: Option<Option<PlanModeProjection>>,
    pub(crate) goal_mode: Option<Option<GoalModeProjection>>,
    pub(crate) todo_phases: Option<Vec<TodoPhaseProjection>>,
}

pub(crate) async fn apply_get_state_update(
    state: &AppState,
    transport_session_id: &str,
    update: RpcStateUpdate,
) {
    let target_changed = update.target_session_id != update.current_session_id;
    let pending_create = if target_changed {
        state
            .session_runtime
            .remove_pending_create(&update.current_session_id)
            .await
    } else {
        None
    };
    let pending_switch_name = if target_changed {
        state
            .session_runtime
            .remove_pending_session_name(&update.current_session_id)
            .await
    } else {
        None
    };
    let pending_plan_execution = if target_changed {
        state
            .session_runtime
            .remove_plan_execution_carryover(&update.current_session_id)
            .await
    } else {
        None
    };
    let effective_session_name = pending_switch_name.clone().or(update.session_name);

    state
        .events
        .coordinate_sessions_and_emit(state, |sessions| {
            let (previous_snapshot, target_snapshot) = if target_changed {
                let source = sessions.get(&update.current_session_id).cloned();
                let previous_snapshot =
                    sessions.get_mut(&update.current_session_id).map(|record| {
                        record.status = SessionStatus::Available;
                        record.continuation_pending = false;
                        record.kind = SessionKind::Available;
                        record.streaming_message = None;
                        record.live_message_ids.clear();
                        ServerMessage::SessionSnapshot {
                            session_id: update.current_session_id.clone(),
                            state: record.projection(),
                        }
                    });

                sessions
                    .entry(update.target_session_id.clone())
                    .and_modify(|record| {
                        record.status = SessionStatus::Idle;
                        record.continuation_pending = false;
                        record.kind = SessionKind::Managed;
                        record.streaming_message = None;
                        record.live_message_ids.clear();
                        if record.worktree.is_none() {
                            record.worktree = pending_create
                                .as_ref()
                                .and_then(|pending| pending.worktree.clone());
                        }
                        if let Some(pending) = pending_create.as_ref() {
                            record.session_mode = pending.session_mode;
                        }
                    })
                    .or_insert_with(|| {
                        let now = Timestamp::now();
                        let created_at = source
                            .as_ref()
                            .map(|record| record.created_at)
                            .or_else(|| pending_create.as_ref().map(|pending| pending.created_at))
                            .unwrap_or(now);
                        SessionRecord {
                            id: update.target_session_id.clone(),
                            cwd: source
                                .as_ref()
                                .and_then(|record| record.cwd.clone())
                                .or_else(|| {
                                    pending_create
                                        .as_ref()
                                        .and_then(|pending| pending.cwd.clone())
                                }),
                            args: source
                                .as_ref()
                                .map(|record| record.args.clone())
                                .or_else(|| {
                                    pending_create.as_ref().map(|pending| pending.args.clone())
                                })
                                .unwrap_or_default(),
                            status: SessionStatus::Idle,
                            created_at,
                            updated_at: now,
                            messages: Vec::new(),
                            live_message_ids: HashSet::new(),
                            streaming_message: None,
                            is_compacting: false,
                            continuation_pending: false,
                            tool_cards: Vec::new(),
                            active_tool_calls: Vec::new(),
                            todo_phases: None,
                            kind: SessionKind::Managed,
                            session_mode: source
                                .as_ref()
                                .map(|record| record.session_mode)
                                .or_else(|| {
                                    pending_create.as_ref().map(|pending| pending.session_mode)
                                })
                                .unwrap_or_default(),
                            session_file: None,
                            title: pending_create
                                .as_ref()
                                .and_then(|pending| pending.title.clone())
                                .or_else(|| pending_switch_name.clone()),
                            timestamp: None,
                            category: source
                                .as_ref()
                                .and_then(|record| record.category.clone())
                                .or_else(|| {
                                    pending_create
                                        .as_ref()
                                        .and_then(|pending| pending.category.clone())
                                }),
                            worktree: source
                                .as_ref()
                                .and_then(|record| record.worktree.clone())
                                .or_else(|| {
                                    pending_create
                                        .as_ref()
                                        .and_then(|pending| pending.worktree.clone())
                                }),
                            model: None,
                            thinking_level: None,
                            tokens_total: 0,
                            cost_usd: 0.0,
                            context_tokens: None,
                            context_window: None,
                            context_percent: None,
                            plan_mode: None,
                            goal_mode: None,
                            pending_plan_review: None,
                            pending_ask: None,
                            available_commands: Vec::new(),
                        }
                    });

                if let Some(record) = sessions.get_mut(&update.target_session_id) {
                    apply_rpc_state_to_record(
                        record,
                        update.is_streaming,
                        update.is_compacting,
                        effective_session_name,
                        update.model,
                        update.thinking_level,
                        update.session_file,
                        update.context_tokens,
                        update.context_window,
                        update.context_percent,
                        update.plan_mode.clone(),
                        update.goal_mode.clone(),
                        update.todo_phases.clone(),
                    );
                }

                let target_snapshot = sessions.get(&update.target_session_id).map(|record| {
                    ServerMessage::SessionSnapshot {
                        session_id: update.target_session_id.clone(),
                        state: record.projection(),
                    }
                });
                (previous_snapshot, target_snapshot)
            } else {
                if let Some(record) = sessions.get_mut(&update.target_session_id) {
                    apply_rpc_state_to_record(
                        record,
                        update.is_streaming,
                        update.is_compacting,
                        effective_session_name,
                        update.model,
                        update.thinking_level,
                        update.session_file,
                        update.context_tokens,
                        update.context_window,
                        update.context_percent,
                        update.plan_mode,
                        update.goal_mode,
                        update.todo_phases,
                    );
                }
                let target_snapshot = sessions.get(&update.target_session_id).map(|record| {
                    ServerMessage::SessionSnapshot {
                        session_id: update.target_session_id.clone(),
                        state: record.projection(),
                    }
                });
                (None, target_snapshot)
            };

            let mut messages = Vec::with_capacity(2);
            if let Some(snapshot) = previous_snapshot {
                messages.push(snapshot);
            }
            if let Some(snapshot) = target_snapshot {
                messages.push(snapshot);
            }
            ((), messages)
        })
        .await;

    let (target_category, target_mode) = if target_changed {
        let sessions = state.sessions.read().await;
        sessions
            .get(&update.target_session_id)
            .map(|record| (record.category.clone(), record.session_mode))
            .unwrap_or((None, SessionMode::Standard))
    } else {
        (None, SessionMode::Standard)
    };
    if let Some(plan_execution) = pending_plan_execution {
        state
            .session_runtime
            .set_plan_execution_carryover(update.target_session_id.clone(), plan_execution)
            .await;
    }
    if target_changed {
        state
            .session_runtime
            .map_transport_to_session(transport_session_id, update.target_session_id.clone())
            .await;
        state
            .session_runtime
            .set_remapped_session_metadata(
                update.target_session_id.clone(),
                target_category,
                target_mode,
            )
            .await;
        if let Err(error) = save_fura_config(state).await {
            warn!(%error, "failed to save remapped session metadata");
        }
    }
}

impl Default for SessionRuntimeState {
    fn default() -> Self {
        Self::new(HashMap::new(), HashMap::new())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AuthSession {
    pub(crate) expires_at: Instant,
}

pub(crate) struct RpcSessionHandle {
    pub(crate) stdin: mpsc::Sender<Value>,
    pub(crate) stop: oneshot::Sender<()>,
}

pub(crate) struct VoiceSessionHandle {
    pub(crate) commands: mpsc::Sender<VoiceCommand>,
    pub(crate) run_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingCreatedSession {
    pub(crate) cwd: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) title: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) created_at: Timestamp,
    pub(crate) session_mode: SessionMode,
    pub(crate) worktree: Option<crate::SessionWorktreeSummary>,
    pub(crate) proposed_model: Option<ProposedModelConfig>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingPromptDraft {
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) images: Option<Vec<Value>>,
    pub(crate) optimistic_message_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingSessionChangesSnapshot {
    pub(crate) client_id: String,
    pub(crate) diff_id: String,
    pub(crate) session_id: String,
    pub(crate) repo_id: Option<String>,
    pub(crate) select_created_snapshot: bool,
    pub(crate) detail_mode: DiffDetailMode,
    pub(crate) current_commit_oid: Option<String>,
    pub(crate) selected_file: Option<DiffFileSelector>,
    pub(crate) context_lines: Option<u32>,
}

#[derive(Default)]
pub(crate) struct DiffJobRegistry {
    pub(crate) next_token: u64,
    pub(crate) state_generations: HashMap<(String, DiffScope), DiffStateGenerationJob>,
    pub(crate) file_patches: HashMap<(String, DiffScope, String, String), DiffFilePatchJob>,
}

pub(crate) struct DiffStateGenerationJob {
    pub(crate) token: u64,
    pub(crate) diff_id: String,
    pub(crate) prepared: Option<Arc<PreparedDiff>>,
    pub(crate) handle: Option<JoinHandle<()>>,
}

pub(crate) struct DiffFilePatchJob {
    pub(crate) token: u64,
    pub(crate) handle: JoinHandle<()>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanExecutionCarryover {
    pub(crate) execution_title: String,
    pub(crate) plan_title: Option<String>,
    pub(crate) plan_file_path: String,
    pub(crate) final_plan_file_path: String,
    pub(crate) content: String,
}

#[derive(Debug, Default)]
pub(crate) struct BridgeControllerState {
    pub(crate) transport_session_id: Option<String>,
    pub(crate) tools_registered: bool,
    pub(crate) tools_restricted: bool,
    pub(crate) active_run: Option<BridgeControllerRun>,
    pub(crate) conversations: HashMap<String, ControlConversationState>,
}

#[derive(Debug, Default)]
pub(crate) struct ModelCatalogState {
    pub(crate) transport_session_id: Option<String>,
    pub(crate) in_flight: bool,
    pub(crate) in_flight_request_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct BridgeControllerRun {
    pub(crate) target_client_id: String,
    pub(crate) conversation_id: String,
    pub(crate) active_session_id: Option<String>,
    pub(crate) prompt_started_at: Timestamp,
}

#[derive(Debug, Clone)]
pub(crate) struct ControlConversationState {
    pub(crate) last_candidates: Vec<ControlCandidate>,
    pub(crate) last_ui_snapshot: FrontendUiSnapshot,
}

#[derive(Debug, Clone)]
pub(crate) struct ActiveReviewContext {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) repo_root: String,
    pub(crate) comparison_key: String,
    pub(crate) left_tree_or_commit: String,
    pub(crate) right_tree_or_commit: String,
    pub(crate) patch_override: Option<String>,
    pub(crate) previous_host_tools: Vec<Value>,
    pub(crate) set_host_tools_command_id: String,
    pub(crate) prompt_command_id: String,
}
#[derive(Debug)]
pub(crate) struct RpcConfig {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_session_delta_flush_becomes_due_after_throttle_window() {
        let mut pending = PendingSessionDeltas::default();
        let now = Instant::now();

        pending.record_delta("s1", 3);
        assert_eq!(pending.schedule_flush(now), Some(1));
        assert!(!pending.flush_due(now + SESSION_DELTA_THROTTLE_WINDOW / 2));
        assert!(pending.flush_due(now + SESSION_DELTA_THROTTLE_WINDOW));
    }
}
