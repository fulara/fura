export type SessionStatus = "starting" | "idle" | "busy" | "exited" | "error" | "available";
export type SessionMode = "standard" | "diffReview";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string; alt?: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "redactedthinking" };

export type TranscriptMessage = {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp?: number | null;
  isNew: boolean;
};

export type AgentProgress = {
  index: number;
  id: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  task: string;
  assignment?: string;
  description?: string;
  lastIntent?: string;
  currentTool?: string;
  currentToolArgs?: string;
  toolCount: number;
  tokens: number;
  durationMs: number;
};

export type TaskResult = {
  index: number;
  id: string;
  agent: string;
  agentSource?: string;
  task: string;
  assignment?: string;
  description?: string;
  lastIntent?: string;
  exitCode: number;
  output?: string;
  stderr?: string;
  truncated?: boolean;
  durationMs?: number;
  tokens?: number;
  error?: string;
  aborted?: boolean;
  abortReason?: string;
  outputPath?: string;
  patchPath?: string;
  branchName?: string;
  extractedToolData?: Record<string, unknown>;
};

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  notes?: string[];
};

export type TodoPhase = {
  name: string;
  tasks: TodoItem[];
};

export type ToolCard = {
  toolCallId: string;
  timestamp?: number | null;
  toolName: string;
  intent?: string | null;
  args: Record<string, unknown>;
  isActive: boolean;
  isError: boolean;
  partialResult?: unknown;
  result?: unknown;
};

export type TranscriptEntry =
  | ({ kind: "message" } & TranscriptMessage)
  | ({ kind: "tool" } & ToolCard);

export type SessionWorktreeSummary = {
  path: string;
};

export type SessionSummary = {
  kind: "managed" | "available";
  sessionMode: SessionMode;
  sessionId: string;
  cwd?: string | null;
  status: SessionStatus;
  createdAt: number;
  messageCount: number;
  updatedAt: number;
  sessionFile?: string | null;
  title?: string | null;
  timestamp?: string | null;
  category?: string | null;
  worktree?: SessionWorktreeSummary | null;
};

export type PlanModeProjection = {
  enabled: boolean;
  planFilePath: string;
  workflow?: string | null;
  discussion?: boolean;
};

export type PendingPlanReviewProjection = {
  planFilePath: string;
  finalPlanFilePath: string;
  title?: string | null;
  content: string;
};
export type SessionProjection = {
  summary: SessionSummary;
  transcript: TranscriptEntry[];
  isBusy: boolean;
  model?: string | null;
  thinkingLevel?: string | null;
  tokensTotal: number;
  costUsd: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
  planMode?: PlanModeProjection | null;
  pendingPlanReview?: PendingPlanReviewProjection | null;
  todoPhases: TodoPhase[];
};

export type DiffDetailMode = "filePatch" | "statOnly";
export type DiffPayloadKind = DiffDetailMode;
export type DiffSide = "left" | "right";
export type DiffRefKind = "branch" | "tag" | "commit" | "remote" | "other";

export type DiffRefInput =
  | { kind: "workingTree" }
  | { kind: "gitRef"; value: string };

export type DiffCheckoutTarget = DiffRefInput | { kind: "commit"; oid: string };

export type ResolvedDiffRef =
  | { kind: "workingTree" }
  | { kind: "gitRef"; input: string; refKind: DiffRefKind; oid: string; display: string };

export type SessionRepoSource = "worktree" | "cwd" | "snapshot";

export type SessionDiffSnapshotSummary = {
  entryId: string;
  label: string;
  createdAt: string;
  refName: string;
  tree: string;
  commit: string;
};

export type SessionRepoCandidate = {
  id: string;
  repoRoot: string;
  label: string;
  source: SessionRepoSource;
  hasSessionStartSnapshot: boolean;
  sessionStartSnapshot?: SessionDiffSnapshotSummary | null;
};

export type DiffEndpoint =
  | { kind: "sessionStartSnapshot"; snapshot: SessionDiffSnapshotSummary }
  | { kind: "workingTree" }
  | { kind: "gitRef"; input: string; refKind: DiffRefKind; oid: string; display: string }
  | { kind: "commit"; oid: string; shortOid: string; subject?: string | null };

export type GitRefSummary = {
  name: string;
  shortName: string;
  refKind: DiffRefKind;
  oid: string;
};

export type DiffFileSummary = {
  oldPath?: string | null;
  newPath: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary" | "unknown";
  added: number;
  removed: number;
};

export type DiffFileSelector = {
  oldPath?: string | null;
  newPath: string;
};

