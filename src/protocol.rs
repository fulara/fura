use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ClientConfig, CodeFileContent, CodeTreeEntry, CodeWorkspaceSummary, ConflictAgentMode,
    ConflictAgentResult, ConflictAgentScope, ConflictFileState, ConflictMagicWandPreview,
    ConflictRepositorySummary, ProposedModelConfig, SessionMode, SessionProjection,
    SessionProjectionDelta, SessionSummary, ThinkingVisibilityPreference,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffDetailMode {
    FilePatch,
    StatOnly,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffMode {
    Full,
    Stat,
}

#[allow(dead_code)]
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

impl DiffSide {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            _ => Err(format!("unknown diff side: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffLineKind {
    Add,
    Remove,
    Context,
}

impl DiffLineKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Remove => "remove",
            Self::Context => "context",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "add" => Ok(Self::Add),
            "remove" => Ok(Self::Remove),
            "context" => Ok(Self::Context),
            _ => Err(format!("unknown diff line kind: {value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffLineLocation {
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: String,
    pub(crate) hunk: Option<String>,
    pub(crate) side: DiffSide,
    pub(crate) kind: DiffLineKind,
    pub(crate) old_line: Option<u32>,
    pub(crate) new_line: Option<u32>,
    pub(crate) text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DiffRow {
    Meta {
        text: String,
    },
    File {
        text: String,
        old_path: Option<String>,
        new_path: String,
        file_path: String,
    },
    Hunk {
        text: String,
        old_path: Option<String>,
        new_path: String,
        file_path: String,
        hunk: String,
    },
    Line {
        prefix: String,
        location: DiffLineLocation,
    },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionRepoSource {
    Worktree,
    Cwd,
    Snapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionDiffSnapshotSummary {
    pub(crate) entry_id: String,
    pub(crate) label: String,
    pub(crate) created_at: String,
    pub(crate) ref_name: String,
    pub(crate) tree: String,
    pub(crate) commit: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffReviewableState {
    pub(crate) comparison: DiffComparisonIdentity,
    pub(crate) summary: DiffSummaryPayload,
    pub(crate) review: CommitStepState,
    pub(crate) patch: Option<String>,
    #[allow(dead_code)]
    pub(crate) patch_rows: Option<Vec<DiffRow>>,
    #[allow(dead_code)]
    pub(crate) patch_context_lines: Option<u32>,
    pub(crate) review_worktree: Option<DiffReviewWorktree>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReviewCommentAuthor {
    User,
    Agent,
}

impl ReviewCommentAuthor {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }

    pub(crate) fn from_db(value: &str) -> Result<Self, String> {
        match value {
            "user" => Ok(Self::User),
            "agent" => Ok(Self::Agent),
            _ => Err(format!("unknown review comment author: {value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewComment {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) repo_root: String,
    pub(crate) comparison_key: String,
    pub(crate) author: ReviewCommentAuthor,
    pub(crate) body: String,
    pub(crate) stale: bool,
    pub(crate) stale_reason: Option<String>,
    pub(crate) anchor: DiffLineLocation,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) flushed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewCommentFlushMarker {
    pub(crate) id: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRepoCandidate {
    pub(crate) id: String,
    pub(crate) repo_root: String,
    pub(crate) label: String,
    pub(crate) source: SessionRepoSource,
    pub(crate) has_session_start_snapshot: bool,
    pub(crate) session_start_snapshot: Option<SessionDiffSnapshotSummary>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DiffEndpoint {
    SessionStartSnapshot {
        snapshot: SessionDiffSnapshotSummary,
    },
    WorkingTree,
    GitRef {
        input: String,
        ref_kind: DiffRefKind,
        oid: String,
        display: String,
    },
    Commit {
        oid: String,
        short_oid: String,
        subject: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffFileSelector {
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffCommitSummary {
    pub(crate) oid: String,
    pub(crate) short_oid: String,
    pub(crate) subject: String,
    pub(crate) message: String,
    pub(crate) author_name: Option<String>,
    pub(crate) author_email: Option<String>,
    pub(crate) committed_at: String,
    pub(crate) parent_oids: Vec<String>,
    pub(crate) is_merge: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayedPatchRange {
    pub(crate) base: DiffEndpoint,
    pub(crate) head: DiffEndpoint,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitStepState {
    pub(crate) commits: Vec<DiffCommitSummary>,
    pub(crate) current_commit_oid: Option<String>,
    pub(crate) current_commit_index: Option<usize>,
    pub(crate) previous_commit_oid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffScope {
    SessionChanges,
    CompareDiff,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "scope",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DiffRequestIdentity {
    SessionChanges {
        client_id: String,
        diff_id: String,
        session_id: String,
        repo_id: Option<String>,
        detail_mode: DiffDetailMode,
        current_commit_oid: Option<String>,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
    CompareDiff {
        client_id: String,
        diff_id: String,
        repo_root: String,
        base: DiffRefInput,
        head: DiffRefInput,
        detail_mode: DiffDetailMode,
        merge_base: Option<bool>,
        current_commit_oid: Option<String>,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffComparisonIdentity {
    pub(crate) repo_root: String,
    pub(crate) base: DiffEndpoint,
    pub(crate) head: DiffEndpoint,
    pub(crate) left_tree_or_commit: String,
    pub(crate) right_tree_or_commit: String,
    pub(crate) detail_mode: DiffDetailMode,
    pub(crate) current_commit_oid: Option<String>,
    pub(crate) selected_file: Option<DiffFileSelector>,
    pub(crate) context_lines: u32,
    pub(crate) generated_at: String,
    pub(crate) comparison_key: String,
    pub(crate) displayed_patch_range: Option<DisplayedPatchRange>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffSummaryPayload {
    pub(crate) files: Vec<DiffFileSummary>,
    pub(crate) stat: Option<String>,
    pub(crate) truncated: bool,
    pub(crate) file_limit_reached: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SessionChangesSummaryState {
    Ready {
        target_client_id: String,
        diff_id: String,
        request: DiffRequestIdentity,
        comparison: DiffComparisonIdentity,
        session_id: String,
        repos: Vec<SessionRepoCandidate>,
        selected_repo_id: String,
        summary: DiffSummaryPayload,
        review: CommitStepState,
        review_worktree: Option<DiffReviewWorktree>,
    },
    MissingRepo {
        target_client_id: String,
        diff_id: String,
        request: DiffRequestIdentity,
        session_id: String,
        repo_root: Option<String>,
        reason: String,
        repos: Vec<SessionRepoCandidate>,
    },
    MissingSnapshot {
        target_client_id: String,
        diff_id: String,
        request: DiffRequestIdentity,
        session_id: String,
        repo_root: Option<String>,
        reason: String,
        repos: Vec<SessionRepoCandidate>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompareDiffSummaryState {
    pub(crate) target_client_id: String,
    pub(crate) diff_id: String,
    pub(crate) request: DiffRequestIdentity,
    pub(crate) comparison: DiffComparisonIdentity,
    pub(crate) refs: Vec<GitRefSummary>,
    pub(crate) summary: DiffSummaryPayload,
    pub(crate) review: CommitStepState,
    pub(crate) review_worktree: Option<DiffReviewWorktree>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffContentState {
    pub(crate) target_client_id: String,
    pub(crate) diff_id: String,
    pub(crate) scope: DiffScope,
    pub(crate) comparison_key: String,
    pub(crate) file: Option<DiffFileSelector>,
    pub(crate) patch: String,
    pub(crate) truncated: bool,
    pub(crate) rows: Vec<DiffRow>,
    pub(crate) context_lines: u32,
    pub(crate) generated_at: String,
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
    pub(crate) session_ids: Vec<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanApprovalMode {
    Execute,
    Compact,
    Keep,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GoalControlAction {
    Pause,
    Resume,
    Drop,
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
        session_mode: Option<SessionMode>,
        worktree: Option<WorktreeCreateRequest>,
        proposed_model_id: Option<String>,
    },
    #[serde(rename = "session.setCategory")]
    SessionSetCategory {
        session_id: String,
        category: Option<String>,
    },
    #[serde(rename = "config.set")]
    ConfigSet {
        show_tools: Option<bool>,
        thinking_visibility: Option<ThinkingVisibilityPreference>,
        proposed_models: Option<Vec<ProposedModelConfig>>,
    },
    #[serde(rename = "config.modelCatalog.list")]
    ConfigModelCatalogList { request_id: Option<String> },
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
    #[serde(rename = "goal.start")]
    GoalStart {
        session_id: String,
        objective: String,
        token_budget: Option<u64>,
    },
    #[serde(rename = "goal.control")]
    GoalControl {
        session_id: String,
        action: GoalControlAction,
    },
    #[serde(rename = "goal.setBudget")]
    GoalSetBudget {
        session_id: String,
        token_budget: Option<u64>,
    },
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
    #[serde(rename = "sessionChanges.request")]
    SessionChangesRequest {
        client_id: String,
        diff_id: String,
        session_id: String,
        repo_id: Option<String>,
        detail_mode: DiffDetailMode,
        current_commit_oid: Option<String>,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
    #[serde(rename = "sessionChanges.snapshot")]
    SessionChangesSnapshot {
        client_id: String,
        diff_id: String,
        session_id: String,
        repo_id: Option<String>,
        label: Option<String>,
        repo_root: Option<String>,
        #[serde(rename = "ref")]
        ref_name: Option<String>,
        detail_mode: Option<DiffDetailMode>,
        current_commit_oid: Option<String>,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
    #[serde(rename = "compareDiff.request")]
    CompareDiffRequest {
        client_id: String,
        diff_id: String,
        repo_root: String,
        base: DiffRefInput,
        head: DiffRefInput,
        detail_mode: DiffDetailMode,
        merge_base: Option<bool>,
        current_commit_oid: Option<String>,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
    #[serde(rename = "diff.cancel")]
    DiffCancel {
        client_id: String,
        diff_id: String,
        scope: DiffScope,
        reason: Option<String>,
    },
    #[serde(rename = "diff.content.request")]
    DiffContentRequest {
        client_id: String,
        diff_id: String,
        scope: DiffScope,
        session_id: Option<String>,
        comparison_key: String,
        selected_file: Option<DiffFileSelector>,
        context_lines: Option<u32>,
    },
    #[serde(rename = "diff.reviewWorktree.ensure")]
    DiffReviewWorktreeEnsure {
        source_repo_root: String,
        target: Option<DiffCheckoutTarget>,
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
    #[serde(rename = "conflict.scan")]
    ConflictScan { root: String },
    #[serde(rename = "conflict.file.open")]
    ConflictFileOpen { repo_id: String, path: String },
    #[serde(rename = "conflict.file.previewMagicWand")]
    ConflictFilePreviewMagicWand {
        repo_id: String,
        path: String,
        expected_version: String,
    },
    #[serde(rename = "conflict.file.writeResult")]
    ConflictFileWriteResult {
        repo_id: String,
        path: String,
        content: String,
        expected_version: String,
    },
    #[serde(rename = "conflict.file.stageResolved")]
    ConflictFileStageResolved {
        repo_id: String,
        path: String,
        expected_version: String,
    },
    #[serde(rename = "conflict.agent.run")]
    ConflictAgentRun {
        session_id: String,
        repo_id: String,
        path: String,
        expected_version: String,
        mode: ConflictAgentMode,
        scope: ConflictAgentScope,
        conflict_id: Option<String>,
        instructions: String,
    },
    #[serde(rename = "plan.approve")]
    PlanApprove {
        session_id: String,
        plan_file_path: String,
        final_plan_file_path: String,
        title: Option<String>,
        content: String,
        approval_mode: Option<PlanApprovalMode>,
    },
    #[serde(rename = "plan.discuss")]
    PlanDiscuss { session_id: String },
    #[serde(rename = "raw.rpc")]
    RawRpc { session_id: String, command: Value },
    #[serde(rename = "review.comments.list")]
    ReviewCommentsList {
        session_id: String,
        comparison_key: Option<String>,
    },
    #[serde(rename = "review.comment.create")]
    ReviewCommentCreate {
        session_id: String,
        repo_root: String,
        comparison_key: String,
        anchor: DiffLineLocation,
        body: String,
    },
    #[serde(rename = "review.comment.update")]
    ReviewCommentUpdate { id: String, body: String },
    #[serde(rename = "review.comment.markFlushed")]
    ReviewCommentMarkFlushed {
        comments: Vec<ReviewCommentFlushMarker>,
    },
    #[serde(rename = "review.comment.delete")]
    ReviewCommentDelete { id: String },
    #[serde(rename = "review.agentReview.start")]
    ReviewAgentReviewStart {
        session_id: String,
        state: DiffReviewableState,
        instructions: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffErrorScope {
    SessionChanges,
    CompareDiff,
    ReviewWorktree,
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
    #[serde(rename = "session.delta")]
    SessionDelta {
        session_id: String,
        state: SessionProjectionDelta,
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
    #[serde(rename = "config.modelCatalog.list")]
    ConfigModelCatalogList {
        request_id: Option<String>,
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
    #[serde(rename = "sessionChanges.summary")]
    SessionChangesSummary { state: SessionChangesSummaryState },
    #[serde(rename = "compareDiff.summary")]
    CompareDiffSummary { state: CompareDiffSummaryState },
    #[serde(rename = "diff.content")]
    DiffContent { content: DiffContentState },
    #[serde(rename = "diff.complete")]
    DiffComplete {
        target_client_id: String,
        diff_id: String,
        scope: DiffScope,
    },
    #[serde(rename = "diff.cancelled")]
    DiffCancelled {
        target_client_id: String,
        diff_id: String,
        scope: DiffScope,
        reason: Option<String>,
    },
    #[serde(rename = "diff.error")]
    DiffError {
        target_client_id: Option<String>,
        diff_id: Option<String>,
        scope: DiffErrorScope,
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
    #[serde(rename = "conflict.snapshot")]
    ConflictSnapshot {
        repos: Vec<ConflictRepositorySummary>,
    },
    #[serde(rename = "conflict.file")]
    ConflictFile { file: ConflictFileState },
    #[serde(rename = "conflict.magicWandPreview")]
    ConflictMagicWandPreview { preview: ConflictMagicWandPreview },
    #[serde(rename = "conflict.agentResult")]
    ConflictAgentResult { result: ConflictAgentResult },
    #[serde(rename = "conflict.status")]
    ConflictStatus {
        repo_id: String,
        path: Option<String>,
        state: String,
        message: String,
    },
    #[serde(rename = "conflict.error")]
    ConflictError {
        repo_id: Option<String>,
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
    #[serde(rename = "review.comments.snapshot")]
    ReviewCommentsSnapshot {
        session_id: String,
        comments: Vec<ReviewComment>,
    },
    #[serde(rename = "review.comment.upserted")]
    ReviewCommentUpserted { comment: ReviewComment },
    #[serde(rename = "review.comment.deleted")]
    ReviewCommentDeleted {
        session_id: String,
        comparison_key: String,
        id: String,
    },
    #[serde(rename = "error")]
    Error {
        request_id: Option<String>,
        message: String,
    },
}
