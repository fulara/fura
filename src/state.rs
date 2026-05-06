use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

use serde_json::Value;
use tokio::{
    sync::{RwLock, broadcast, mpsc, oneshot},
    task::JoinHandle,
};

use crate::{
    CodeWorkspaceRegistry, ControlCandidate, DiffDetailMode, DiffFileSelector,
    DiffReviewWorktreeRegistry, DiffScope, FrontendUiSnapshot, PreparedDiff, ProposedModelConfig,
    ServerMessage, SessionMode, SessionRecord, ThinkingVisibilityPreference, Timestamp,
    VoiceCommand,
};
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) token: Arc<String>,
    pub(crate) auth_sessions: Arc<RwLock<HashMap<String, AuthSession>>>,
    pub(crate) sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    pub(crate) rpc_sessions: Arc<RwLock<HashMap<String, RpcSessionHandle>>>,
    pub(crate) rpc_session_targets: Arc<RwLock<HashMap<String, String>>>,
    /// Persisted Fura-owned session metadata, keyed by OMP session id.
    pub(crate) session_categories: Arc<RwLock<HashMap<String, String>>>,
    pub(crate) session_modes: Arc<RwLock<HashMap<String, SessionMode>>>,
    /// Metadata for a newly spawned RPC child before OMP reports its real session id.
    pub(crate) pending_created_sessions: Arc<RwLock<HashMap<String, PendingCreatedSession>>>,
    /// Name to apply to the next new session spawned by a fork or handoff on this transport.
    pub(crate) pending_new_session_names: Arc<RwLock<HashMap<String, String>>>,
    /// Regular prompt payloads waiting for OMP to either start streaming or reject as busy.
    pub(crate) pending_prompt_drafts: Arc<RwLock<HashMap<String, PendingPromptDraft>>>,
    pub(crate) pending_session_change_snapshots:
        Arc<RwLock<HashMap<String, PendingSessionChangesSnapshot>>>,
    /// Approved plan metadata waiting for / attached to the execution session spawned by OMP.
    pub(crate) plan_execution_carryovers: Arc<RwLock<HashMap<String, PlanExecutionCarryover>>>,
    pub(crate) code_workspaces: Arc<RwLock<CodeWorkspaceRegistry>>,
    pub(crate) review_worktrees: Arc<RwLock<DiffReviewWorktreeRegistry>>,
    pub(crate) proposed_models: Arc<RwLock<Vec<ProposedModelConfig>>>,
    pub(crate) model_catalog: Arc<RwLock<ModelCatalogState>>,
    pub(crate) bridge_controller: Arc<RwLock<BridgeControllerState>>,
    pub(crate) voice_sessions: Arc<RwLock<HashMap<String, VoiceSessionHandle>>>,
    pub(crate) diff_jobs: Arc<RwLock<DiffJobRegistry>>,
    pub(crate) review_comment_db_path: PathBuf,
    pub(crate) active_review_contexts: Arc<RwLock<HashMap<String, ActiveReviewContext>>>,
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
}

#[derive(Debug, Clone)]
pub(crate) struct PendingSessionChangesSnapshot {
    pub(crate) client_id: String,
    pub(crate) diff_id: String,
    pub(crate) session_id: String,
    pub(crate) repo_id: Option<String>,
    pub(crate) detail_mode: DiffDetailMode,
    pub(crate) current_commit_oid: Option<String>,
    pub(crate) selected_file: Option<DiffFileSelector>,
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
    pub(crate) patch: String,
    pub(crate) previous_host_tools: Vec<Value>,
    pub(crate) set_host_tools_command_id: String,
    pub(crate) prompt_command_id: String,
}
#[derive(Debug)]
pub(crate) struct RpcConfig {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}