export type DiffCommitSummary = {
  oid: string;
  shortOid: string;
  subject: string;
  authorName?: string | null;
  authorEmail?: string | null;
  committedAt: string;
  parentOids: string[];
  isMerge: boolean;
};

export type DiffPayload =
  | { kind: "statOnly"; files: DiffFileSummary[]; stat: string; truncated: boolean }
  | { kind: "fullPatch"; files: DiffFileSummary[]; patch: string; truncated: boolean };

export type DisplayedPatchRange = {
  base: DiffEndpoint;
  head: DiffEndpoint;
};

export type DiffRangeState = {
  repoRoot: string;
  base: DiffEndpoint;
  head: DiffEndpoint;
  payload: DiffPayload;
  generatedAt: string;
  displayedPatchRange?: DisplayedPatchRange | null;
};

export type CommitStepState = {
  commits: DiffCommitSummary[];
  currentCommitOid?: string | null;
  currentCommitIndex?: number | null;
  previousCommitOid?: string | null;
};

export type DiffReviewWorktree = {
  id: string;
  sourceRepoRoot: string;
  path: string;
  checkedOutRef?: ResolvedDiffRef | null;
  checkedOutOid?: string | null;
  dirty: boolean;
  status: "missing" | "ready" | "checkingOut" | "error";
  statusMessage?: string | null;
};

export type DiffScope = "sessionChanges" | "compareDiff";

export type DiffRequestIdentity =
  | {
      scope: "sessionChanges";
      clientId: string;
      diffId: string;
      sessionId: string;
      repoId?: string | null;
      detailMode: DiffDetailMode;
      currentCommitOid?: string | null;
      selectedFile?: DiffFileSelector | null;
    }
  | {
      scope: "compareDiff";
      clientId: string;
      diffId: string;
      repoRoot: string;
      base: DiffRefInput;
      head: DiffRefInput;
      detailMode: DiffDetailMode;
      mergeBase?: boolean | null;
      currentCommitOid?: string | null;
      selectedFile?: DiffFileSelector | null;
    };

export type DiffComparisonIdentity = {
  repoRoot: string;
  base: DiffEndpoint;
  head: DiffEndpoint;
  leftTreeOrCommit: string;
  rightTreeOrCommit: string;
  detailMode: DiffDetailMode;
  currentCommitOid?: string | null;
  selectedFile?: DiffFileSelector | null;
  generatedAt: string;
  comparisonKey: string;
};

export type DiffSummaryPayload = {
  files: DiffFileSummary[];
  stat?: string | null;
  truncated: boolean;
  fileLimitReached?: boolean | null;
};

export type SessionChangesSummaryState =
  | {
      status: "ready";
      targetClientId: string;
      diffId: string;
      request: DiffRequestIdentity;
      comparison: DiffComparisonIdentity;
      sessionId: string;
      repos: SessionRepoCandidate[];
      selectedRepoId: string;
      summary: DiffSummaryPayload;
      review: CommitStepState;
      reviewWorktree?: DiffReviewWorktree | null;
      patch?: string | null;
    }
  | {
      status: "missingRepo";
      targetClientId: string;
      diffId: string;
      request: DiffRequestIdentity;
      sessionId: string;
      repoRoot?: string | null;
      reason: string;
      repos: SessionRepoCandidate[];
    }
  | {
      status: "missingSnapshot";
      targetClientId: string;
      diffId: string;
      request: DiffRequestIdentity;
      sessionId: string;
      repoRoot?: string | null;
      reason: string;
      repos: SessionRepoCandidate[];
    };

export type CompareDiffSummaryState = {
  targetClientId: string;
  diffId: string;
  request: DiffRequestIdentity;
  comparison: DiffComparisonIdentity;
  refs: GitRefSummary[];
  summary: DiffSummaryPayload;
  review: CommitStepState;
  reviewWorktree?: DiffReviewWorktree | null;
};

export type DiffFilePatchState = {
  targetClientId: string;
  diffId: string;
  scope: DiffScope;
  comparisonKey: string;
  file: DiffFileSelector;
  patch: string;
  truncated: boolean;
  generatedAt: string;
};

export type DiffReviewableState = {
  comparison: DiffComparisonIdentity;
  summary: DiffSummaryPayload;
  review: CommitStepState;
  patch?: string | null;
  reviewWorktree?: DiffReviewWorktree | null;
};

