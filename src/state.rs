use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};

use serde_json::Value;
use tokio::{
    sync::{RwLock, broadcast, mpsc, oneshot},
    task::JoinHandle,
};
use tracing::warn;

use crate::{
    ActiveConflictContext, CodeWorkspaceRegistry, ControlCandidate, DiffDetailMode,
    DiffFileSelector, DiffReviewWorktreeRegistry, DiffScope, FrontendUiSnapshot,
    GoalModeProjection, PlanModeProjection, PreparedDiff, ProposedModelConfig, ServerMessage,
    SessionKind, SessionMode, SessionRecord, SessionStatus, ThinkingVisibilityPreference,
    Timestamp, TodoPhaseProjection, VoiceCommand, save_fura_config,
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
    pub(crate) active_conflict_contexts: Arc<RwLock<HashMap<String, ActiveConflictContext>>>,
    pub(crate) events: broadcast::Sender<ServerMessage>,
    pub(crate) session_host_tools: Arc<RwLock<HashMap<String, Vec<Value>>>>,
    pub(crate) rpc_config: Arc<RpcConfig>,
    pub(crate) log_frames: bool,
    pub(crate) bridge_debug_file: Option<PathBuf>,
    pub(crate) forward_raw_frames: bool,
    pub(crate) session_root: PathBuf,
    pub(crate) default_cwd: Arc<RwLock<String>>,
    pub(crate) config_path: Option<PathBuf>,
    pub(crate) voice_language: Arc<RwLock<String>>,
    pub(crate) show_tools: Arc<RwLock<bool>>,
    pub(crate) thinking_visibility: Arc<RwLock<ThinkingVisibilityPreference>>,
    pub(crate) allowed_origins: Option<Arc<Vec<String>>>,
    pub(crate) secure_auth_cookie: bool,
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
    /// Name to apply to the next new session spawned by a fork or handoff on this transport.
    pub(crate) pending_new_session_names: Arc<RwLock<HashMap<String, String>>>,
    /// Approved plan metadata waiting for / attached to the execution session spawned by OMP.
    pub(crate) plan_execution_carryovers: Arc<RwLock<HashMap<String, PlanExecutionCarryover>>>,
}

pub(crate) struct RemovedRpcTransport {
    pub(crate) handle: RpcSessionHandle,
    pub(crate) target_session_id: String,
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
        Some(RemovedRpcTransport {
            handle,
            target_session_id,
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
    record.status = SessionStatus::Idle;
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
        let keep_pending_plan = plan_mode
            .as_ref()
            .is_some_and(|mode| mode.enabled && !mode.discussion);
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

pub(crate) struct GetStateApplyOutcome {
    pub(crate) previous_snapshot: Option<ServerMessage>,
    pub(crate) target_snapshot: Option<ServerMessage>,
}

pub(crate) async fn apply_get_state_update(
    state: &AppState,
    transport_session_id: &str,
    update: RpcStateUpdate,
) -> GetStateApplyOutcome {
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

    let (previous_snapshot, target_snapshot) = {
        let mut sessions = state.sessions.write().await;

        if target_changed {
            let source = sessions.get(&update.current_session_id).cloned();
            let previous_snapshot = sessions.get_mut(&update.current_session_id).map(|record| {
                record.status = SessionStatus::Available;
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
                            .or_else(|| pending_create.as_ref().map(|pending| pending.args.clone()))
                            .unwrap_or_default(),
                        status: SessionStatus::Idle,
                        created_at,
                        updated_at: now,
                        messages: Vec::new(),
                        live_message_ids: HashSet::new(),
                        streaming_message: None,
                        tool_cards: Vec::new(),
                        active_tool_calls: Vec::new(),
                        todo_phases: None,
                        kind: SessionKind::Managed,
                        session_mode: source
                            .as_ref()
                            .map(|record| record.session_mode)
                            .or_else(|| pending_create.as_ref().map(|pending| pending.session_mode))
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
                    }
                });

            if let Some(record) = sessions.get_mut(&update.target_session_id) {
                record.updated_at = Timestamp::now();
                apply_rpc_state_to_record(
                    record,
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
        }
    };

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

    GetStateApplyOutcome {
        previous_snapshot,
        target_snapshot,
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
