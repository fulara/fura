export type SessionStatus = "starting" | "idle" | "busy" | "exited" | "error" | "available";
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
  sessionId: string;
  cwd?: string | null;
  status: SessionStatus;
  createdAt: number;
  messageCount: number;
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
  todoPhases: TodoPhase[];
};

export type DiffMode = "full" | "stat";
export type DiffReviewMode = "range" | "commit";
export type DiffSide = "left" | "right";
export type DiffRefKind = "branch" | "tag" | "commit" | "remote" | "other";

export type DiffRefInput =
  | { kind: "workingTree" }
  | { kind: "gitRef"; value: string };

export type DiffCheckoutTarget = DiffRefInput | { kind: "commit"; oid: string };

export type ResolvedDiffRef =
  | { kind: "workingTree" }
  | { kind: "gitRef"; input: string; refKind: DiffRefKind; oid: string; display: string };

export type GitRefSummary = {
  name: string;
  shortName: string;
  refKind: DiffRefKind;
  oid: string;
};

export type DiffComparison = {
  repoRoot: string;
  base: ResolvedDiffRef;
  head: ResolvedDiffRef;
  mode: DiffMode;
  mergeBase?: boolean | null;
};

export type DiffFileSummary = {
  oldPath?: string | null;
  newPath: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "binary" | "unknown";
  added: number;
  removed: number;
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

export type DiffReviewProgress = {
  mode: DiffReviewMode;
  commits: DiffCommitSummary[];
  selectedCommitOid?: string | null;
  selectedCommitIndex?: number | null;
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

export type RepoDiffState = {
  repoRoot: string;
  refs: GitRefSummary[];
  comparison: DiffComparison;
  diff: string;
  files: DiffFileSummary[];
  truncated: boolean;
  generatedAt: string;
  reviewProgress: DiffReviewProgress;
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

export type ServerConfig = {
  defaultCwd: string;
  voiceLanguage: string;
};

export type FrontendUiSnapshot = {
  activeSessionId?: string | null;
  focusedArea?: "controller" | "sessionList" | "prompt" | "transcript" | "tools" | "unknown";
  visibleSessionIds: string[];
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
  | { type: "plan.review"; sessionId: string; planFilePath: string; finalPlanFilePath: string; title?: string | null; content: string }
  | { type: "model.changed"; sessionId: string; model: ModelSummary }
  | { type: "raw.omp"; sessionId: string; frame: unknown }
  | { type: "code.workspace.ready"; workspace: CodeWorkspaceSummary }
  | { type: "code.tree"; workspaceId: string; path: string; entries: CodeTreeEntry[] }
  | { type: "code.file"; workspaceId: string; file: CodeFileContent }
  | { type: "code.file.searchResults"; workspaceId: string; basePath: string; query: string; entries: CodeTreeEntry[] }
  | { type: "code.error"; workspaceId?: string | null; path?: string | null; message: string }
  | { type: "diff.state"; sessionId?: string | null; state: RepoDiffState }
  | { type: "diff.error"; sessionId?: string | null; repoRoot?: string | null; message: string }
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
  | { type: "session.create"; requestId?: string; cwd?: string; name?: string; category?: string; args?: string[]; worktree?: WorktreeCreateOptions }
  | { type: "session.setCategory"; sessionId: string; category?: string }
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
  | { type: "diff.open"; sessionId?: string | null; repoRoot?: string | null }
  | { type: "diff.compare"; sessionId?: string | null; repoRoot: string; base: DiffRefInput; head: DiffRefInput; mode: DiffMode; mergeBase?: boolean; reviewMode?: DiffReviewMode; commitOid?: string | null }
  | { type: "diff.reviewWorktree.ensure"; sourceRepoRoot: string; base?: DiffRefInput; head?: DiffRefInput }
  | { type: "diff.reviewWorktree.checkout"; worktreeId: string; ref: DiffCheckoutTarget }
  | { type: "code.workspace.open"; sessionId: string }
  | { type: "code.workspace.openRoot"; root: string; source: CodeWorkspaceSource; reviewWorktreeId?: string | null }
  | { type: "code.tree.list"; workspaceId: string; path?: string }
  | { type: "code.file.open"; workspaceId: string; path: string }
  | { type: "code.file.close"; workspaceId: string; path: string }
  | { type: "code.file.search"; workspaceId: string; basePath: string; query: string; limit?: number }
  | { type: "raw.rpc"; sessionId: string; command: unknown }
  | { type: "session.fork"; sessionId: string; name: string }
  | { type: "control.prompt"; clientId: string; conversationId?: string; text: string; uiSnapshot: FrontendUiSnapshot }
  | { type: "control.abort"; clientId: string; conversationId?: string }
  | { type: "voice.start"; clientId: string; language?: string }
  | { type: "voice.audio"; clientId: string; audio: string }
  | { type: "voice.stop"; clientId: string }
  | { type: "session.handoff"; sessionId: string; name: string; customInstructions?: string };
