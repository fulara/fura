use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde_json::Value;
use tokio::sync::{RwLock, broadcast, mpsc, oneshot};

use crate::{ServerMessage, SessionRecord, Timestamp};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) token: Arc<String>,
    pub(crate) sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    pub(crate) rpc_sessions: Arc<RwLock<HashMap<String, RpcSessionHandle>>>,
    pub(crate) rpc_session_targets: Arc<RwLock<HashMap<String, String>>>,
    /// Metadata for a newly spawned RPC child before OMP reports its real session id.
    pub(crate) pending_created_sessions: Arc<RwLock<HashMap<String, PendingCreatedSession>>>,
    /// Name to apply to the next new session spawned by a fork or handoff on this transport.
    pub(crate) pending_new_session_names: Arc<RwLock<HashMap<String, String>>>,
    /// Regular prompt payloads waiting for OMP to either start streaming or reject as busy.
    pub(crate) pending_prompt_drafts: Arc<RwLock<HashMap<String, PendingPromptDraft>>>,
    pub(crate) events: broadcast::Sender<ServerMessage>,
    pub(crate) rpc_config: Arc<RpcConfig>,
    pub(crate) log_frames: bool,
    pub(crate) bridge_debug_file: Option<PathBuf>,
    pub(crate) forward_raw_frames: bool,
    pub(crate) session_root: PathBuf,
    pub(crate) default_cwd: Arc<RwLock<String>>,
    pub(crate) config_path: Option<PathBuf>,
}

pub(crate) struct RpcSessionHandle {
    pub(crate) stdin: mpsc::Sender<Value>,
    pub(crate) stop: oneshot::Sender<()>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingCreatedSession {
    pub(crate) cwd: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) title: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) created_at: Timestamp,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingPromptDraft {
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) images: Option<Vec<Value>>,
}

#[derive(Debug)]
pub(crate) struct RpcConfig {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}