export type DiffLineLocation = {
  oldPath?: string | null;
  newPath: string;
  hunk: string | null;
  side: DiffSide;
  kind: "add" | "remove" | "context";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffReviewAnnotation = {
  id: string;
  kind: "comment" | "question";
  comparisonKey: string;
  anchor: DiffLineLocation;
  text: string;
  status: "draft" | "sent";
  createdAt: string;
  external?: { provider: "github"; owner: string; repo: string; pullNumber: number; commentId?: string | null };
};

export type ModelSummary = {
  provider: string;
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  thinking: boolean;
};

export type ProposedThinkingLevel = "default" | "off" | "minimal" | "low" | "medium" | "high";

export type ProposedModelConfig = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  modelName?: string | null;
  thinkingLevel: ProposedThinkingLevel;
};


export type ThinkingVisibilityMode = "auto" | "shown" | "hidden";

export type ServerConfig = {
  defaultCwd: string;
  voiceLanguage: string;
  showTools: boolean;
  thinkingVisibility: ThinkingVisibilityMode;
  proposedModels: ProposedModelConfig[];
};

export type FrontendUiSnapshot = {
  activeSessionId?: string | null;
  focusedArea?: "controller" | "sessionList" | "prompt" | "transcript" | "tools" | "unknown";
  sessionIds: string[];
  promptDraft?: { sessionId?: string | null; hasText: boolean; textLength: number };
  panels?: { transcriptVisible: boolean; toolsVisible: boolean };
  blockingUi?: { modalOpen: boolean; dialogOpen: boolean };
};

export type FrontendControlAction =
  | { type: "selectSession"; sessionId: string }
  | { type: "setPromptDraft"; sessionId?: string | null; text: string; focus?: boolean | null }
  | { type: "focus"; target: "controller" | "prompt" }
  | { type: "showNotice"; level: "info" | "warning" | "error"; text: string };

export type ControlCandidate = {
  type: "session";
  candidateId: string;
  sessionId: string;
  title?: string | null;
  cwd?: string | null;
  timestamp?: string | null;
  status: string;
  kind: string;
  reason: string;
  snippets?: string[];
};

export type ControlSuggestedAction = {
  label: string;
  action: FrontendControlAction;
};

export type ControlStatusProjection = {
  status: "idle" | "working" | "error" | string;
  message?: string | null;
};

export type CodeStatus = "filesOnly";
export type CodeWorkspaceSource = "session" | "reviewWorktree";

export type CodeWorkspaceSummary = {
  workspaceId: string;
  sessionId?: string | null;
  root: string;
  rustRoot?: string | null;
  status: CodeStatus;
  statusMessage?: string | null;
  source: CodeWorkspaceSource;
  reviewWorktreeId?: string | null;
};

export type CodeTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number | null;
};

export type CodeFileContent = {
  path: string;
  language: string;
  text: string;
  size: number;
  version: number;
};

export type ServerMessage =
  | { type: "hello"; serverVersion: string; protocolVersion: number; config: ServerConfig }
  | { type: "config.updated"; config: ServerConfig }
  | { type: "sessions.snapshot"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; sessionId: string; state: SessionProjection }
  | { type: "session.exited"; sessionId: string; code?: number; signal?: string }
  | { type: "dialog.request"; sessionId: string; dialog: unknown }
  | { type: "log.stderr"; sessionId: string; text: string }
  | { type: "session.notice"; sessionId: string; level: "info" | "warning" | "error"; text: string }
  | { type: "prompt.busy"; sessionId: string; text: string; images?: unknown[] | null }
  | { type: "model.list"; sessionId: string; models: ModelSummary[] }
  | { type: "config.modelCatalog.list"; requestId?: string | null; models: ModelSummary[] }
  | { type: "plan.review"; sessionId: string; planFilePath: string; finalPlanFilePath: string; title?: string | null; content: string }
  | { type: "model.changed"; sessionId: string; model: ModelSummary }
  | { type: "raw.omp"; sessionId: string; frame: unknown }
  | { type: "code.workspace.ready"; workspace: CodeWorkspaceSummary }
  | { type: "code.tree"; workspaceId: string; path: string; entries: CodeTreeEntry[] }
  | { type: "code.file"; workspaceId: string; file: CodeFileContent }
  | { type: "code.file.searchResults"; workspaceId: string; basePath: string; query: string; entries: CodeTreeEntry[] }
  | { type: "code.error"; workspaceId?: string | null; path?: string | null; message: string }
  | { type: "sessionChanges.summary"; state: SessionChangesSummaryState }
  | { type: "compareDiff.summary"; state: CompareDiffSummaryState }
  | { type: "diff.filePatch"; patch: DiffFilePatchState }
  | { type: "diff.complete"; targetClientId: string; diffId: string; scope: DiffScope }
  | { type: "diff.cancelled"; targetClientId: string; diffId: string; scope: DiffScope; reason?: string | null }
  | { type: "diff.error"; targetClientId?: string | null; diffId?: string | null; scope: "sessionChanges" | "compareDiff" | "reviewWorktree"; sessionId?: string | null; repoRoot?: string | null; message: string }
  | { type: "diff.reviewWorktree.state"; worktree: DiffReviewWorktree }
  | { type: "control.reply"; targetClientId: string; conversationId: string; message: string; candidates?: ControlCandidate[]; suggestedActions?: ControlSuggestedAction[] }
  | { type: "control.status"; targetClientId?: string | null; status: ControlStatusProjection }
  | { type: "frontend.control"; targetClientId: string; action: FrontendControlAction }
  | { type: "voice.status"; targetClientId: string; status: "connecting" | "listening" | "transcribing" | "stopping" | "idle" | string; message?: string | null }
  | { type: "voice.delta"; targetClientId: string; itemId: string; text: string }
  | { type: "voice.final"; targetClientId: string; itemId: string; text: string }
  | { type: "voice.error"; targetClientId: string; message: string }
  | { type: "error"; requestId?: string | null; message: string };

