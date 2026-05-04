use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ClientConfig, CodeFileContent, CodeTreeEntry, CodeWorkspaceSummary, SessionProjection,
    SessionSummary,
};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffMode {
    Full,
    Stat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffReviewMode {
    Range,
    Commit,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffRefKind {
    Branch,
    Tag,
    Commit,
    Remote,
    Other,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DiffRefInput {
    WorkingTree,
    GitRef { value: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DiffCheckoutTarget {
    WorkingTree,
    GitRef { value: String },
    Commit { oid: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ResolvedDiffRef {
    WorkingTree,
    GitRef {
        input: String,
        ref_kind: DiffRefKind,
        oid: String,
        display: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRefSummary {
    pub(crate) name: String,
    pub(crate) short_name: String,
    pub(crate) ref_kind: DiffRefKind,
    pub(crate) oid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Binary,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffFileSummary {
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: String,
    pub(crate) status: DiffFileStatus,
    pub(crate) added: u64,
    pub(crate) removed: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffCommitSummary {
    pub(crate) oid: String,
    pub(crate) short_oid: String,
    pub(crate) subject: String,
    pub(crate) author_name: Option<String>,
    pub(crate) author_email: Option<String>,
    pub(crate) committed_at: String,
    pub(crate) parent_oids: Vec<String>,
    pub(crate) is_merge: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffReviewProgress {
    pub(crate) mode: DiffReviewMode,
    pub(crate) commits: Vec<DiffCommitSummary>,
    pub(crate) selected_commit_oid: Option<String>,
    pub(crate) selected_commit_index: Option<usize>,
    pub(crate) previous_commit_oid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffComparison {
    pub(crate) repo_root: String,
    pub(crate) base: ResolvedDiffRef,
    pub(crate) head: ResolvedDiffRef,
    pub(crate) mode: DiffMode,
    pub(crate) merge_base: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoDiffState {
    pub(crate) repo_root: String,
    pub(crate) refs: Vec<GitRefSummary>,
    pub(crate) comparison: DiffComparison,
    pub(crate) diff: String,
    pub(crate) files: Vec<DiffFileSummary>,
    pub(crate) truncated: bool,
    pub(crate) generated_at: String,
    pub(crate) review_progress: DiffReviewProgress,
    pub(crate) review_worktree: Option<DiffReviewWorktree>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffReviewWorktreeStatus {
    Missing,
    Ready,
    CheckingOut,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffReviewWorktree {
    pub(crate) id: String,
    pub(crate) source_repo_root: String,
    pub(crate) path: String,
    pub(crate) checked_out_ref: Option<ResolvedDiffRef>,
    pub(crate) checked_out_oid: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) status: DiffReviewWorktreeStatus,
    pub(crate) status_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodeWorkspaceSource {
    Session,
    ReviewWorktree,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendUiSnapshot {
    pub(crate) active_session_id: Option<String>,
    pub(crate) focused_area: Option<String>,
    #[serde(default)]
    pub(crate) visible_session_ids: Vec<String>,
    pub(crate) prompt_draft: Option<PromptDraftSnapshot>,
    pub(crate) panels: Option<PanelSnapshot>,
    pub(crate) blocking_ui: Option<BlockingUiSnapshot>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptDraftSnapshot {
    pub(crate) session_id: Option<String>,
    pub(crate) has_text: bool,
    pub(crate) text_length: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelSnapshot {
    pub(crate) transcript_visible: bool,
    pub(crate) tools_visible: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlockingUiSnapshot {
    pub(crate) modal_open: bool,
    pub(crate) dialog_open: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlCandidate {
    #[serde(rename = "type")]
    pub(crate) candidate_type: String,
    pub(crate) candidate_id: String,
    pub(crate) session_id: String,
    pub(crate) title: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) status: String,
    pub(crate) kind: String,
    pub(crate) reason: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) snippets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlSuggestedAction {
    pub(crate) label: String,
    pub(crate) action: FrontendControlAction,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FrontendControlAction {
    SelectSession {
        session_id: String,
    },
    SetPromptDraft {
        session_id: Option<String>,
        text: String,
        focus: Option<bool>,
    },
    Focus {
        target: String,
    },
    ShowNotice {
        level: NoticeLevel,
        text: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlStatusProjection {
    pub(crate) status: String,
    pub(crate) message: Option<String>,
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
        category: Option<String>,
        worktree: Option<WorktreeCreateRequest>,
    },
    #[serde(rename = "session.setCategory")]
    SessionSetCategory {
        session_id: String,
        category: Option<String>,
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
    #[serde(rename = "control.prompt")]
    ControlPrompt {
        client_id: String,
        conversation_id: Option<String>,
        text: String,
        ui_snapshot: FrontendUiSnapshot,
    },
    #[serde(rename = "control.abort")]
    ControlAbort {
        client_id: String,
        conversation_id: Option<String>,
    },
    #[serde(rename = "voice.start")]
    VoiceStart {
        client_id: String,
        language: Option<String>,
    },
    #[serde(rename = "voice.audio")]
    VoiceAudio { client_id: String, audio: String },
    #[serde(rename = "voice.stop")]
    VoiceStop { client_id: String },
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
    #[serde(rename = "diff.open")]
    DiffOpen {
        session_id: Option<String>,
        repo_root: Option<String>,
    },
    #[serde(rename = "diff.compare")]
    DiffCompare {
        session_id: Option<String>,
        repo_root: String,
        base: DiffRefInput,
        head: DiffRefInput,
        mode: DiffMode,
        merge_base: Option<bool>,
        review_mode: Option<DiffReviewMode>,
        commit_oid: Option<String>,
    },
    #[serde(rename = "diff.reviewWorktree.ensure")]
    DiffReviewWorktreeEnsure {
        source_repo_root: String,
        base: Option<DiffRefInput>,
        head: Option<DiffRefInput>,
    },
    #[serde(rename = "diff.reviewWorktree.checkout")]
    DiffReviewWorktreeCheckout {
        worktree_id: String,
        #[serde(rename = "ref")]
        ref_target: DiffCheckoutTarget,
    },
    #[serde(rename = "session.fork")]
    SessionFork { session_id: String, name: String },
    #[serde(rename = "session.handoff")]
    SessionHandoff {
        session_id: String,
        name: String,
        custom_instructions: Option<String>,
    },
    #[serde(rename = "code.workspace.open")]
    CodeWorkspaceOpen { session_id: String },
    #[serde(rename = "code.workspace.openRoot")]
    CodeWorkspaceOpenRoot {
        root: String,
        source: CodeWorkspaceSource,
        review_worktree_id: Option<String>,
    },
    #[serde(rename = "code.tree.list")]
    CodeTreeList {
        workspace_id: String,
        path: Option<String>,
    },
    #[serde(rename = "code.file.open")]
    CodeFileOpen { workspace_id: String, path: String },
    #[serde(rename = "code.file.close")]
    CodeFileClose { workspace_id: String, path: String },
    #[serde(rename = "code.file.search")]
    CodeFileSearch {
        workspace_id: String,
        base_path: String,
        query: String,
        limit: Option<usize>,
    },
    #[serde(rename = "plan.approve")]
    PlanApprove {
        session_id: String,
        plan_file_path: String,
        final_plan_file_path: String,
        title: Option<String>,
        content: String,
    },
    #[serde(rename = "plan.discuss")]
    PlanDiscuss { session_id: String },
    #[serde(rename = "raw.rpc")]
    RawRpc { session_id: String, command: Value },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
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
    #[serde(rename = "dialog.request")]
    DialogRequest { session_id: String, dialog: Value },
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
    DiffState {
        session_id: Option<String>,
        state: RepoDiffState,
    },
    #[serde(rename = "diff.error")]
    DiffError {
        session_id: Option<String>,
        repo_root: Option<String>,
        message: String,
    },
    #[serde(rename = "diff.reviewWorktree.state")]
    DiffReviewWorktreeState { worktree: DiffReviewWorktree },
    #[serde(rename = "control.reply")]
    ControlReply {
        target_client_id: String,
        conversation_id: String,
        message: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        candidates: Vec<ControlCandidate>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        suggested_actions: Vec<ControlSuggestedAction>,
    },
    #[serde(rename = "control.status")]
    ControlStatus {
        target_client_id: Option<String>,
        status: ControlStatusProjection,
    },
    #[serde(rename = "frontend.control")]
    FrontendControl {
        target_client_id: String,
        action: FrontendControlAction,
    },
    #[serde(rename = "code.workspace.ready")]
    CodeWorkspaceReady { workspace: CodeWorkspaceSummary },
    #[serde(rename = "code.tree")]
    CodeTree {
        workspace_id: String,
        path: String,
        entries: Vec<CodeTreeEntry>,
    },
    #[serde(rename = "code.file")]
    CodeFile {
        workspace_id: String,
        file: CodeFileContent,
    },
    #[serde(rename = "code.file.searchResults")]
    CodeFileSearchResults {
        workspace_id: String,
        base_path: String,
        query: String,
        entries: Vec<CodeTreeEntry>,
    },
    #[serde(rename = "code.error")]
    CodeError {
        workspace_id: Option<String>,
        path: Option<String>,
        message: String,
    },
    #[serde(rename = "raw.omp")]
    RawOmp { session_id: String, frame: Value },
    #[serde(rename = "voice.status")]
    VoiceStatus {
        target_client_id: String,
        status: String,
        message: Option<String>,
    },
    #[serde(rename = "voice.delta")]
    VoiceDelta {
        target_client_id: String,
        item_id: String,
        text: String,
    },
    #[serde(rename = "voice.final")]
    VoiceFinal {
        target_client_id: String,
        item_id: String,
        text: String,
    },
    #[serde(rename = "voice.error")]
    VoiceError {
        target_client_id: String,
        message: String,
    },
    #[serde(rename = "error")]
    Error {
        request_id: Option<String>,
        message: String,
    },
}
