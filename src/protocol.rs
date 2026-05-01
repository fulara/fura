use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ClientConfig, SessionProjection, SessionSummary};

#[derive(Debug, Clone, Copy, Deserialize)]
pub(crate) enum PromptBehavior {
    #[serde(rename = "steer")]
    Steer,
    #[serde(rename = "followUp")]
    FollowUp,
}

impl PromptBehavior {
    pub(crate) fn as_rpc_streaming_behavior(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeCreateRequest {
    pub(crate) source_repo: String,
    pub(crate) directory: String,
    pub(crate) base_branch: String,
    pub(crate) branch_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ClientMessage {
    #[serde(rename = "session.create")]
    SessionCreate {
        request_id: Option<String>,
        cwd: Option<String>,
        name: Option<String>,
        args: Option<Vec<String>>,
        worktree: Option<WorktreeCreateRequest>,
    },
    #[serde(rename = "session.attach")]
    SessionAttach { session_id: String },
    #[serde(rename = "session.open")]
    SessionOpen { session_file: String },
    #[serde(rename = "session.detach")]
    SessionDetach { session_id: String },
    #[serde(rename = "session.stop")]
    SessionStop { session_id: String },
    #[serde(rename = "session.delete")]
    SessionDelete {
        session_id: String,
        #[serde(default)]
        delete_worktree: bool,
    },
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "state.refresh")]
    StateRefresh { session_id: String },
    #[serde(rename = "prompt.send")]
    PromptSend {
        session_id: String,
        text: String,
        images: Option<Vec<Value>>,
        behavior: Option<PromptBehavior>,
    },
    #[serde(rename = "prompt.abort")]
    PromptAbort { session_id: String },
    #[serde(rename = "dialog.respond")]
    DialogRespond {
        session_id: String,
        dialog_id: String,
        response: Value,
    },
    #[serde(rename = "model.list")]
    ModelList { session_id: String },
    #[serde(rename = "model.set")]
    ModelSet {
        session_id: String,
        provider: String,
        model_id: String,
    },
    #[serde(rename = "diff.refresh")]
    DiffRefresh {
        session_id: String,
        selector: Option<String>,
        head_selector: Option<String>,
        stat: Option<bool>,
    },
    #[serde(rename = "diff.snapshot")]
    DiffSnapshot {
        session_id: String,
        label: Option<String>,
    },
    #[serde(rename = "session.fork")]
    SessionFork { session_id: String, name: String },
    #[serde(rename = "session.handoff")]
    SessionHandoff {
        session_id: String,
        name: String,
        custom_instructions: Option<String>,
    },
    #[serde(rename = "raw.rpc")]
    RawRpc { session_id: String, command: Value },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelSummary {
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    pub(crate) context_window: Option<u64>,
    pub(crate) thinking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ServerMessage {
    #[serde(rename = "hello")]
    Hello {
        server_version: &'static str,
        protocol_version: u32,
        config: ClientConfig,
    },
    #[serde(rename = "config.updated")]
    ConfigUpdated { config: ClientConfig },
    #[serde(rename = "sessions.snapshot")]
    SessionsSnapshot { sessions: Vec<SessionSummary> },
    #[serde(rename = "session.snapshot")]
    SessionSnapshot {
        session_id: String,
        state: SessionProjection,
    },
    #[serde(rename = "session.exited")]
    SessionExited {
        session_id: String,
        code: Option<i32>,
        signal: Option<String>,
    },
    #[serde(rename = "log.stderr")]
    LogStderr { session_id: String, text: String },
    #[serde(rename = "session.notice")]
    SessionNotice {
        session_id: String,
        level: NoticeLevel,
        text: String,
    },
    #[serde(rename = "prompt.busy")]
    PromptBusy {
        session_id: String,
        text: String,
        images: Option<Vec<Value>>,
    },
    #[serde(rename = "model.list")]
    ModelList {
        session_id: String,
        models: Vec<ModelSummary>,
    },
    #[serde(rename = "model.changed")]
    ModelChanged {
        session_id: String,
        model: ModelSummary,
    },
    #[serde(rename = "plan.review")]
    PlanReview {
        session_id: String,
        plan_file_path: String,
        final_plan_file_path: String,
        title: Option<String>,
        content: String,
    },
    #[serde(rename = "diff.state")]
    DiffState { session_id: String, state: Value },
    #[serde(rename = "raw.omp")]
    RawOmp { session_id: String, frame: Value },
    #[serde(rename = "error")]
    Error {
        request_id: Option<String>,
        message: String,
    },
}