export type WorktreeCreateOptions = {
  sourceRepo: string;
  directory: string;
  baseBranch: string;
  branchName?: string;
};

export type ClientMessage =
  | { type: "session.create"; requestId?: string; cwd?: string; name?: string; category?: string; sessionMode?: SessionMode; args?: string[]; worktree?: WorktreeCreateOptions; proposedModelId?: string }
  | { type: "session.setCategory"; sessionId: string; category?: string }
  | { type: "config.set"; showTools?: boolean; thinkingVisibility?: ThinkingVisibilityMode; proposedModels?: ProposedModelConfig[] }
  | { type: "config.modelCatalog.list"; requestId?: string }
  | { type: "session.open"; sessionFile: string }
  | { type: "session.attach"; sessionId: string }
  | { type: "session.detach"; sessionId: string }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.delete"; sessionId: string; deleteWorktree?: boolean }
  | { type: "session.list" }
  | { type: "state.refresh"; sessionId: string }
  | {
      type: "prompt.send";
      sessionId: string;
      text: string;
      images?: unknown[];
      behavior?: "steer" | "followUp";
    }
  | { type: "prompt.abort"; sessionId: string }
  | { type: "dialog.respond"; sessionId: string; dialogId: string; response: unknown }
  | { type: "model.list"; sessionId: string }
  | { type: "model.set"; sessionId: string; provider: string; modelId: string }
  | { type: "sessionChanges.request"; clientId: string; diffId: string; sessionId: string; repoId?: string | null; detailMode: DiffDetailMode; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null }
  | { type: "sessionChanges.snapshot"; clientId: string; diffId: string; sessionId: string; repoId?: string | null; label?: string | null; detailMode?: DiffDetailMode | null; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null }
  | { type: "compareDiff.request"; clientId: string; diffId: string; repoRoot: string; base: DiffRefInput; head: DiffRefInput; detailMode: DiffDetailMode; mergeBase?: boolean; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null }
  | { type: "diff.cancel"; clientId: string; diffId: string; scope: DiffScope; reason?: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed" }
  | { type: "diff.reviewWorktree.ensure"; sourceRepoRoot: string; target?: DiffCheckoutTarget | null }
  | { type: "diff.reviewWorktree.checkout"; worktreeId: string; ref: DiffCheckoutTarget }
  | { type: "code.workspace.open"; sessionId: string }
  | { type: "code.workspace.openRoot"; root: string; source: CodeWorkspaceSource; reviewWorktreeId?: string | null }
  | { type: "code.tree.list"; workspaceId: string; path?: string }
  | { type: "code.file.open"; workspaceId: string; path: string }
  | { type: "code.file.close"; workspaceId: string; path: string }
  | { type: "code.file.search"; workspaceId: string; basePath: string; query: string; limit?: number }
  | {
      type: "plan.approve";
      sessionId: string;
      planFilePath: string;
      finalPlanFilePath: string;
      title?: string | null;
      content: string;
    }
  | { type: "plan.discuss"; sessionId: string }
  | { type: "raw.rpc"; sessionId: string; command: unknown }
  | { type: "session.fork"; sessionId: string; name: string }
  | { type: "control.prompt"; clientId: string; conversationId?: string; text: string; uiSnapshot: FrontendUiSnapshot }
  | { type: "control.abort"; clientId: string; conversationId?: string }
  | { type: "voice.start"; clientId: string; language?: string }
  | { type: "voice.audio"; clientId: string; audio: string }
  | { type: "voice.stop"; clientId: string }
  | { type: "session.handoff"; sessionId: string; name: string; customInstructions?: string };
