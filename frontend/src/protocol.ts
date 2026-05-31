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
  renderHash?: string;
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
  renderHash?: string;
};

export type ReviewPriority = "P0" | "P1" | "P2" | "P3";

export type ReviewFinding = {
  title: string;
  body: string;
  priority: ReviewPriority;
  confidence: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  agent?: string | null;
};

export type ReviewVerdict = {
  agent?: string | null;
  overallCorrectness: "correct" | "incorrect";
  explanation: string;
  confidence: number;
};

export type ReviewCard = {
  toolCallId: string;
  timestamp?: number | null;
  isActive: boolean;
  verdicts: ReviewVerdict[];
  findings: ReviewFinding[];
  renderHash?: string;
};

export type TranscriptEntry =
  | ({ kind: "message" } & TranscriptMessage)
  | ({ kind: "tool" } & ToolCard)
  | ({ kind: "review" } & ReviewCard);

export type SessionWorktreeSummary = {
  path: string;
};

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export type GoalProjection = {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type GoalModeProjection = {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed" | null;
  goal: GoalProjection;
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
  goalMode?: GoalModeProjection | null;
  awaitingAsk?: boolean;
};

export type PlanModeProjection = {
  enabled: boolean;
  planFilePath: string;
  workflow?: string | null;
};

export type PendingPlanReviewProjection = {
  planFilePath: string;
  finalPlanFilePath: string;
  title?: string | null;
  content: string;
};

export type PendingAskProjection = {
  id: string;
  method: string;
  title?: string | null;
  message?: string | null;
  options?: string[] | null;
  placeholder?: string | null;
  prefill?: string | null;
  promptStyle?: boolean | null;
  timeout?: number | null;
  targetId?: string | null;
  url?: string | null;
  instructions?: string | null;
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
  goalMode?: GoalModeProjection | null;
  todoPhases: TodoPhase[];
  pendingAsk?: PendingAskProjection | null;
  seq: number;
};

export type SessionProjectionDelta = {
  summary: SessionSummary;
  transcriptReplaceFrom: number;
  transcriptAppend: TranscriptEntry[];
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
  goalMode?: GoalModeProjection | null;
  todoPhases: TodoPhase[];
  pendingAsk?: PendingAskProjection | null;
  baseSeq: number;
  seq: number;
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
  message: string;
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
      contextLines?: number | null;
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
      contextLines?: number | null;
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
  contextLines: number;
  generatedAt: string;
  comparisonKey: string;
  displayedPatchRange?: DisplayedPatchRange | null;
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

export type DiffContentState = {
  targetClientId: string;
  diffId: string;
  scope: DiffScope;
  comparisonKey: string;
  file?: DiffFileSelector | null;
  patch: string;
  truncated: boolean;
  generatedAt: string;
  rows: DiffRow[];
  contextLines: number;
};

export type DiffReviewableState = {
  comparison: DiffComparisonIdentity;
  summary: DiffSummaryPayload;
  review: CommitStepState;
  patch?: string | null;
  patchTruncated?: boolean | null;
  patchRows?: DiffRow[] | null;
  patchContextLines?: number | null;
  reviewWorktree?: DiffReviewWorktree | null;
};

export type DiffLineLocation = {
  oldPath?: string | null;
  newPath: string;
  hunk: string | null;
  side: DiffSide;
  kind: "add" | "remove" | "context";
  oldLine?: number | null;
  newLine?: number | null;
  text: string;
};

export type DiffRow =
  | { type: "meta"; text: string }
  | { type: "file"; text: string; oldPath?: string | null; newPath: string; filePath: string }
  | { type: "hunk"; text: string; oldPath?: string | null; newPath: string; filePath: string; hunk: string }
  | { type: "line"; prefix: string; location: DiffLineLocation };

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

export type ReviewComment = {
  id: string;
  sessionId: string;
  repoRoot: string;
  comparisonKey: string;
  author: "user" | "agent";
  body: string;
  stale: boolean;
  staleReason?: string | null;
  anchor: DiffLineLocation;
  createdAt: string;
  updatedAt: string;
  flushedAt?: string | null;
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

export type PresetSummary = {
  name: string;
  description: string;
  body: string;
  defaults: Record<string, string>;
};


export type ThinkingVisibilityMode = "auto" | "shown" | "hidden";

export type ServerConfig = {
  defaultCwd: string;
  voiceLanguage: string;
  showTools: boolean;
  thinkingVisibility: ThinkingVisibilityMode;
  proposedModels: ProposedModelConfig[];
  presets: PresetSummary[];
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

export type CodeStatus =
  | "filesOnly"
  | "starting"
  | "indexing"
  | "ready"
  | "unavailable"
  | "error";
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

export type CodePosition = {
  line: number;
  character: number;
};

export type CodeRange = {
  start: CodePosition;
  end: CodePosition;
};

export type CodeLocation = {
  kind: "local" | "external";
  path?: string | null;
  uri?: string | null;
  label?: string | null;
  range: CodeRange;
};

export type ConflictOperation = "merge" | "rebase" | "cherryPick" | "revert";
export type ConflictFileKind =
  | "bothModified"
  | "addAdd"
  | "deleteModify"
  | "renameModify"
  | "renameDelete"
  | "bothDeleted"
  | "unknown";

export type ConflictFileSummary = {
  path: string;
  kind: ConflictFileKind;
  supported: boolean;
};

export type ConflictRepositorySummary = {
  repoId: string;
  root: string;
  operation?: ConflictOperation | null;
  files: ConflictFileSummary[];
};

export type ConflictFileBuffer = {
  label: string;
  language: string;
  text: string;
  size: number;
};

export type ConflictRegion = {
  id: string;
  startLine: number;
  separatorLine?: number | null;
  endLine: number;
};

export type ConflictFileState = {
  repoId: string;
  path: string;
  kind: ConflictFileKind;
  base?: ConflictFileBuffer | null;
  ours?: ConflictFileBuffer | null;
  theirs?: ConflictFileBuffer | null;
  result?: ConflictFileBuffer | null;
  conflicts: ConflictRegion[];
  version: string;
};

export type ConflictMagicWandRule =
  | "identicalSides"
  | "importListUnion"
  | "linewiseIndependentEdits"
  | "sameLineNonOverlappingEdits";

export type ConflictMagicWandRuleApplication = {
  conflictId: string;
  rule: ConflictMagicWandRule;
  summary: string;
};

export type ConflictMagicWandPreview = {
  repoId: string;
  path: string;
  sourceVersion: string;
  content: string;
  resolvedConflictCount: number;
  remainingConflictCount: number;
  summary: string;
  rules: ConflictMagicWandRuleApplication[];
};

export type ConflictAgentMode = "explain" | "propose";

export type ConflictAgentScope = "selectedConflict" | "file";

export type ConflictAgentRisk = "low" | "medium" | "high";

export type ConflictAgentResult = {
  repoId: string;
  path: string;
  sourceVersion: string;
  mode: ConflictAgentMode;
  scope: ConflictAgentScope;
  conflictId?: string | null;
  risk: ConflictAgentRisk;
  summary: string;
  explanation: string;
  content?: string | null;
  remainingConflictCount?: number | null;
};

export type ServerMessage =
  | { type: "hello"; serverVersion: string; protocolVersion: number; config: ServerConfig }
  | { type: "config.updated"; config: ServerConfig }
  | { type: "sessions.snapshot"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; sessionId: string; state: SessionProjection }
  | { type: "session.delta"; sessionId: string; state: SessionProjectionDelta }
  | { type: "session.exited"; sessionId: string; code?: number; signal?: string }
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
  | { type: "code.definition"; workspaceId: string; requestId: string; path: string; locations: CodeLocation[] }
  | { type: "code.references"; workspaceId: string; requestId: string; path: string; locations: CodeLocation[] }
  | { type: "code.status"; workspaceId: string; status: CodeStatus; message?: string | null }
  | { type: "conflict.snapshot"; repos: ConflictRepositorySummary[] }
  | { type: "conflict.file"; file: ConflictFileState }
  | { type: "conflict.magicWandPreview"; preview: ConflictMagicWandPreview }
  | { type: "conflict.agentResult"; result: ConflictAgentResult }
  | { type: "conflict.status"; repoId: string; path?: string | null; state: "staged" | string; message: string }
  | { type: "conflict.error"; repoId?: string | null; path?: string | null; message: string }
  | { type: "sessionChanges.summary"; state: SessionChangesSummaryState }
  | { type: "compareDiff.summary"; state: CompareDiffSummaryState }
  | { type: "diff.content"; content: DiffContentState }
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
  | { type: "review.comments.snapshot"; sessionId: string; comments: ReviewComment[] }
  | { type: "review.comment.upserted"; comment: ReviewComment }
  | { type: "review.comment.deleted"; sessionId: string; comparisonKey: string; id: string }
  | { type: "error"; requestId?: string | null; message: string };

export type WorktreeCreateOptions = {
  sourceRepo: string;
  directory: string;
  baseBranch: string;
  branchName?: string;
};

export type PlanApprovalMode = "execute" | "compact" | "keep";

export type GoalControlAction = "pause" | "resume" | "drop";
export type ClientMessage =
  | { type: "session.create"; requestId?: string; cwd?: string; name?: string; category?: string; sessionMode?: SessionMode; args?: string[]; worktree?: WorktreeCreateOptions; proposedModelId?: string }
  | { type: "session.setCategory"; sessionId: string; category?: string }
  | { type: "config.set"; showTools?: boolean; thinkingVisibility?: ThinkingVisibilityMode; proposedModels?: ProposedModelConfig[] }
  | { type: "config.modelCatalog.list"; requestId?: string }
  | { type: "preset.save"; name: string; description?: string; body: string; defaults?: Record<string, string> }
  | { type: "preset.delete"; name: string }
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
  | { type: "goal.start"; sessionId: string; objective: string; tokenBudget?: number | null }
  | { type: "goal.control"; sessionId: string; action: GoalControlAction }
  | { type: "goal.setBudget"; sessionId: string; tokenBudget?: number | null }
  | { type: "dialog.respond"; sessionId: string; dialogId: string; response: unknown }
  | { type: "model.list"; sessionId: string }
  | { type: "model.set"; sessionId: string; provider: string; modelId: string }
  | { type: "sessionChanges.request"; clientId: string; diffId: string; sessionId: string; repoId?: string | null; detailMode: DiffDetailMode; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null; contextLines?: number | null }
  | { type: "sessionChanges.snapshot"; clientId: string; diffId: string; sessionId: string; repoId?: string | null; label?: string | null; repoRoot?: string | null; ref?: string | null; detailMode?: DiffDetailMode | null; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null; contextLines?: number | null }
  | { type: "compareDiff.request"; clientId: string; diffId: string; repoRoot: string; base: DiffRefInput; head: DiffRefInput; detailMode: DiffDetailMode; mergeBase?: boolean; currentCommitOid?: string | null; selectedFile?: DiffFileSelector | null; contextLines?: number | null }
  | { type: "diff.content.request"; clientId: string; diffId: string; scope: DiffScope; sessionId?: string | null; comparisonKey: string; selectedFile?: DiffFileSelector | null; contextLines?: number | null }
  | { type: "diff.cancel"; clientId: string; diffId: string; scope: DiffScope; reason?: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed" }
  | { type: "diff.reviewWorktree.ensure"; sourceRepoRoot: string; target?: DiffCheckoutTarget | null }
  | { type: "diff.reviewWorktree.checkout"; worktreeId: string; ref: DiffCheckoutTarget }
  | { type: "code.workspace.open"; sessionId: string }
  | { type: "code.workspace.openRoot"; root: string; source: CodeWorkspaceSource; reviewWorktreeId?: string | null }
  | { type: "code.tree.list"; workspaceId: string; path?: string }
  | { type: "code.file.open"; workspaceId: string; path: string }
  | { type: "code.file.close"; workspaceId: string; path: string }
  | { type: "code.file.search"; workspaceId: string; basePath: string; query: string; limit?: number }
  | { type: "code.definition"; workspaceId: string; path: string; line: number; character: number; requestId: string }
  | { type: "code.references"; workspaceId: string; path: string; line: number; character: number; requestId: string }
  | { type: "conflict.scan"; root: string }
  | { type: "conflict.file.open"; repoId: string; path: string }
  | { type: "conflict.file.previewMagicWand"; repoId: string; path: string; expectedVersion: string }
  | { type: "conflict.file.writeResult"; repoId: string; path: string; content: string; expectedVersion: string }
  | { type: "conflict.file.stageResolved"; repoId: string; path: string; expectedVersion: string }
  | {
      type: "conflict.agent.run";
      sessionId: string;
      repoId: string;
      path: string;
      expectedVersion: string;
      mode: ConflictAgentMode;
      scope: ConflictAgentScope;
      conflictId?: string | null;
      instructions: string;
    }
  | {
      type: "plan.approve";
      sessionId: string;
      planFilePath: string;
      finalPlanFilePath: string;
      title?: string | null;
      content: string;
      approvalMode?: PlanApprovalMode;
    }
  | { type: "raw.rpc"; sessionId: string; command: unknown }
  | { type: "review.comments.list"; sessionId: string; comparisonKey?: string | null }
  | { type: "review.comment.create"; sessionId: string; repoRoot: string; comparisonKey: string; anchor: DiffLineLocation; body: string }
  | { type: "review.comment.update"; id: string; body: string }
  | { type: "review.comment.markFlushed"; comments: { id: string; updatedAt: string }[] }
  | { type: "review.comment.delete"; id: string }
  | { type: "review.agentReview.start"; sessionId: string; state: DiffReviewableState; instructions: string }
  | { type: "session.fork"; sessionId: string; name: string }
  | { type: "control.prompt"; clientId: string; conversationId?: string; text: string; uiSnapshot: FrontendUiSnapshot }
  | { type: "control.abort"; clientId: string; conversationId?: string }
  | { type: "voice.start"; clientId: string; language?: string }
  | { type: "voice.audio"; clientId: string; audio: string }
  | { type: "voice.stop"; clientId: string }
  | { type: "session.handoff"; sessionId: string; name: string; customInstructions?: string };
