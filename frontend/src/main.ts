import "./style.css";
import "highlight.js/styles/github-dark.css";
import "dockview-core/dist/styles/dockview.css";
import hljs from "highlight.js/lib/common";
import { marked, type Token, type Tokens } from "marked";
import { findSlashCommand, fuzzyMatchCommands, type SlashCommandSpec } from "./slashCommands";
import { DockviewComponent, themeDark, type SerializedDockview } from "dockview-core";

type SessionStatus = "starting" | "idle" | "busy" | "exited" | "error" | "available";
type MessageRole = "user" | "assistant" | "system" | "tool";

type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "redactedthinking" };

type TranscriptMessage = {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  isNew: boolean;
};

type AgentProgress = {
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

type TaskResult = {
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

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  notes?: string;
  details?: string;
};

type TodoPhase = {
  id: string;
  name: string;
  tasks: TodoItem[];
};

type ToolCard = {
  toolCallId: string;
  toolName: string;
  intent?: string | null;
  args: Record<string, unknown>;
  isActive: boolean;
  isError: boolean;
  partialResult?: unknown;
  result?: unknown;
};

type TranscriptEntry =
  | ({ kind: "message" } & TranscriptMessage)
  | ({ kind: "tool" } & ToolCard);

type SessionSummary = {
  kind: "managed" | "available";
  sessionId: string;
  cwd?: string | null;
  status: SessionStatus;
  createdAt: number;
  messageCount: number;
  sessionFile?: string | null;
  title?: string | null;
  timestamp?: string | null;
};

type PlanModeProjection = {
  enabled: boolean;
  planFilePath: string;
  workflow?: string | null;
};

type SessionProjection = {
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
};

type DiffSnapshotSummary = {
  entryId: string;
  label: string;
  kind: "manual" | "session-start";
  createdAt: string;
  repoRoot: string;
};

type RepoDiffState = {
  snapshots: DiffSnapshotSummary[];
  selectedSnapshot: DiffSnapshotSummary | null;
  headSnapshot: DiffSnapshotSummary | null;
  diff: string;
  stat: boolean;
};

type DiffLineLocation = {
  filePath: string;
  hunk: string | null;
  kind: "add" | "remove" | "context";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type DiffComment = {
  id: string;
  baseSnapshotEntryId: string;
  headSnapshotEntryId: string | null;
  filePath: string;
  hunk: string | null;
  kind: DiffLineLocation["kind"];
  oldLine?: number;
  newLine?: number;
  lineText: string;
  text: string;
};

type ModelSummary = {
  provider: string;
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  thinking: boolean;
};

type ServerConfig = {
  defaultCwd: string;
};

type ServerMessage =
  | { type: "hello"; serverVersion: string; protocolVersion: number; config: ServerConfig }
  | { type: "config.updated"; config: ServerConfig }
  | { type: "sessions.snapshot"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; sessionId: string; state: SessionProjection }
  | { type: "session.exited"; sessionId: string; code?: number; signal?: string }
  | { type: "dialog.request"; sessionId: string; dialog: unknown }
  | { type: "log.stderr"; sessionId: string; text: string }
  | { type: "session.notice"; sessionId: string; level: "info" | "warning" | "error"; text: string }
  | { type: "model.list"; sessionId: string; models: ModelSummary[] }
  | { type: "plan.review"; sessionId: string; planFilePath: string; finalPlanFilePath: string; title?: string | null; content: string }
  | { type: "model.changed"; sessionId: string; model: ModelSummary }
  | { type: "raw.omp"; sessionId: string; frame: unknown }
  | { type: "diff.state"; sessionId: string; state: RepoDiffState }
  | { type: "error"; requestId?: string | null; message: string };

type ClientMessage =
  | { type: "session.create"; cwd?: string; name?: string; args?: string[] }
  | { type: "session.open"; sessionFile: string }
  | { type: "session.attach"; sessionId: string }
  | { type: "session.detach"; sessionId: string }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.delete"; sessionId: string }
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
  | { type: "diff.refresh"; sessionId: string; selector?: string; headSelector?: string; stat?: boolean }
  | { type: "diff.snapshot"; sessionId: string; label?: string }
  | { type: "raw.rpc"; sessionId: string; command: unknown }
  | { type: "session.fork"; sessionId: string; name: string }
  | { type: "session.handoff"; sessionId: string; name: string; customInstructions?: string };

type PersistedDockviewLayout = {
  version: 1;
  layout: SerializedDockview;
};

type ThinkingVisibilityMode = "auto" | "shown" | "hidden";

const DOCKVIEW_LAYOUT_STORAGE_KEY = "fura.dockview.layout";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("#app missing");
}

app.innerHTML = `
  <main class="shell">
    <aside class="sidebar">
      <section class="brand">
        <div>
          <h1>Fura</h1>
          <p>Browser bridge for Oh My Pi sessions</p>
        </div>
        <span id="connectionStatus" class="status disconnected">disconnected</span>
      </section>

      <section class="card connection-card">
        <label for="tokenInput">Bridge token</label>
        <input id="tokenInput" autocomplete="off" spellcheck="false" placeholder="paste startup token" />
        <button id="connectButton" type="button">Connect</button>
      </section>

      <section class="sidebar-actions">
        <button id="createSessionButton" type="button">New session</button>
        <button id="refreshSessionsButton" type="button">Refresh</button>
      </section>

      <nav id="sessionsList" class="sessions" aria-label="Sessions"></nav>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div>
          <h2 id="sessionTitle">No session selected</h2>
          <p id="sessionMeta">Create or attach to a session to begin.</p>
        </div>
        <div class="workspace-actions">
          <button id="toolVisibilityToggle" class="tool-visibility-toggle" type="button" aria-pressed="true">Tools: on</button>
          <button id="thinkingVisibilityToggle" class="thinking-visibility-toggle" type="button" data-state="auto">Thinking: auto</button>
          <button id="abortButton" type="button">Abort</button>
          <button id="stopButton" type="button">Stop</button>
        </div>
      </header>

      <div id="workspacePanelHost" class="workspace-panel-host"></div>

      <div id="statusBar" class="status-bar" aria-label="Session status"></div>

      <form id="promptForm" class="prompt-form">
        <div id="busyPromptChoice" class="busy-prompt-choice" hidden></div>
        <div class="prompt-field">
          <div id="commandPalette" class="command-palette" hidden></div>
          <div id="imagePreviews" class="image-previews" hidden></div>
          <textarea id="promptInput" rows="4" placeholder="Send a prompt…"></textarea>
        </div>
        <button id="sendButton" type="submit">Send</button>
      </form>
    </section>

  </main>

  <div id="modelPickerOverlay" class="modal-overlay" hidden>
    <section class="model-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="modelPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="modelPickerTitle">Choose model</h2>
          <p id="modelPickerSubtitle">Select a model for the active OMP session.</p>
        </div>
        <button id="modelPickerClose" class="modal-close" type="button" aria-label="Close model picker">×</button>
      </header>
      <input id="modelPickerSearch" class="model-picker-search" autocomplete="off" spellcheck="false" placeholder="Filter by provider, model, or name" />
      <div id="modelPickerList" class="model-picker-list" role="listbox" tabindex="0"></div>
      <footer class="modal-footer">
        <span id="modelPickerStatus" class="model-picker-status"></span>
        <div class="modal-actions">
          <button id="modelPickerCancel" type="button">Cancel</button>
          <button id="modelPickerSelect" type="button">Use selected model</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="cwdPickerOverlay" class="modal-overlay" hidden>
    <section class="cwd-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="cwdPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="cwdPickerTitle">New session</h2>
          <p>Choose the working directory for the new OMP session.</p>
        </div>
        <button id="cwdPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="cwd-picker-body">
        <label for="cwdPickerNameInput">Session name</label>
        <input id="cwdPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-project" />
        <label for="cwdPickerInput">Working directory</label>
        <input id="cwdPickerInput" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="cwdPickerCancel" type="button">Cancel</button>
          <button id="cwdPickerCreate" type="button">Create session</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="forkPickerOverlay" class="modal-overlay" hidden>
    <section class="fork-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="forkPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="forkPickerTitle">Fork session</h2>
          <p>Name the forked session before branching.</p>
        </div>
        <button id="forkPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="cwd-picker-body">
        <label for="forkPickerNameInput">Session name</label>
        <input id="forkPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-fork" />
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="forkPickerCancel" type="button">Cancel</button>
          <button id="forkPickerCreate" type="button">Fork session</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="handoffPickerOverlay" class="modal-overlay" hidden>
    <section class="handoff-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="handoffPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="handoffPickerTitle">Handoff session</h2>
          <p>Name the new session and optionally provide focus instructions.</p>
        </div>
        <button id="handoffPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="cwd-picker-body">
        <label for="handoffPickerNameInput">Session name</label>
        <input id="handoffPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-handoff" />
        <label for="handoffPickerInstructions">Focus instructions <span class="label-optional">(optional)</span></label>
        <textarea id="handoffPickerInstructions" rows="3" placeholder="Focus on the authentication module…"></textarea>
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="handoffPickerCancel" type="button">Cancel</button>
          <button id="handoffPickerCreate" type="button">Handoff</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="diffPreviewOverlay" class="modal-overlay" hidden>
    <section class="diff-preview modal-panel" role="dialog" aria-modal="true" aria-labelledby="diffPreviewTitle">
      <header class="modal-header">
        <div>
          <h2 id="diffPreviewTitle">Preview diff comments</h2>
          <p id="diffPreviewSubtitle">Review the prompt that will be sent to OMP.</p>
        </div>
        <button id="diffPreviewClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <textarea id="diffPreviewText" class="diff-preview-text" readonly spellcheck="false"></textarea>
      <footer class="modal-footer">
        <span id="diffPreviewStatus" class="diff-preview-status"></span>
        <div class="modal-actions">
          <button id="diffPreviewCancel" type="button">Cancel</button>
          <button id="diffPreviewSend" type="button">Send comments</button>
        </div>
      </footer>
    </section>
  </div>
`;

const connectionStatus = requireElement<HTMLSpanElement>("connectionStatus");
const tokenInput = requireElement<HTMLInputElement>("tokenInput");
const connectButton = requireElement<HTMLButtonElement>("connectButton");
const createSessionButton = requireElement<HTMLButtonElement>("createSessionButton");
const refreshSessionsButton = requireElement<HTMLButtonElement>("refreshSessionsButton");
const sessionsList = requireElement<HTMLElement>("sessionsList");
const sessionTitle = requireElement<HTMLHeadingElement>("sessionTitle");
const sessionMeta = requireElement<HTMLParagraphElement>("sessionMeta");
const statusBar = requireElement<HTMLDivElement>("statusBar");
const promptForm = requireElement<HTMLFormElement>("promptForm");
const promptInput = requireElement<HTMLTextAreaElement>("promptInput");
const toolVisibilityToggle = requireElement<HTMLButtonElement>("toolVisibilityToggle");
const thinkingVisibilityToggle = requireElement<HTMLButtonElement>("thinkingVisibilityToggle");
const abortButton = requireElement<HTMLButtonElement>("abortButton");
const stopButton = requireElement<HTMLButtonElement>("stopButton");
const commandPalette = requireElement<HTMLDivElement>("commandPalette");
const imagePreviews = requireElement<HTMLDivElement>("imagePreviews");
const busyPromptChoice = requireElement<HTMLDivElement>("busyPromptChoice");
const sendButton = requireElement<HTMLButtonElement>("sendButton");
const modelPickerOverlay = requireElement<HTMLDivElement>("modelPickerOverlay");
const modelPickerClose = requireElement<HTMLButtonElement>("modelPickerClose");
const modelPickerSearch = requireElement<HTMLInputElement>("modelPickerSearch");
const modelPickerList = requireElement<HTMLDivElement>("modelPickerList");
const modelPickerStatus = requireElement<HTMLSpanElement>("modelPickerStatus");
const modelPickerCancel = requireElement<HTMLButtonElement>("modelPickerCancel");
const modelPickerSelect = requireElement<HTMLButtonElement>("modelPickerSelect");
const cwdPickerOverlay = requireElement<HTMLDivElement>("cwdPickerOverlay");
const cwdPickerClose = requireElement<HTMLButtonElement>("cwdPickerClose");
const cwdPickerNameInput = requireElement<HTMLInputElement>("cwdPickerNameInput");
const cwdPickerInput = requireElement<HTMLInputElement>("cwdPickerInput");
const cwdPickerCancel = requireElement<HTMLButtonElement>("cwdPickerCancel");
const cwdPickerCreate = requireElement<HTMLButtonElement>("cwdPickerCreate");
const forkPickerOverlay = requireElement<HTMLDivElement>("forkPickerOverlay");
const forkPickerClose = requireElement<HTMLButtonElement>("forkPickerClose");
const forkPickerNameInput = requireElement<HTMLInputElement>("forkPickerNameInput");
const forkPickerCancel = requireElement<HTMLButtonElement>("forkPickerCancel");
const forkPickerCreate = requireElement<HTMLButtonElement>("forkPickerCreate");
const handoffPickerOverlay = requireElement<HTMLDivElement>("handoffPickerOverlay");
const handoffPickerClose = requireElement<HTMLButtonElement>("handoffPickerClose");
const handoffPickerNameInput = requireElement<HTMLInputElement>("handoffPickerNameInput");
const handoffPickerInstructions = requireElement<HTMLTextAreaElement>("handoffPickerInstructions");
const handoffPickerCancel = requireElement<HTMLButtonElement>("handoffPickerCancel");
const handoffPickerCreate = requireElement<HTMLButtonElement>("handoffPickerCreate");
const diffPreviewOverlay = requireElement<HTMLDivElement>("diffPreviewOverlay");
const diffPreviewClose = requireElement<HTMLButtonElement>("diffPreviewClose");
const diffPreviewText = requireElement<HTMLTextAreaElement>("diffPreviewText");
const diffPreviewStatus = requireElement<HTMLSpanElement>("diffPreviewStatus");
const diffPreviewCancel = requireElement<HTMLButtonElement>("diffPreviewCancel");
const diffPreviewSend = requireElement<HTMLButtonElement>("diffPreviewSend");

type PendingImage = { type: "image"; marker: string; data: string; mimeType: string };
type PendingSnippet = { type: "snippet"; marker: string; text: string };
type DiffPreviewDraft = {
  sessionId: string;
  state: RepoDiffState;
  comments: DiffComment[];
};
type BusyPromptDraft = {
  sessionId: string;
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets: PendingSnippet[];
  onSend?: () => void;
};
let pendingImages: PendingImage[] = [];
let pendingSnippets: PendingSnippet[] = [];
let nextPendingAttachmentId = 1;

let socket: WebSocket | null = null;
let activeSessionId: string | null = null;
let serverConfig: ServerConfig | null = null;
let pendingCreatedSessionBaseline: Set<string> | null = null;
const unreadSessions = new Set<string>();
let sessions: SessionSummary[] = [];
let lastRenderedSessionId: string | null = null;
let paletteCommands: SlashCommandSpec[] = [];
let paletteSelectedIndex = -1;
const projections = new Map<string, SessionProjection>();
const diffStates = new Map<string, RepoDiffState>();
const diffSelectedSnapshots = new Map<string, string>();
const diffSelectedHeads = new Map<string, string | null>();
const diffComments = new Map<string, DiffComment[]>();
const diffLoadingSessions = new Set<string>();
let diffPanelDirty = true;
let lastDiffsRenderedSessionId: string | null = null;
let lastDiffsRenderedProjectionPresent = false;
const sessionNotices = new Map<string, Array<{ level: string; text: string }>>();
let busyPromptDraft: BusyPromptDraft | null = null;
let diffPreviewDraft: DiffPreviewDraft | null = null;
const DIFF_COMMENT_CONTEXT_RADIUS = 4;
const PROMPT_HISTORY_LIMIT = 100;
let modelPickerSessionId: string | null = null;
let modelPickerModels: ModelSummary[] = [];
let modelPickerSelectedIndex = 0;
let modelPickerLoading = false;
let modelPickerError: string | null = null;
const promptHistories = new Map<string, string[]>();
const promptHistoryMessageIds = new Map<string, Set<string>>();
let promptHistoryIndex = -1;

const TOOL_VISIBILITY_STORAGE_KEY = "fura.showTools";
const THINKING_VISIBILITY_STORAGE_KEY = "fura.showThinking";
const url = new URL(window.location.href);
const initialToken = url.searchParams.get("token") ?? window.localStorage.getItem("fura.token") ?? "";
tokenInput.value = initialToken;
let showToolBubbles = window.localStorage.getItem(TOOL_VISIBILITY_STORAGE_KEY) !== "false";
let thinkingVisibilityMode = parseThinkingVisibilityMode(window.localStorage.getItem(THINKING_VISIBILITY_STORAGE_KEY));
let skipThinkingOpenRestoreOnce = false;
syncToolVisibilityToggle();
syncThinkingVisibilityToggle();

// --- Dockview state ---

let dockviewApi: DockviewComponent | null = null;
// References to the scrollable containers inside each Dockview panel.
// Set when the panel's init() callback runs; null before Dockview is initialized
// or while a panel has not yet been created (e.g. during fromJSON before init fires).
let transcriptPanelEl: HTMLElement | null = null;
let toolsPanelEl: HTMLElement | null = null;
let diffsPanelEl: HTMLElement | null = null;

// Current document owner for panel render functions.
// Set to container.ownerDocument at the start of renderTranscriptView / renderToolsView
// so mkEl/mkText/mkFrag create nodes in the correct document (important for popout panels).
let _renderOwner: Document = document;

// --- Event wiring ---

connectButton.addEventListener("click", connect);
createSessionButton.addEventListener("click", () => {
  openCwdPicker();
});
refreshSessionsButton.addEventListener("click", () => send({ type: "session.list" }));
toolVisibilityToggle.addEventListener("click", () => {
  showToolBubbles = !showToolBubbles;
  window.localStorage.setItem(TOOL_VISIBILITY_STORAGE_KEY, String(showToolBubbles));
  syncToolVisibilityToggle();
  renderActiveSession();
});
thinkingVisibilityToggle.addEventListener("click", () => {
  thinkingVisibilityMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
  skipThinkingOpenRestoreOnce = true;
  window.localStorage.setItem(THINKING_VISIBILITY_STORAGE_KEY, thinkingVisibilityMode);
  syncThinkingVisibilityToggle();
  renderActiveSession();
});
abortButton.addEventListener("click", () => {
  if (activeSessionId) {
    send({ type: "prompt.abort", sessionId: activeSessionId });
  }
});
stopButton.addEventListener("click", () => {
  if (activeSessionId) {
    send({ type: "session.stop", sessionId: activeSessionId });
  }
});
modelPickerClose.addEventListener("click", closeModelPicker);
modelPickerCancel.addEventListener("click", closeModelPicker);
modelPickerSelect.addEventListener("click", selectCurrentModel);
modelPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === modelPickerOverlay) closeModelPicker();
});
modelPickerSearch.addEventListener("input", () => {
  modelPickerSelectedIndex = 0;
  renderModelPicker();
});
modelPickerSearch.addEventListener("keydown", handleModelPickerKeydown);
modelPickerList.addEventListener("keydown", handleModelPickerKeydown);
cwdPickerClose.addEventListener("click", closeCwdPicker);
cwdPickerCancel.addEventListener("click", closeCwdPicker);
cwdPickerCreate.addEventListener("click", submitCwdPicker);
cwdPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === cwdPickerOverlay) closeCwdPicker();
});
cwdPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); cwdPickerInput.focus(); cwdPickerInput.select(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submitCwdPicker(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
forkPickerClose.addEventListener("click", closeForkPicker);
forkPickerCancel.addEventListener("click", closeForkPicker);
forkPickerCreate.addEventListener("click", submitForkPicker);
forkPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === forkPickerOverlay) closeForkPicker();
});
forkPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submitForkPicker(); }
  if (event.key === "Escape") { event.preventDefault(); closeForkPicker(); }
});
handoffPickerClose.addEventListener("click", closeHandoffPicker);
handoffPickerCancel.addEventListener("click", closeHandoffPicker);
handoffPickerCreate.addEventListener("click", submitHandoffPicker);
handoffPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === handoffPickerOverlay) closeHandoffPicker();
});
handoffPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); handoffPickerInstructions.focus(); }
  if (event.key === "Escape") { event.preventDefault(); closeHandoffPicker(); }
});
handoffPickerInstructions.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); closeHandoffPicker(); }
});
diffPreviewClose.addEventListener("click", closeDiffPreview);
diffPreviewCancel.addEventListener("click", closeDiffPreview);
diffPreviewSend.addEventListener("click", sendDiffPreviewDraft);
diffPreviewOverlay.addEventListener("mousedown", event => {
  if (event.target === diffPreviewOverlay) closeDiffPreview();
});
promptForm.addEventListener("submit", event => {
  event.preventDefault();
  const editorText = promptInput.value.trim();
  const text = expandSnippetTokens(editorText);
  if ((!text && pendingImages.length === 0) || !activeSessionId) return;
  hidePalette();
  if (pendingImages.length === 0 && isModelPickerCommand(editorText)) {
    openModelPicker(activeSessionId);
    clearPromptEditor();
    return;
  }
  const knownSlashCommand = findSlashCommand(editorText);
  if (knownSlashCommand?.name === "new") {
    clearPromptEditor();
    openCwdPicker();
    return;
  }
  if (knownSlashCommand?.name === "fork") {
    clearPromptEditor();
    openForkPicker();
    return;
  }
  if (knownSlashCommand?.name === "handoff") {
    clearPromptEditor();
    openHandoffPicker();
    return;
  }

  const accepted = sendPromptWithBusyHandling({
    sessionId: activeSessionId,
    text,
    editorText,
    images: pendingImages,
    snippets: pendingSnippets,
  });
  if (accepted) clearPromptEditor();
});
promptInput.addEventListener("paste", async event => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItems = items.filter(item => item.type.startsWith("image/"));
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  const shouldCaptureSnippet = imageItems.length === 0 && pastedText.length > 500;
  if (imageItems.length === 0 && !shouldCaptureSnippet) return;
  event.preventDefault();

  if (shouldCaptureSnippet) {
    const marker = createPendingMarker("Snippet");
    pendingSnippets.push({ type: "snippet", marker, text: pastedText });
    insertTextAtCursor(marker);
  }

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    try {
      const base64 = await blobToBase64(file);
      const marker = createPendingMarker("Image");
      pendingImages.push({ type: "image", marker, data: base64, mimeType: file.type });
      insertTextAtCursor(marker);
    } catch {
      appendLog("Failed to read pasted image.");
    }
  }
  renderImagePreviews();
  updatePalette();
});
promptInput.addEventListener("input", () => {
  resetPromptHistoryNavigation();
  updatePalette();
});
promptInput.addEventListener("blur", () => {
  window.setTimeout(hidePalette, 120);
});
promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    promptForm.requestSubmit();
    return;
  }
  if (commandPalette.hidden) {
    if (handlePromptHistoryKey(event)) return;
    if (event.key === "Escape" && activeSessionId && projections.get(activeSessionId)?.isBusy) {
      event.preventDefault();
      send({ type: "prompt.abort", sessionId: activeSessionId });
    }
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setPaletteSelected(paletteSelectedIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setPaletteSelected(paletteSelectedIndex - 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    hidePalette();
  } else if (event.key === "Tab") {
    event.preventDefault();
    const target = paletteSelectedIndex >= 0 ? paletteCommands[paletteSelectedIndex] : paletteCommands[0];
    if (target) selectPaletteCommand(target);
  } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && paletteSelectedIndex >= 0) {
    event.preventDefault();
    selectPaletteCommand(paletteCommands[paletteSelectedIndex]);
  }
});

tokenInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    connect();
  }
});

render();
if (initialToken) {
  connect();
}
initDockview();

// --- Core session logic ---

function connect(): void {
  const token = tokenInput.value.trim();
  if (!token) {
    appendLog("Add the bridge token printed by the Rust server before connecting.");
    return;
  }

  window.localStorage.setItem("fura.token", token);
  socket?.close();

  const wsUrl = new URL("/ws", window.location.href);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);

  setStatus("connecting", "connecting");
  socket = new WebSocket(wsUrl);
  socket.addEventListener("open", () => {
    setStatus("connected", "connected");
    send({ type: "session.list" });
  });
  socket.addEventListener("close", () => {
    setStatus("disconnected", "disconnected");
  });
  socket.addEventListener("error", () => {
    appendLog("WebSocket error. Check the token and bridge server.");
  });
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string") {
      appendLog("Ignored non-text WebSocket frame.");
      return;
    }
    appendLog(event.data);
    handleServerMessage(JSON.parse(event.data) as ServerMessage);
  });
}

function activateSession(sessionId: string): void {
  if (activeSessionId !== sessionId) resetPromptHistoryNavigation();
  activeSessionId = sessionId;
  unreadSessions.delete(sessionId);
}

function shouldActivateSnapshot(sessionId: string): boolean {
  if (pendingCreatedSessionBaseline && !pendingCreatedSessionBaseline.has(sessionId)) {
    pendingCreatedSessionBaseline = null;
    return true;
  }
  return !activeSessionId || activeSessionId === sessionId;
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "hello":
      appendLog(`Connected to fura ${message.serverVersion} protocol ${message.protocolVersion}`);
      serverConfig = message.config;
      break;
    case "config.updated":
      serverConfig = message.config;
      break;
    case "sessions.snapshot":
      sessions = message.sessions;
      if (activeSessionId && !sessions.some(session => session.sessionId === activeSessionId)) {
        activeSessionId = null;
        resetPromptHistoryNavigation();
      }
      render();
      break;
    case "session.snapshot": {
      projections.set(message.sessionId, message.state);
      syncPromptHistoryFromProjection(message.sessionId, message.state);
      if (shouldActivateSnapshot(message.sessionId)) {
        activateSession(message.sessionId);
        render();
      } else {
        unreadSessions.add(message.sessionId);
        renderSessions();
      }
      break;
    }
    case "diff.state": {
      diffLoadingSessions.delete(message.sessionId);
      diffStates.set(message.sessionId, message.state);
      if (message.state.selectedSnapshot) {
        diffSelectedSnapshots.set(message.sessionId, message.state.selectedSnapshot.entryId);
      }
      diffSelectedHeads.set(message.sessionId, message.state.headSnapshot?.entryId ?? null);
      markDiffsViewDirty();
      if (message.sessionId === activeSessionId && diffsPanelEl && isDiffsPanelActive()) {
        renderDiffsView(diffsPanelEl, projections.get(message.sessionId));
      }
      break;
    }
    case "plan.review": {
      const preview = message.content.length > 6000 ? `${message.content.slice(0, 6000)}\n\n… truncated …` : message.content;
      const approved = window.confirm(
        `Plan ready${message.title ? `: ${message.title}` : ""}\n\n${preview}\n\nApprove and execute this plan? Press Cancel to stay in plan mode.`,
      );
      if (approved) {
        send({
          type: "raw.rpc",
          sessionId: message.sessionId,
          command: {
            type: "approve_plan_mode",
            planFilePath: message.planFilePath,
            finalPlanFilePath: message.finalPlanFilePath,
          },
        });
      } else {
        const notices = sessionNotices.get(message.sessionId) ?? [];
        notices.push({ level: "info", text: "Stayed in plan mode. Type a refinement prompt to continue planning." });
        sessionNotices.set(message.sessionId, notices);
        render();
      }
      break;
    }
    case "session.exited":
      appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
      render();
      break;
    case "dialog.request":
      appendLog(`Dialog request for ${message.sessionId}: ${JSON.stringify(message.dialog)}`);
      break;
    case "log.stderr":
      appendLog(`[${message.sessionId}] ${message.text}`);
      break;
    case "session.notice":
      appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
      if (message.level === "error" || message.level === "warning") {
        const notices = sessionNotices.get(message.sessionId) ?? [];
        notices.push({ level: message.level, text: message.text });
        sessionNotices.set(message.sessionId, notices);
        render();
      }
      if (modelPickerSessionId === message.sessionId && message.level === "error") {
        modelPickerLoading = false;
        modelPickerError = message.text;
        renderModelPicker();
      }
      break;
    case "model.list":
      if (modelPickerSessionId === message.sessionId) {
        modelPickerModels = message.models;
        modelPickerSelectedIndex = 0;
        modelPickerLoading = false;
        modelPickerError = null;
        renderModelPicker();
      }
      break;
    case "model.changed":
      if (modelPickerSessionId === message.sessionId) {
        closeModelPicker();
      }
      appendLog(`[${message.sessionId}] model changed: ${formatModelSelector(message.model)}`);
      break;
    case "raw.omp":
      appendLog(`[raw ${message.sessionId}] ${JSON.stringify(message.frame)}`);
      break;
    case "error":
      appendLog(`Error: ${message.message}`);
      pendingCreatedSessionBaseline = null;
      if (activeSessionId) {
        const notices = sessionNotices.get(activeSessionId) ?? [];
        notices.push({ level: "error", text: message.message });
        sessionNotices.set(activeSessionId, notices);
        render();
      }
      break;
  }
}

function sendPromptMessage(
  sessionId: string,
  text: string,
  images: PendingImage[],
  behavior?: "steer" | "followUp",
): void {
  const msg: ClientMessage = {
    type: "prompt.send",
    sessionId,
    text,
  };
  if (images.length > 0) {
    msg.images = images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  }
  if (behavior) {
    msg.behavior = behavior;
  }
  sessionNotices.delete(sessionId);
  addPromptToHistory(sessionId, text);
  send(msg);
}

function addPromptToHistory(sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const history = promptHistories.get(sessionId) ?? [];
  if (history[0] === trimmed) {
    promptHistoryIndex = -1;
    return;
  }

  history.unshift(trimmed);
  if (history.length > PROMPT_HISTORY_LIMIT) {
    history.pop();
  }
  promptHistories.set(sessionId, history);
  promptHistoryIndex = -1;
}

function syncPromptHistoryFromProjection(sessionId: string, projection: SessionProjection): void {
  let seenIds = promptHistoryMessageIds.get(sessionId);
  if (!seenIds) {
    seenIds = new Set<string>();
    promptHistoryMessageIds.set(sessionId, seenIds);
  }

  for (const entry of projection.transcript) {
    if (entry.kind !== "message" || entry.role !== "user" || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    addPromptToHistory(sessionId, messageText(entry));
  }
}

function resetPromptHistoryNavigation(): void {
  promptHistoryIndex = -1;
}

function handlePromptHistoryKey(event: KeyboardEvent): boolean {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;

  const sessionId = activeSessionId;
  if (!sessionId) return false;

  const history = promptHistories.get(sessionId) ?? [];
  const direction = event.key === "ArrowUp" ? -1 : 1;
  const canEnterHistory = direction === -1 && promptHistoryIndex === -1 && promptInput.value.trim().length === 0;
  const isBrowsingHistory = promptHistoryIndex !== -1;
  if (history.length === 0 || (!canEnterHistory && !isBrowsingHistory)) return false;

  event.preventDefault();
  navigatePromptHistory(sessionId, direction);
  return true;
}

function navigatePromptHistory(sessionId: string, direction: 1 | -1): void {
  const history = promptHistories.get(sessionId) ?? [];
  if (history.length === 0) return;

  const nextIndex = promptHistoryIndex - direction;
  if (nextIndex < -1 || nextIndex >= history.length) return;

  promptHistoryIndex = nextIndex;
  if (promptHistoryIndex === -1) {
    promptInput.value = "";
    promptInput.selectionStart = 0;
    promptInput.selectionEnd = 0;
  } else {
    promptInput.value = history[promptHistoryIndex] ?? "";
    const cursor = direction === -1 ? 0 : promptInput.value.length;
    promptInput.selectionStart = cursor;
    promptInput.selectionEnd = cursor;
  }

  hidePalette();
}

function clearPromptEditor(): void {
  resetPromptHistoryNavigation();
  pendingImages = [];
  pendingSnippets = [];
  renderImagePreviews();
  promptInput.value = "";
  updatePalette();
}

function sendPromptWithBusyHandling(options: {
  sessionId: string;
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets?: PendingSnippet[];
  onSend?: () => void;
}): boolean {
  const projection = projections.get(options.sessionId);
  const knownSlashCommand = findSlashCommand(options.editorText);
  const isSlashCommandLike = /^\/[^\s:]+/.test(options.editorText);

  if (projection?.isBusy) {
    if (knownSlashCommand && options.images.length === 0) {
      sendPromptMessage(options.sessionId, options.text, options.images);
      options.onSend?.();
      return true;
    }
    if (isSlashCommandLike) {
      const notices = sessionNotices.get(options.sessionId) ?? [];
      notices.push({
        level: "warning",
        text: "Slash commands cannot be sent as steer or follow-up prompts while the agent is busy.",
      });
      sessionNotices.set(options.sessionId, notices);
      render();
      return false;
    }
    busyPromptDraft = {
      sessionId: options.sessionId,
      text: options.text,
      editorText: options.editorText,
      images: options.images.map(image => ({ ...image })),
      snippets: (options.snippets ?? []).map(snippet => ({ ...snippet })),
      onSend: options.onSend,
    };
    renderBusyPromptChoice();
    return true;
  }

  sendPromptMessage(options.sessionId, options.text, options.images);
  options.onSend?.();
  return true;
}

function renderBusyPromptChoice(): void {
  busyPromptChoice.replaceChildren();
  const draft = busyPromptDraft;
  if (!draft || draft.sessionId !== activeSessionId) {
    busyPromptChoice.hidden = true;
    return;
  }

  busyPromptChoice.hidden = false;

  const copy = document.createElement("div");
  copy.className = "busy-prompt-copy";

  const title = document.createElement("strong");
  title.textContent = "Agent is busy";

  const summary = document.createElement("span");
  const attachmentCount = draft.images.length + draft.snippets.length;
  const suffix = attachmentCount > 0 ? ` · ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}` : "";
  summary.textContent = `Choose how to handle the submitted prompt${suffix}.`;

  const preview = document.createElement("p");
  preview.className = "busy-prompt-preview";
  preview.textContent = draft.editorText || (draft.images.length > 0 ? "[Image prompt]" : "");

  copy.append(title, summary, preview);

  const actions = document.createElement("div");
  actions.className = "busy-prompt-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.title = "Move the prompt back to the editor";
  cancel.addEventListener("click", restoreBusyPromptDraft);

  const steer = document.createElement("button");
  steer.type = "button";
  steer.textContent = "Steer";
  steer.title = "Interrupt the running agent after the current tool";
  steer.addEventListener("click", () => sendBusyPromptDraft("steer"));

  const followUp = document.createElement("button");
  followUp.type = "button";
  followUp.textContent = "Follow-up";
  followUp.title = "Run this prompt after the current turn finishes";
  followUp.addEventListener("click", () => sendBusyPromptDraft("followUp"));

  actions.append(cancel, steer, followUp);
  busyPromptChoice.append(copy, actions);
}

function restoreBusyPromptDraft(): void {
  const draft = busyPromptDraft;
  if (!draft) return;
  busyPromptDraft = null;

  resetPromptHistoryNavigation();
  const currentText = promptInput.value.trim();
  promptInput.value = [draft.editorText, currentText].filter(Boolean).join("\n\n");
  pendingImages = [...draft.images, ...pendingImages];
  pendingSnippets = [...draft.snippets, ...pendingSnippets];
  renderImagePreviews();
  renderBusyPromptChoice();
  render();
  promptInput.focus();
}

function sendBusyPromptDraft(behavior: "steer" | "followUp"): void {
  const draft = busyPromptDraft;
  if (!draft) return;
  sendPromptMessage(draft.sessionId, draft.text, draft.images, behavior);
  const onSend = draft.onSend;
  busyPromptDraft = null;
  onSend?.();
  renderBusyPromptChoice();
  render();
}

// --- Top-level render ---

function render(): void {
  renderSessions();
  renderActiveSession();
}

function sessionStatusLabel(session: SessionSummary): string {
  if (session.kind === "available") return "Saved";
  switch (session.status) {
    case "starting":
      return "Opening";
    case "idle":
      return "Ready";
    case "busy":
      return "Working";
    case "exited":
      return "Ended";
    case "error":
      return "Needs attention";
    case "available":
      return "Saved";
  }
}

function sessionStatusClass(session: SessionSummary): string {
  return session.kind === "available" ? "available" : session.status;
}

function sessionKindLabel(kind: SessionSummary["kind"]): string {
  return kind === "managed" ? "Live" : "Saved";
}

function formatMessageCount(count: number): string {
  return `${count} msg${count === 1 ? "" : "s"}`;
}

function formatSessionMeta(session: SessionSummary): string {
  const cwdLabel = session.cwd ? shortPath(session.cwd) : "no dir";
  return `${cwdLabel} · ${sessionKindLabel(session.kind)} · ${formatMessageCount(session.messageCount)}`;
}

function renderSessions(): void {
  sessionsList.replaceChildren();

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No sessions yet.";
    sessionsList.append(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";

    const button = document.createElement("button");
    button.type = "button";
    const isActive = session.sessionId === activeSessionId;
    const hasUpdates = !isActive && unreadSessions.has(session.sessionId);
    const classes = ["session", isActive ? "active" : "", hasUpdates ? "has-updates" : ""].filter(Boolean);
    button.className = classes.join(" ");
    button.addEventListener("click", () => {
      activateSession(session.sessionId);
      if (session.kind === "available" && session.sessionFile) {
        send({ type: "session.open", sessionFile: session.sessionFile });
      } else {
        send({ type: "session.attach", sessionId: session.sessionId });
      }
      render();
    });

    const titleRow = document.createElement("span");
    titleRow.className = "session-title-row";

    const title = document.createElement("span");
    title.className = "session-id";
    title.textContent = session.title || shortId(session.sessionId);

    const status = document.createElement("span");
    status.className = `session-status session-status-${sessionStatusClass(session)}`;
    status.textContent = sessionStatusLabel(session);

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = formatSessionMeta(session);

    titleRow.append(title, status);
    button.append(titleRow, meta);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-delete";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.setAttribute("aria-label", "Delete session");
    deleteBtn.addEventListener("click", e => {
      e.stopPropagation();
      const label = session.title || shortId(session.sessionId);
      if (window.confirm(`Delete session "${label}"?\n\nThis will stop the session and permanently delete its file.`)) {
        send({ type: "session.delete", sessionId: session.sessionId });
      }
    });

    item.append(button, deleteBtn);
    sessionsList.append(item);
  }
}

function syncToolVisibilityToggle(): void {
  toolVisibilityToggle.textContent = showToolBubbles ? "Tools: on" : "Tools: off";
  toolVisibilityToggle.setAttribute("aria-pressed", String(showToolBubbles));
  toolVisibilityToggle.title = showToolBubbles ? "Hide tool bubbles in the transcript" : "Show tool bubbles in the transcript";
}

function parseThinkingVisibilityMode(value: string | null): ThinkingVisibilityMode {
  if (value === "shown" || value === "true") return "shown";
  if (value === "hidden") return "hidden";
  return "auto";
}

function nextThinkingVisibilityMode(mode: ThinkingVisibilityMode): ThinkingVisibilityMode {
  if (mode === "auto") return "shown";
  if (mode === "shown") return "hidden";
  return "auto";
}

function syncThinkingVisibilityToggle(): void {
  const labels: Record<ThinkingVisibilityMode, string> = {
    auto: "Thinking: auto",
    shown: "Thinking: shown",
    hidden: "Thinking: hidden",
  };
  const titles: Record<ThinkingVisibilityMode, string> = {
    auto: "Use Fura's default thinking display: live blocks expanded, historical blocks collapsed",
    shown: "Show every thinking block expanded",
    hidden: "Hide thinking blocks in the transcript",
  };
  thinkingVisibilityToggle.textContent = labels[thinkingVisibilityMode];
  thinkingVisibilityToggle.dataset.state = thinkingVisibilityMode;
  thinkingVisibilityToggle.setAttribute("aria-label", `Thinking display: ${thinkingVisibilityMode}`);
  thinkingVisibilityToggle.title = titles[thinkingVisibilityMode];
}

// Renders the workspace header, status bar, and busy prompt choice.
// Drives re-render of the Dockview panels via their stored element references.
function renderActiveSession(): void {
  const sessionChanged = activeSessionId !== lastRenderedSessionId;
  lastRenderedSessionId = activeSessionId;

  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  const hasBusyDraft = busyPromptDraft?.sessionId === activeSessionId;

  abortButton.disabled = !activeSessionId;
  stopButton.disabled = !activeSessionId;
  promptInput.disabled = !activeSessionId || hasBusyDraft;
  sendButton.disabled = !activeSessionId || hasBusyDraft;

  if (!activeSessionId || !projection) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = "Create or attach to a session to begin.";
    promptInput.placeholder = "Select a session first";
  } else {
    sessionTitle.textContent = projection.summary.title || `Session ${shortId(activeSessionId)}`;
    sessionMeta.textContent = `${sessionKindLabel(projection.summary.kind)} · ${sessionStatusLabel(projection.summary)} · ${projection.summary.cwd ?? "no dir"}`;
    promptInput.placeholder = "Send a prompt… (type / for commands)";
  }

  renderStatusBar(projection);
  renderBusyPromptChoice();

  if (transcriptPanelEl) renderTranscriptView(transcriptPanelEl, projection, sessionChanged);
  if (toolsPanelEl) renderToolsView(toolsPanelEl, projection);
  if (diffsPanelEl && isDiffsPanelActive() && shouldRenderDiffsView(projection)) renderDiffsView(diffsPanelEl, projection);
}

// --- Panel render functions ---

// Renders the chronological transcript into `container`, including optional inline tool bubbles.
// Sets _renderOwner from container.ownerDocument so all mkEl calls use the correct document
// (required for popout panels which live in a separate window document).
function renderTranscriptView(
  container: HTMLElement,
  projection: SessionProjection | undefined,
  sessionChanged: boolean,
): void {
  _renderOwner = container.ownerDocument;

  // Snapshot scroll and open thinking blocks before clearing DOM.
  const wasNearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const restoreThinkingOpenState = !skipThinkingOpenRestoreOnce;
  skipThinkingOpenRestoreOnce = false;
  const openThinking = new Set<string>();
  if (restoreThinkingOpenState) {
    container.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
      if (el.open) openThinking.add(`${el.dataset.messageId}:${el.dataset.blockIndex}`);
    });
  }

  container.replaceChildren();

  if (!projection) {
    const empty = mkEl("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "No session selected.";
    container.append(empty);
    return;
  }

  if (projection.transcript.length === 0) {
    const empty = mkEl("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "Transcript is empty.";
    container.append(empty);
  } else {
    for (let i = 0; i < projection.transcript.length; i++) {
      const entry = projection.transcript[i];
      if (entry.kind === "message") {
        container.append(renderMessage(entry));
        continue;
      }

      if (!showToolBubbles) continue;

      if (isCompactReadCard(entry)) {
        const readCards = [entry];
        while (isCompactReadCard(projection.transcript[i + 1])) {
          readCards.push(projection.transcript[++i] as { kind: "tool" } & ToolCard);
        }
        container.append(readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards));
        continue;
      }

      container.append(renderToolCard(entry));
    }

    // Restore thinking blocks that were manually opened before the re-render.
    if (restoreThinkingOpenState) {
      container.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
        const key = `${el.dataset.messageId}:${el.dataset.blockIndex}`;
        if (openThinking.has(key)) el.open = true;
      });
    }
  }

  // Session notices rendered at bottom of transcript.
  const notices = activeSessionId ? (sessionNotices.get(activeSessionId) ?? []) : [];
  for (const notice of notices) {
    const bar = mkEl("div");
    bar.className = `session-notice notice-${notice.level}`;
    bar.textContent = notice.text;
    container.append(bar);
  }

  if (sessionChanged || wasNearBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

// Renders all tool executions from `projection` into `container`, independent of
// transcript order. This is the dedicated Tools panel view.
function renderToolsView(
  container: HTMLElement,
  projection: SessionProjection | undefined,
): void {
  _renderOwner = container.ownerDocument;
  container.replaceChildren();

  if (!projection) {
    const empty = mkEl("p");
    empty.className = "empty tools-empty";
    empty.textContent = "No session selected.";
    container.append(empty);
    return;
  }

  const tools = projection.transcript.filter(
    (entry): entry is { kind: "tool" } & ToolCard => entry.kind === "tool",
  );

  if (tools.length === 0) {
    const empty = mkEl("p");
    empty.className = "empty tools-empty";
    empty.textContent = "No tool executions yet.";
    container.append(empty);
    return;
  }

  for (let i = 0; i < tools.length; i++) {
    const entry = tools[i];
    if (isCompactReadCard(entry)) {
      const readCards = [entry];
      while (i + 1 < tools.length && isCompactReadCard(tools[i + 1])) {
        readCards.push(tools[++i]);
      }
      container.append(readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards));
      continue;
    }
    container.append(renderToolCard(entry));
  }
}

type ParsedDiffRow =
  | { type: "meta"; text: string }
  | { type: "file"; text: string; filePath: string }
  | { type: "hunk"; text: string; filePath: string; hunk: string }
  | { type: "line"; prefix: string; location: DiffLineLocation };

function parseDiffRows(diffText: string): ParsedDiffRow[] {
  const rows: ParsedDiffRow[] = [];
  let filePath = "";
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const text of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/u.exec(text);
    if (fileMatch) {
      filePath = fileMatch[2] ?? fileMatch[1] ?? "";
      hunk = null;
      rows.push({ type: "file", text, filePath });
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      hunk = text;
      rows.push({ type: "hunk", text, filePath, hunk });
      continue;
    }

    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ type: "line", prefix: "+", location: { filePath, hunk, kind: "add", newLine, text } });
      newLine += 1;
      continue;
    }

    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ type: "line", prefix: "-", location: { filePath, hunk, kind: "remove", oldLine, text } });
      oldLine += 1;
      continue;
    }

    if (text.startsWith(" ")) {
      rows.push({
        type: "line",
        prefix: " ",
        location: { filePath, hunk, kind: "context", oldLine, newLine, text },
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rows.push({ type: "meta", text });
  }

  return rows;
}

type DiffFileSummary = {
  filePath: string;
  added: number;
  removed: number;
  commentCount: number;
};

function summarizeDiffFiles(
  rows: ParsedDiffRow[],
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
): DiffFileSummary[] {
  const byPath = new Map<string, DiffFileSummary>();

  for (const row of rows) {
    if (row.type !== "line") continue;
    if (!row.location.filePath) continue;
    const existing = byPath.get(row.location.filePath) ?? {
      filePath: row.location.filePath,
      added: 0,
      removed: 0,
      commentCount: 0,
    };
    if (row.location.kind === "add") existing.added += 1;
    if (row.location.kind === "remove") existing.removed += 1;
    byPath.set(row.location.filePath, existing);
  }

  for (const comment of comments) {
    if (!isSameDiffComparison(comment, baseSnapshot, headSnapshot)) continue;
    const existing = byPath.get(comment.filePath) ?? {
      filePath: comment.filePath,
      added: 0,
      removed: 0,
      commentCount: 0,
    };
    existing.commentCount += 1;
    byPath.set(comment.filePath, existing);
  }

  return [...byPath.values()];
}

function requestDiffState(sessionId: string, selector?: string, headSelector?: string | null): void {
  if (diffLoadingSessions.has(sessionId)) return;
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  send({ type: "diff.refresh", sessionId, selector, headSelector: headSelector ?? undefined });
  if (diffsPanelEl && isDiffsPanelActive()) renderDiffsView(diffsPanelEl, projections.get(sessionId));
}

function markDiffsViewDirty(): void {
  diffPanelDirty = true;
}

function shouldRenderDiffsView(projection: SessionProjection | undefined): boolean {
  return (
    diffPanelDirty ||
    activeSessionId !== lastDiffsRenderedSessionId ||
    Boolean(projection) !== lastDiffsRenderedProjectionPresent
  );
}

function isDiffsPanelActive(): boolean {
  return dockviewApi?.activePanel?.id === "diffs";
}

function requestActiveDiffState(): void {
  if (!activeSessionId || !diffsPanelEl || !isDiffsPanelActive()) return;
  if (!projections.has(activeSessionId) || diffLoadingSessions.has(activeSessionId)) return;

  requestDiffState(
    activeSessionId,
    diffSelectedSnapshots.get(activeSessionId),
    diffSelectedHeads.get(activeSessionId),
  );
}

function createDiffSnapshot(sessionId: string): void {
  const label = window.prompt("Snapshot label", "manual");
  if (label === null) return;
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  send({ type: "diff.snapshot", sessionId, label: label.trim() || undefined });
  if (diffsPanelEl && isDiffsPanelActive()) renderDiffsView(diffsPanelEl, projections.get(sessionId));
}

function rerenderDiffsViewPreservingScroll(sessionId: string): void {
  if (!diffsPanelEl || !isDiffsPanelActive()) return;
  const mainBody = diffsPanelEl.querySelector<HTMLElement>(".diffs-main-body");
  const sidebarScroll = diffsPanelEl.querySelector<HTMLElement>(".diffs-sidebar-scroll");
  const mainScrollTop = mainBody?.scrollTop ?? 0;
  const sidebarScrollTop = sidebarScroll?.scrollTop ?? 0;

  renderDiffsView(diffsPanelEl, projections.get(sessionId));

  const nextMainBody = diffsPanelEl.querySelector<HTMLElement>(".diffs-main-body");
  const nextSidebarScroll = diffsPanelEl.querySelector<HTMLElement>(".diffs-sidebar-scroll");
  if (nextMainBody) nextMainBody.scrollTop = mainScrollTop;
  if (nextSidebarScroll) nextSidebarScroll.scrollTop = sidebarScrollTop;
}

function addDiffComment(
  sessionId: string,
  baseSnapshot: DiffSnapshotSummary,
  headSnapshot: DiffSnapshotSummary | null,
  location: DiffLineLocation,
): void {
  const comment = window.prompt("Comment on this diff line");
  if (!comment?.trim()) return;
  const comments = diffComments.get(sessionId) ?? [];
  comments.push({
    id: `${Date.now()}-${comments.length}`,
    baseSnapshotEntryId: baseSnapshot.entryId,
    headSnapshotEntryId: headSnapshot?.entryId ?? null,
    filePath: location.filePath,
    hunk: location.hunk,
    kind: location.kind,
    oldLine: location.oldLine,
    newLine: location.newLine,
    lineText: location.text,
    text: comment.trim(),
  });
  diffComments.set(sessionId, comments);
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function isSameDiffComparison(
  comment: DiffComment,
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
): boolean {
  if (!baseSnapshot) return false;
  return (
    comment.baseSnapshotEntryId === baseSnapshot.entryId &&
    comment.headSnapshotEntryId === (headSnapshot?.entryId ?? null)
  );
}

function commentsForLocation(
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
  location: DiffLineLocation,
): DiffComment[] {
  return comments.filter(
    comment =>
      isSameDiffComparison(comment, baseSnapshot, headSnapshot) &&
      comment.filePath === location.filePath &&
      comment.hunk === location.hunk &&
      comment.kind === location.kind &&
      comment.oldLine === location.oldLine &&
      comment.newLine === location.newLine &&
      comment.lineText === location.text,
  );
}

function formatDiffLocation(comment: DiffComment): string {
  const parts = [comment.filePath || "unknown file"];
  if (comment.oldLine !== undefined) parts.push(`old:${comment.oldLine}`);
  if (comment.newLine !== undefined) parts.push(`new:${comment.newLine}`);
  return parts.join(" ");
}

function diffRowText(row: ParsedDiffRow): string {
  return row.type === "line" ? row.location.text : row.text;
}

function isCommentLocation(row: ParsedDiffRow, comment: DiffComment): boolean {
  return (
    row.type === "line" &&
    row.location.filePath === comment.filePath &&
    row.location.hunk === comment.hunk &&
    row.location.kind === comment.kind &&
    row.location.oldLine === comment.oldLine &&
    row.location.newLine === comment.newLine &&
    row.location.text === comment.lineText
  );
}

function buildDiffCommentContext(rows: ParsedDiffRow[], comment: DiffComment): string {
  const index = rows.findIndex(row => isCommentLocation(row, comment));
  if (index === -1) {
    return [comment.hunk, comment.lineText].filter((line): line is string => Boolean(line)).join("\n");
  }

  const before: string[] = [];
  let beforeLineCount = 0;
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file") break;
    if (row.type === "hunk") {
      if (row.filePath === comment.filePath && row.hunk === comment.hunk) before.unshift(row.text);
      break;
    }
    if (
      row.type === "line" &&
      row.location.filePath === comment.filePath &&
      row.location.hunk === comment.hunk
    ) {
      if (beforeLineCount >= DIFF_COMMENT_CONTEXT_RADIUS) break;
      before.unshift(diffRowText(row));
      beforeLineCount += 1;
    }
  }

  if (comment.hunk && !before.some(line => line === comment.hunk)) before.unshift(comment.hunk);

  const after: string[] = [];
  let afterLineCount = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file" || row.type === "hunk") break;
    if (
      row.type === "line" &&
      row.location.filePath === comment.filePath &&
      row.location.hunk === comment.hunk
    ) {
      if (afterLineCount >= DIFF_COMMENT_CONTEXT_RADIUS) break;
      after.push(diffRowText(row));
      afterLineCount += 1;
    }
  }

  const targetRow = rows[index];
  return targetRow ? [...before, diffRowText(targetRow), ...after].join("\n") : comment.lineText;
}

function buildDiffCommentPrompt(state: RepoDiffState, comments: DiffComment[]): string {
  const baseSnapshot = state.selectedSnapshot;
  const headSnapshot = state.headSnapshot;
  const rows = parseDiffRows(state.diff);
  const commentSections = comments
    .map((comment, index) =>
      [
        `### Comment ${index + 1}`,
        `Location: ${formatDiffLocation(comment)}`,
        comment.hunk ? `Hunk: ${comment.hunk}` : undefined,
        `Diff line: ${comment.lineText}`,
        `Comment: ${comment.text}`,
        "",
        "Relevant diff context:",
        "```diff",
        buildDiffCommentContext(rows, comment),
        "```",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [
    "I reviewed the repository diff in Fura and left comments on specific diff lines.",
    baseSnapshot ? `Base snapshot: ${baseSnapshot.label} (${baseSnapshot.entryId})` : "Base snapshot: none",
    headSnapshot
      ? `Compared to snapshot: ${headSnapshot.label} (${headSnapshot.entryId})`
      : "Compared to: current working tree",
    "",
    "Only the diff context around commented lines is included below; the full diff is intentionally omitted.",
    "",
    commentSections,
    "",
    "Please address these comments. Use the file path and old/new diff line metadata to locate each comment precisely.",
  ].join("\n");
}

function selectedDiffComments(sessionId: string, state: RepoDiffState): DiffComment[] {
  const baseSnapshot = state.selectedSnapshot;
  if (!baseSnapshot) return [];
  return (diffComments.get(sessionId) ?? []).filter(comment =>
    isSameDiffComparison(comment, baseSnapshot, state.headSnapshot),
  );
}

function sendDiffComments(sessionId: string, state: RepoDiffState, comments: DiffComment[]): void {
  const baseSnapshot = state.selectedSnapshot;
  if (!baseSnapshot || comments.length === 0) return;
  const headSnapshot = state.headSnapshot;
  const clearFlushedComments = () => {
    diffComments.set(
      sessionId,
      (diffComments.get(sessionId) ?? []).filter(
        comment => !isSameDiffComparison(comment, baseSnapshot, headSnapshot),
      ),
    );
    markDiffsViewDirty();
    rerenderDiffsViewPreservingScroll(sessionId);
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: buildDiffCommentPrompt(state, comments),
    editorText: `Flush ${comments.length} diff comment${comments.length === 1 ? "" : "s"}`,
    images: [],
    onSend: clearFlushedComments,
  });
}

function previewDiffComments(sessionId: string, state: RepoDiffState): void {
  const comments = selectedDiffComments(sessionId, state);
  if (comments.length === 0) return;
  diffPreviewDraft = { sessionId, state, comments };
  diffPreviewText.value = buildDiffCommentPrompt(state, comments);
  diffPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
}

function closeDiffPreview(): void {
  diffPreviewOverlay.hidden = true;
  diffPreviewText.value = "";
  diffPreviewStatus.textContent = "";
  diffPreviewDraft = null;
}

function sendDiffPreviewDraft(): void {
  const draft = diffPreviewDraft;
  if (!draft) return;
  closeDiffPreview();
  sendDiffComments(draft.sessionId, draft.state, draft.comments);
}

function flushDiffComments(sessionId: string, state: RepoDiffState): void {
  previewDiffComments(sessionId, state);
}

function scrollDiffsToFile(container: HTMLElement, filePath: string): void {
  const mainBody = container.querySelector<HTMLElement>(".diffs-main-body");
  if (!mainBody) return;
  const targets = [...container.querySelectorAll<HTMLElement>("[data-diff-file-path]")];
  const target = targets.find(element => element.dataset.diffFilePath === filePath);
  if (!target) return;

  const targetRect = target.getBoundingClientRect();
  const bodyRect = mainBody.getBoundingClientRect();
  const scrollTop = Math.max(0, mainBody.scrollTop + targetRect.top - bodyRect.top - 8);
  mainBody.scrollTo({ top: scrollTop, behavior: "smooth" });
  target.classList.add("diff-line-target");
  window.setTimeout(() => target.classList.remove("diff-line-target"), 1200);
}

function renderDiffsView(container: HTMLElement, projection: SessionProjection | undefined): void {
  _renderOwner = container.ownerDocument;
  lastDiffsRenderedSessionId = activeSessionId;
  lastDiffsRenderedProjectionPresent = Boolean(projection);
  diffPanelDirty = false;
  container.replaceChildren();

  if (!activeSessionId || !projection) {
    const empty = mkEl("p");
    empty.className = "empty diffs-empty";
    empty.textContent = "No session selected.";
    container.append(empty);
    return;
  }

  const sessionId = activeSessionId;
  const state = diffStates.get(sessionId);
  const selectedSnapshot = state?.selectedSnapshot ?? null;
  const headSnapshot = state?.headSnapshot ?? null;
  const comments = diffComments.get(sessionId) ?? [];
  const selectedComments = comments.filter(comment =>
    isSameDiffComparison(comment, selectedSnapshot, headSnapshot),
  );
  const parsedRows = state?.diff.trim() ? parseDiffRows(state.diff) : [];
  const fileSummaries = summarizeDiffFiles(parsedRows, comments, selectedSnapshot, headSnapshot);

  const root = mkEl("div");
  root.className = "diffs-view";

  const sidebar = mkEl("aside");
  sidebar.className = "diffs-sidebar";
  const sideHeader = mkEl("div");
  sideHeader.className = "diffs-sidebar-header";
  const sideTitle = mkEl("strong");
  sideTitle.textContent = "Snapshots";
  const snapshotBtn = mkEl("button");
  snapshotBtn.type = "button";
  snapshotBtn.textContent = "New";
  snapshotBtn.addEventListener("click", () => createDiffSnapshot(sessionId));
  sideHeader.append(sideTitle, snapshotBtn);
  sidebar.append(sideHeader);

  const sidebarScroll = mkEl("div");
  sidebarScroll.className = "diffs-sidebar-scroll";
  sidebar.append(sidebarScroll);


  const snapshots = state?.snapshots ?? [];
  const snapshotList = mkEl("div");
  snapshotList.className = "diffs-snapshot-list";
  if (snapshots.length === 0) {
    const empty = mkEl("p");
    empty.className = "empty diffs-empty";
    empty.textContent = diffLoadingSessions.has(sessionId) ? "Loading snapshots…" : "No snapshots yet.";
    snapshotList.append(empty);
  } else {
    for (const snapshot of snapshots) {
      const button = mkEl("button");
      button.type = "button";
      button.className = `diff-snapshot ${snapshot.entryId === selectedSnapshot?.entryId ? "active" : ""}`;
      const label = mkEl("strong");
      label.textContent = snapshot.label;
      const meta = mkEl("span");
      meta.textContent = `${snapshot.kind} · ${new Date(snapshot.createdAt).toLocaleString()}`;
      button.append(label, meta);
      button.addEventListener("click", () => {
        diffSelectedSnapshots.set(sessionId, snapshot.entryId);
        requestDiffState(
          sessionId,
          snapshot.entryId,
          diffSelectedHeads.get(sessionId),
        );
      });
      snapshotList.append(button);
    }
  }
  sidebarScroll.append(snapshotList);

  if (fileSummaries.length > 0) {
    const filesSection = mkEl("section");
    filesSection.className = "diffs-files";
    const filesTitle = mkEl("strong");
    filesTitle.textContent = `Modified files (${fileSummaries.length})`;
    filesSection.append(filesTitle);
    const filesList = mkEl("div");
    filesList.className = "diffs-file-list";
    for (const [index, file] of fileSummaries.entries()) {
      const button = mkEl("button");
      button.type = "button";
      button.className = "diffs-file-item";
      const name = mkEl("code");
      name.textContent = file.filePath;
      const meta = mkEl("span");
      meta.textContent = `+${file.added} -${file.removed}${file.commentCount > 0 ? ` · ${file.commentCount} comment${file.commentCount === 1 ? "" : "s"}` : ""}`;
      button.append(name, meta);
      button.addEventListener("click", () => {
        scrollDiffsToFile(container, file.filePath);
      });
      filesList.append(button);
    }
    filesSection.append(filesList);
    sidebarScroll.append(filesSection);
  }

  const main = mkEl("section");
  main.className = "diffs-main";
  const toolbar = mkEl("div");
  toolbar.className = "diffs-toolbar";
  const title = mkEl("strong");
  title.textContent = selectedSnapshot
    ? headSnapshot
      ? `Diff ${selectedSnapshot.label} → ${headSnapshot.label}`
      : `Diff ${selectedSnapshot.label} → current`
    : "Diff";
  const actions = mkEl("div");
  actions.className = "diffs-actions";
  const headSelect = mkEl("select");
  headSelect.className = "diff-compare-select";
  const currentOption = mkEl("option");
  currentOption.value = "";
  currentOption.textContent = "Compare to current";
  headSelect.append(currentOption);
  for (const snapshot of snapshots) {
    const option = mkEl("option");
    option.value = snapshot.entryId;
    option.textContent = `Compare to ${snapshot.label}`;
    if (snapshot.entryId === (headSnapshot?.entryId ?? diffSelectedHeads.get(sessionId) ?? null)) {
      option.selected = true;
    }
    headSelect.append(option);
  }
  headSelect.disabled = diffLoadingSessions.has(sessionId) || !selectedSnapshot;
  headSelect.addEventListener("change", () => {
    const nextHead = headSelect.value || null;
    diffSelectedHeads.set(sessionId, nextHead);
    requestDiffState(sessionId, selectedSnapshot?.entryId, nextHead);
  });
  const refreshBtn = mkEl("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = diffLoadingSessions.has(sessionId) ? "Refreshing…" : "Refresh";
  refreshBtn.disabled = diffLoadingSessions.has(sessionId);
  refreshBtn.addEventListener("click", () => requestDiffState(
    sessionId,
    selectedSnapshot?.entryId,
    headSnapshot?.entryId ?? diffSelectedHeads.get(sessionId),
  ));
  const previewBtn = mkEl("button");
  previewBtn.type = "button";
  previewBtn.textContent = "Preview comments";
  previewBtn.disabled = !state || selectedComments.length === 0;
  previewBtn.addEventListener("click", () => {
    if (state) previewDiffComments(sessionId, state);
  });
  const flushBtn = mkEl("button");
  flushBtn.type = "button";
  flushBtn.textContent = `Preview & flush (${selectedComments.length})`;
  flushBtn.disabled = !state || selectedComments.length === 0;
  flushBtn.addEventListener("click", () => {
    if (state) flushDiffComments(sessionId, state);
  });
  actions.append(headSelect, refreshBtn, previewBtn, flushBtn);
  toolbar.append(title, actions);
  main.append(toolbar);

  const mainBody = mkEl("div");
  mainBody.className = "diffs-main-body";
  main.append(mainBody);

  if (!state || diffLoadingSessions.has(sessionId)) {
    const loading = mkEl("p");
    loading.className = "empty diffs-empty";
    loading.textContent = "Loading diff…";
    mainBody.append(loading);
  } else if (!selectedSnapshot) {
    const empty = mkEl("p");
    empty.className = "empty diffs-empty";
    empty.textContent = "Select or create a snapshot.";
    mainBody.append(empty);
  } else if (!state.diff.trim()) {
    const empty = mkEl("p");
    empty.className = "empty diffs-empty";
    empty.textContent = "No changes for this comparison.";
    mainBody.append(empty);
  } else {
    const diff = mkEl("div");
    diff.className = "diff-lines";
    for (const row of parsedRows) {
      if (row.type === "line") {
        const lineComments = commentsForLocation(comments, selectedSnapshot, headSnapshot, row.location);
        const lineWrap = mkEl("div");
        lineWrap.className = "diff-line-wrap";
        const line = mkEl("div");
        line.className = `diff-line diff-line-${row.location.kind}`;
        const commentBtn = mkEl("button");
        commentBtn.type = "button";
        commentBtn.className = `diff-comment-btn ${lineComments.length > 0 ? "has-comments" : ""}`;
        commentBtn.textContent = lineComments.length > 0 ? String(lineComments.length) : "+";
        commentBtn.title = "Comment on this diff line";
        commentBtn.addEventListener("click", () => addDiffComment(
          sessionId,
          selectedSnapshot,
          headSnapshot,
          row.location,
        ));
        const gutter = mkEl("span");
        gutter.className = "diff-gutter";
        gutter.textContent = row.location.newLine !== undefined
          ? String(row.location.newLine)
          : String(row.location.oldLine ?? "");
        const content = mkEl("div");
        content.className = "diff-line-content";
        const text = mkEl("code");
        text.textContent = row.location.text;
        content.append(text);
        line.append(commentBtn, gutter, content);
        lineWrap.append(line);
        if (lineComments.length > 0) {
          const thread = mkEl("div");
          thread.className = "diff-inline-comments";
          for (const comment of lineComments) {
            const item = mkEl("div");
            item.className = "diff-inline-comment";
            item.textContent = comment.text;
            thread.append(item);
          }
          lineWrap.append(thread);
        }
        diff.append(lineWrap);
        continue;
      }

      const line = mkEl("div");
      line.className = `diff-line diff-line-${row.type}`;
      if (row.type === "file") {
        line.dataset.diffFilePath = row.filePath;
      }
      const spacer = mkEl("span");
      spacer.className = "diff-comment-spacer";
      const text = mkEl("code");
      text.textContent = row.text;
      line.append(spacer, text);
      diff.append(line);
    }
    mainBody.append(diff);
  }

  const commentsPanel = mkEl("section");
  commentsPanel.className = "diff-comments";
  const commentsTitle = mkEl("strong");
  commentsTitle.textContent = "Comments";
  commentsPanel.append(commentsTitle);
  if (selectedComments.length === 0) {
    const empty = mkEl("p");
    empty.className = "empty";
    empty.textContent = "No comments on this diff yet.";
    commentsPanel.append(empty);
  } else {
    for (const comment of selectedComments) {
      const item = mkEl("article");
      item.className = "diff-comment";
      const loc = mkEl("code");
      loc.textContent = formatDiffLocation(comment);
      const body = mkEl("p");
      body.textContent = comment.text;
      item.append(loc, body);
      commentsPanel.append(item);
    }
  }
  mainBody.append(commentsPanel);

  root.append(sidebar, main);
  container.append(root);
}

// --- Dockview initialization ---

function initDockview(): void {
  const host = requireElement<HTMLDivElement>("workspacePanelHost");

  const dv = new DockviewComponent(host, {
    theme: themeDark,
    createComponent(options) {
      switch (options.name) {
        case "transcript": {
          const el = document.createElement("div");
          el.className = "panel-content panel-content-transcript";
          return {
            element: el,
            init(params) {
              const toolbar = makePanelToolbar(params.api.group);
              const scroll = document.createElement("div");
              scroll.className = "panel-scroll";
              el.append(toolbar, scroll);
              transcriptPanelEl = scroll;
              renderTranscriptView(
                scroll,
                activeSessionId ? projections.get(activeSessionId) : undefined,
                true,
              );
            },
          };
        }
        case "tools": {
          const el = document.createElement("div");
          el.className = "panel-content panel-content-tools";
          return {
            element: el,
            init(params) {
              const toolbar = makePanelToolbar(params.api.group);
              const scroll = document.createElement("div");
              scroll.className = "panel-scroll";
              el.append(toolbar, scroll);
              toolsPanelEl = scroll;
              renderToolsView(
                scroll,
                activeSessionId ? projections.get(activeSessionId) : undefined,
              );
            },
          };
        }
        case "diffs": {
          const el = document.createElement("div");
          el.className = "panel-content panel-content-diffs";
          return {
            element: el,
            init(params) {
              const toolbar = makePanelToolbar(params.api.group);
              const scroll = document.createElement("div");
              scroll.className = "panel-scroll";
              el.append(toolbar, scroll);
              diffsPanelEl = scroll;
            },
          };
        }
        default: {
          const el = document.createElement("div");
          return { element: el, init() {} };
        }
      }
    },
  });

  dockviewApi = dv;
  dv.onDidActivePanelChange(panel => {
    if (panel?.id === "diffs") {
      if (diffsPanelEl) renderDiffsView(diffsPanelEl, activeSessionId ? projections.get(activeSessionId) : undefined);
      requestActiveDiffState();
    }
  });

  // Show a session notice when a popout window is blocked by the browser.
  dv.onDidOpenPopoutWindowFail(() => {
    const sid = activeSessionId;
    if (!sid) return;
    const notices = sessionNotices.get(sid) ?? [];
    notices.push({
      level: "warning",
      text: "Popup window was blocked. Allow popups for this site to use the pop-out feature.",
    });
    sessionNotices.set(sid, notices);
    render();
  });

  // Restore persisted layout or fall back to the two-panel default.
  const stored = localStorage.getItem(DOCKVIEW_LAYOUT_STORAGE_KEY);
  let layoutRestored = false;

  if (stored) {
    try {
      const data = JSON.parse(stored) as PersistedDockviewLayout;
      if (data.version === 1 && data.layout) {
        dv.fromJSON(data.layout);
        layoutRestored = true;
      }
    } catch {
      // Corrupt or incompatible layout — fall through to default.
    }
  }

  if (!layoutRestored) {
    loadDefaultLayout();
  }
  const hasDiffsPanel = dockviewApi.panels.some(panel => panel.id === "diffs");
  if (!hasDiffsPanel) {
    dockviewApi.addPanel({
      id: "diffs",
      component: "diffs",
      title: "Diffs",
      position: { referencePanel: "tools", direction: "below" },
      renderer: "always",
    });
  }
  if (isDiffsPanelActive() && diffsPanelEl) {
    renderDiffsView(diffsPanelEl, activeSessionId ? projections.get(activeSessionId) : undefined);
    requestActiveDiffState();
  }

  // Persist layout on change (debounced: avoid rapid writes during drag).
  let layoutSaveTimer: number | undefined;
  dv.onDidLayoutChange(() => {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      if (!dockviewApi) return;
      const data: PersistedDockviewLayout = { version: 1, layout: dockviewApi.toJSON() };
      localStorage.setItem(DOCKVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(data));
    }, 300);
  });
}

function loadDefaultLayout(): void {
  if (!dockviewApi) return;
  dockviewApi.addPanel({
    id: "transcript",
    component: "transcript",
    title: "Transcript",
    renderer: "always",
  });
  dockviewApi.addPanel({
    id: "tools",
    component: "tools",
    title: "Tools",
    position: { referencePanel: "transcript", direction: "right" },
    renderer: "always",
  });
  dockviewApi.addPanel({
    id: "diffs",
    component: "diffs",
    title: "Diffs",
    position: { referencePanel: "tools", direction: "below" },
    renderer: "always",
  });
}

// Creates a minimal panel toolbar with a Pop-out button.
// `group` is a DockviewGroupPanel used as the target for addPopoutGroup.
function makePanelToolbar(group: import("dockview-core").DockviewGroupPanel): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "panel-toolbar";

  const popoutBtn = document.createElement("button");
  popoutBtn.type = "button";
  popoutBtn.className = "panel-popout-btn";
  popoutBtn.title = "Open panel in a separate window";
  popoutBtn.textContent = "Pop out";
  popoutBtn.addEventListener("click", () => {
    void dockviewApi?.addPopoutGroup(group, {
      popoutUrl: "/popout.html",
      onDidOpen: ({ window: popWin }) => {
        // Transfer stylesheets from the main window to the popout window so
        // Fura and dockview CSS is available there.
        document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
          popWin.document.head.appendChild(popWin.document.importNode(node, true));
        });
      },
    });
  });
  toolbar.append(popoutBtn);
  return toolbar;
}

// --- Status bar ---

function renderStatusBar(projection?: SessionProjection): void {
  statusBar.replaceChildren();
  statusBar.classList.toggle("busy", Boolean(projection?.isBusy));

  const parts: HTMLElement[] = [];
  const piSpan = statusPart("π", "status-pi");
  if (projection?.isBusy) piSpan.classList.add("is-running");
  parts.push(piSpan);

  if (!projection) {
    parts.push(statusPart("No session", "muted"));
    statusBar.append(...interleaveStatusParts(parts));
    return;
  }

  const cwd = projection.summary.cwd ?? "current cwd";
  parts.push(statusPart(projection.model ?? "model unknown", "model"));
  parts.push(statusPart(projection.thinkingLevel ?? "thinking inherit", "thinking"));
  if (projection.planMode?.enabled) parts.push(statusPart("Plan", "mode"));
  parts.push(statusPart(`📁 ${shortPath(cwd)}`, "cwd"));
  parts.push(statusPart(formatTokens(projection.tokensTotal), "tokens"));
  parts.push(statusPart(formatCost(projection.costUsd), "cost"));
  if (projection.contextPercent != null && projection.contextWindow != null) {
    parts.push(statusPart(formatContext(projection.contextPercent, projection.contextWindow), "context"));
  }
  if (projection.isBusy) {
    parts.push(statusInterruptButton());
  }

  statusBar.append(...interleaveStatusParts(parts));
}

function interleaveStatusParts(parts: HTMLElement[]): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) nodes.push(statusPart("›", "separator"));
    nodes.push(parts[i]);
  }
  return nodes;
}

function statusPart(text: string, className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = `status-part ${className}`;
  span.textContent = text;
  return span;
}

function statusInterruptButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-part interrupt";
  button.textContent = "esc to interrupt";
  button.addEventListener("click", () => {
    if (activeSessionId) send({ type: "prompt.abort", sessionId: activeSessionId });
  });
  return button;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("/") && parts.length > 2) return `…/${parts.slice(-2).join("/")}`;
  return path;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 tokens";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${value}`;
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function formatContext(percent: number, windowSize: number): string {
  const pct = percent < 1 ? percent.toFixed(2) : percent.toFixed(1);
  const win = windowSize >= 1_000_000 ? `${(windowSize / 1_000_000).toFixed(1)}M`
    : windowSize >= 1_000 ? `${Math.round(windowSize / 1_000)}K`
    : `${windowSize}`;
  return `${pct}%/${win}`;
}

// --- Document creation helpers (popout-safe) ---
// These use _renderOwner instead of the global document so that elements created during
// renderTranscriptView / renderToolsView belong to the correct window document,
// even when those panels are popped out into a separate browser window.

function mkEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return _renderOwner.createElement(tag);
}

function mkText(text: string): Text {
  return _renderOwner.createTextNode(text);
}

function mkFrag(): DocumentFragment {
  return _renderOwner.createDocumentFragment();
}

// --- Message rendering ---

function renderMessage(message: TranscriptMessage): HTMLElement {
  const article = mkEl("article");
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id;
  const visibleBlocks = message.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => thinkingVisibilityMode !== "hidden" || block.kind === "text");
  if (visibleBlocks.length === 0) {
    article.hidden = true;
    return article;
  }

  // System-role messages carry no header — the fenced code block header already
  // labels the content type. All other roles get a header row.
  if (message.role !== "system") {
    const header = mkEl("header");
    const roleLabel = mkEl("strong");
    roleLabel.textContent = message.role === "user" ? "You" : message.role;
    const copy = mkEl("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(messageText(message));
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 900);
    });
    header.append(roleLabel, copy);
    article.append(header);
  }

  for (const { block, index } of visibleBlocks) {
    article.append(renderBlock(block, message.isNew, message.id, index));
  }

  return article;
}

function renderToolCard(card: ToolCard): HTMLElement {
  if (card.toolName === "todo_write") return renderTodoWriteCard(card);
  if (card.toolName === "task") return renderTaskCard(card);
  if (card.toolName === "read") return renderReadToolCard(card);
  if (card.toolName === "grep") return renderGrepToolCard(card);
  const wrapper = mkEl("section");
  wrapper.className = `tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = card.toolName;

  const header = mkEl("div");
  header.className = "tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText(card.toolName, "tool-name"),
    toolHeaderText(toolArgSummary(card.args), "tool-args-summary"),
  );
  wrapper.append(header);

  appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));

  return wrapper;
}

function renderReadToolCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card read-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${card.isError ? "" : "tool-compact"}`;
  wrapper.dataset.toolName = "read";

  const header = mkEl("div");
  header.className = "tool-header read-tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Read", "tool-name"),
    toolHeaderText(readArgSummary(card), "tool-args-summary"),
  );
  wrapper.append(header);

  if (card.isError) {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
  }

  return wrapper;
}

function renderReadToolGroup(cards: Array<{ kind: "tool" } & ToolCard>): HTMLElement {
  const wrapper = mkEl("section");
  const isActive = cards.some(card => card.isActive);
  wrapper.className = `tool-card read-tool-card read-tool-group ${isActive ? "tool-active" : ""} tool-compact`;
  wrapper.dataset.toolName = "read";

  const header = mkEl("div");
  header.className = "tool-header read-tool-header";
  header.append(
    toolStatusIcon({ ...cards[0], isActive }),
    toolHeaderText("Read", "tool-name"),
    toolHeaderText(`(${cards.length})`, "tool-count"),
  );
  wrapper.append(header);

  const list = mkEl("div");
  list.className = "read-tool-list";
  cards.forEach((card, index) => {
    const row = mkEl("div");
    row.className = "read-tool-row";
    row.append(
      toolHeaderText(index === cards.length - 1 ? "└─" : "├─", "read-tool-connector"),
      toolStatusIcon(card),
      toolHeaderText(readArgSummary(card), "read-tool-path"),
    );
    list.append(row);
  });
  wrapper.append(list);

  return wrapper;
}

function isCompactReadCard(entry: TranscriptEntry | undefined): entry is { kind: "tool" } & ToolCard {
  return entry?.kind === "tool" && entry.toolName === "read" && !entry.isError;
}

function readArgSummary(card: ToolCard): string {
  const correctedPath = readSuffixResolution(card)?.to;
  const path = correctedPath ?? stringArg(card.args, "file_path") ?? stringArg(card.args, "path");
  const selection = stringArg(card.args, "sel");
  const suffix = selection ? `:${selection}` : "";
  const summary = path ? `${shortPath(path)}${suffix}` : suffix || "…";
  const correctedFrom = readSuffixResolution(card)?.from;
  return correctedFrom ? `${summary} (corrected from ${shortPath(correctedFrom)})` : summary;
}

function readSuffixResolution(card: ToolCard): { from?: string; to?: string } | undefined {
  const source = isRecord(card.result) ? card.result : card.partialResult;
  if (!isRecord(source) || !isRecord(source.details) || !isRecord(source.details.suffixResolution)) return undefined;
  const { from, to } = source.details.suffixResolution;
  return {
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function renderGrepToolCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card grep-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${card.isError ? "" : "tool-compact"}`;
  wrapper.dataset.toolName = "grep";

  const header = mkEl("div");
  header.className = "tool-header grep-tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Grep:", "tool-name"),
    toolHeaderText(grepPatternSummary(card), "grep-pattern"),
    toolHeaderText(grepMetaSummary(card), "tool-args-summary"),
  );
  wrapper.append(header);

  if (card.isError) {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
    return wrapper;
  }

  const collapsed = grepCollapsedSummary(card);
  if (collapsed) {
    const row = mkEl("div");
    row.className = "grep-tool-row";
    row.append(
      toolHeaderText("└─", "grep-tool-connector"),
      toolHeaderText(collapsed, "grep-tool-summary"),
    );
    wrapper.append(row);
  }

  return wrapper;
}

function grepPatternSummary(card: ToolCard): string {
  return truncate(stringArg(card.args, "pattern") ?? "…", 110);
}

function grepMetaSummary(card: ToolCard): string {
  const source = card.partialResult ?? card.result;
  const details = resultDetails(source);
  const parts: string[] = [];

  const matchCount = numberDetail(details, "matchCount");
  const fileCount = numberDetail(details, "fileCount");
  if (matchCount !== undefined) parts.push(formatCount("match", matchCount));
  if (fileCount !== undefined) parts.push(formatCount("file", fileCount));

  const scope = stringDetail(details, "scopePath") ?? stringArg(card.args, "path");
  if (scope) parts.push(`in ${shortPath(scope)}`);
  if (booleanDetail(details, "truncated")) parts.push("truncated");
  if (stringArg(card.args, "i") === "true" || card.args.i === true) parts.push("case:insensitive");

  return parts.join(" · ");
}

function grepCollapsedSummary(card: ToolCard): string {
  const source = card.partialResult ?? card.result;
  const details = resultDetails(source);
  const resultText = toolResultText(source);
  const matchCount = numberDetail(details, "matchCount");

  if (matchCount === 0 || resultText.trim() === "No matches found") return "No matches found";
  if (matchCount !== undefined) return `${formatCount("match", matchCount)} collapsed`;

  const lineCount = resultText.split("\n").filter(line => line.trim()).length;
  if (lineCount > 0) return `${formatCount("line", lineCount)} collapsed`;
  return "";
}

function resultDetails(source: unknown): Record<string, unknown> | undefined {
  return isRecord(source) && isRecord(source.details) ? source.details : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanDetail(details: Record<string, unknown> | undefined, key: string): boolean {
  return details?.[key] === true;
}

function formatCount(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function appendToolResultBody(wrapper: HTMLElement, resultText: string): void {
  if (!resultText) return;
  const body = mkEl("div");
  body.className = "tool-result-body";
  const pre = mkEl("pre");
  pre.className = "tool-result-text";
  pre.textContent = truncate(resultText, 8000);
  body.append(pre);
  wrapper.append(body);
}

function renderTodoWriteCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card todo-write-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "todo_write";

  const header = mkEl("div");
  header.className = "tool-header todo-write-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Todo Write", "tool-name"),
  );
  const phases = todoPhases(card.partialResult ?? card.result);
  const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  header.append(toolHeaderText(`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`, "tool-args-summary"));
  wrapper.append(header);

  if (phases.length > 0) {
    const tree = mkEl("div");
    tree.className = "todo-tree";
    for (const phase of phases) tree.append(renderTodoPhase(phase, phases.length > 1));
    wrapper.append(tree);
  } else {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
  }

  return wrapper;
}

function renderTodoPhase(phase: TodoPhase, showPhaseName: boolean): HTMLElement {
  const section = mkEl("section");
  section.className = "todo-phase";

  if (showPhaseName) {
    const title = mkEl("div");
    title.className = "todo-phase-title";
    title.textContent = `└─ ${phase.name}`;
    section.append(title);
  }

  const list = mkEl("div");
  list.className = "todo-task-list";
  phase.tasks.forEach((todo, index) => {
    list.append(renderTodoItem(todo, index === 0));
  });
  section.append(list);
  return section;
}

function renderTodoItem(todo: TodoItem, firstInPhase: boolean): HTMLElement {
  const row = mkEl("div");
  row.className = `todo-task todo-${todo.status}`;

  const prefix = mkEl("span");
  prefix.className = "todo-prefix";
  prefix.textContent = firstInPhase ? "└─" : "  ";

  const icon = mkEl("span");
  icon.className = "todo-icon";
  icon.textContent = todo.status === "completed" ? "☑" : "☐";

  const content = mkEl("span");
  content.className = "todo-content";
  content.textContent = todo.content;

  row.append(prefix, icon, content);

  if (todo.status === "in_progress" && todo.details) {
    for (const line of todo.details.split("\n")) {
      const details = mkEl("div");
      details.className = "todo-details";
      details.textContent = line;
      row.append(details);
    }
  }

  return row;
}

function todoPhases(value: unknown): TodoPhase[] {
  if (!isRecord(value) || !isRecord(value.details) || !Array.isArray(value.details.phases)) return [];
  return value.details.phases.filter(isTodoPhase);
}

function isTodoPhase(value: unknown): value is TodoPhase {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && Array.isArray(value.tasks)
    && value.tasks.every(isTodoItem);
}

function isTodoItem(value: unknown): value is TodoItem {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.content === "string"
    && isTodoStatus(value.status)
    && (value.details === undefined || typeof value.details === "string")
    && (value.notes === undefined || typeof value.notes === "string");
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function renderTaskCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card task-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "task";

  const header = mkEl("div");
  header.className = "tool-header task-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Task:", "task-label"),
    toolHeaderText(String(card.args?.agent ?? card.toolName), "task-agent-name"),
  );
  if (card.intent) header.append(toolHeaderText(card.intent, "task-intent"));
  wrapper.append(header);

  const source = card.partialResult ?? card.result;
  const progress = taskProgress(source);
  const results = taskResults(source);
  const shouldRenderProgress = progress.length > 0 && (card.isActive || results.length === 0);

  if (shouldRenderProgress) {
    const list = mkEl("div");
    list.className = "task-progress";
    for (const agent of progress) list.append(renderTaskAgent(agent));
    wrapper.append(list);
  } else if (results.length > 0) {
    const list = mkEl("div");
    list.className = "task-progress task-results";
    for (let i = 0; i < results.length; i++) list.append(renderTaskResult(results[i], i === results.length - 1));
    wrapper.append(list);
  } else {
    appendToolResultBody(wrapper, toolResultText(source));
  }

  const totals = shouldRenderProgress ? taskProgressTotals(progress) : taskResultTotals(results, source);
  if (totals) {
    const total = mkEl("div");
    total.className = "task-total";
    total.textContent = totals;
    wrapper.append(total);
  }

  return wrapper;
}

function renderTaskAgent(agent: AgentProgress): HTMLElement {
  const row = mkEl("div");
  row.className = `task-agent status-${agent.status}`;

  const main = mkEl("div");
  main.className = "task-agent-main";
  const status = toolHeaderText(taskStatusGlyph(agent.status), "task-agent-status");
  if (agent.status === "running") status.classList.add("is-running");
  main.append(
    status,
    toolHeaderText(formatTaskId(agent.id), "task-agent-id"),
    toolHeaderText(agent.description ?? agent.task, "task-agent-desc"),
  );
  const stats = taskProgressStats(agent);
  if (stats) main.append(toolHeaderText(stats, "task-agent-stats"));
  row.append(main);

  if (agent.lastIntent || agent.currentTool) {
    const activity = mkEl("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${agent.lastIntent ?? `${agent.currentTool} ${agent.currentToolArgs ?? ""}`}`;
    row.append(activity);
  }

  return row;
}

function renderTaskResult(result: TaskResult, isLast: boolean): HTMLElement {
  const resultStatus = taskResultStatus(result);
  const row = mkEl("div");
  row.className = `task-agent task-result status-${resultStatus} ${isLast ? "task-last" : ""}`;

  const main = mkEl("div");
  main.className = "task-agent-main";
  main.append(
    toolHeaderText(taskResultGlyph(result), "task-agent-status"),
    toolHeaderText(formatTaskId(result.id), "task-agent-id"),
    toolHeaderText(result.description ?? result.task, "task-agent-desc"),
    toolHeaderText(taskResultLabel(result), "task-result-badge"),
  );
  const stats = taskResultStats(result);
  if (stats) main.append(toolHeaderText(stats, "task-agent-stats"));
  row.append(main);

  const activityText = result.lastIntent ?? result.abortReason ?? result.error;
  if (activityText) {
    const activity = mkEl("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${activityText}`;
    row.append(activity);
  }

  const outputLines = taskOutputPreview(result.output);
  if (outputLines.length > 0) {
    const output = mkEl("pre");
    output.className = "task-result-output";
    output.textContent = outputLines.join("\n");
    row.append(output);
  }

  const artifactPath = result.patchPath ?? result.branchName ?? result.outputPath;
  if (artifactPath) {
    const path = mkEl("div");
    path.className = "task-result-path";
    path.textContent = `${result.patchPath ? "Patch" : result.branchName ? "Branch" : "Output"}: ${artifactPath}`;
    row.append(path);
  }

  return row;
}

function toolStatusIcon(card: ToolCard): HTMLElement {
  const span = mkEl("span");
  span.className = "tool-status-icon";
  if (card.isActive) {
    span.classList.add("is-running");
    span.textContent = "⠋";
  } else {
    span.textContent = card.isError ? "✗" : "✓";
  }
  return span;
}

function toolHeaderText(text: string, className: string): HTMLElement {
  const span = mkEl("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function taskProgress(value: unknown): AgentProgress[] {
  if (!isRecord(value)) return [];
  const details = value.details;
  if (!isRecord(details) || !Array.isArray(details.progress)) return [];
  return details.progress.filter(isAgentProgress);
}

function taskResults(value: unknown): TaskResult[] {
  if (!isRecord(value)) return [];
  const details = value.details;
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  return details.results.filter(isTaskResult);
}

function isAgentProgress(value: unknown): value is AgentProgress {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string" && typeof value.task === "string";
}

function isTaskResult(value: unknown): value is TaskResult {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.agent === "string"
    && typeof value.task === "string"
    && typeof value.exitCode === "number";
}

function taskStatusGlyph(status: AgentProgress["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "aborted") return "✗";
  if (status === "running") return "⠋";
  return "·";
}

function taskResultGlyph(result: TaskResult): string {
  if (result.aborted || result.exitCode !== 0) return "✗";
  if (result.error) return "!";
  return "✓";
}

function taskResultStatus(result: TaskResult): "completed" | "failed" | "aborted" | "warning" {
  if (result.aborted) return "aborted";
  if (result.exitCode !== 0) return "failed";
  if (result.error) return "warning";
  return "completed";
}

function taskResultLabel(result: TaskResult): string {
  if (result.aborted) return "aborted";
  if (result.exitCode !== 0) return "failed";
  if (result.error) return "merge failed";
  return "done";
}

function formatTaskId(id: string): string {
  const segments = id.split(".");
  if (segments.length < 2 && !/^\d+-/.test(id)) return id;
  return segments.map(segment => {
    const match = segment.match(/^(\d+)-(.+)$/);
    return match ? `${match[1]} ${match[2]}` : segment;
  }).join(">");
}

function taskProgressStats(agent: AgentProgress): string {
  const parts: string[] = [];
  if ((agent.toolCount ?? 0) > 0) parts.push(`${agent.toolCount} tools`);
  if ((agent.tokens ?? 0) > 0) parts.push(`${formatTokens(agent.tokens)} tokens`);
  if ((agent.durationMs ?? 0) > 0 && agent.status !== "running") parts.push(formatDuration(agent.durationMs));
  return parts.join(" · ");
}

function taskResultStats(result: TaskResult): string {
  const parts: string[] = [];
  if ((result.tokens ?? 0) > 0) parts.push(`${formatTokens(result.tokens ?? 0)} tokens`);
  if ((result.durationMs ?? 0) > 0) parts.push(formatDuration(result.durationMs ?? 0));
  if (result.truncated) parts.push("truncated");
  return parts.join(" · ");
}

function taskOutputPreview(output: string | undefined): string[] {
  if (!output?.trim()) return [];
  const lines = output
    .split("\n")
    .map(line => line.replace(/\t/g, "  ").trimEnd())
    .filter(line => line.trim().length > 0);
  const visible = lines.slice(0, 3);
  if (lines.length > visible.length) visible.push("…");
  return visible;
}

function taskProgressTotals(progress: AgentProgress[]): string {
  if (progress.length === 0) return "";
  const done = progress.filter(p => p.status === "completed").length;
  const failed = progress.filter(p => p.status === "failed" || p.status === "aborted").length;
  const duration = Math.max(...progress.map(p => p.durationMs || 0));
  if (done + failed === 0) return "";
  return `Total: ${done} succeeded${failed ? ` · ${failed} failed` : ""}${duration > 0 ? ` · ${formatDuration(duration)}` : ""}`;
}

function taskResultTotals(results: TaskResult[], source: unknown): string {
  if (results.length === 0) return "";
  const aborted = results.filter(r => r.aborted).length;
  const warnings = results.filter(r => !r.aborted && r.exitCode === 0 && Boolean(r.error)).length;
  const succeeded = results.filter(r => !r.aborted && r.exitCode === 0 && !r.error).length;
  const failed = results.length - aborted - warnings - succeeded;
  const parts: string[] = [];
  if (aborted > 0) parts.push(`${aborted} aborted`);
  if (succeeded > 0) parts.push(`${succeeded} succeeded`);
  if (warnings > 0) parts.push(`${warnings} merge failed`);
  if (failed > 0) parts.push(`${failed} failed`);
  const totalDuration = isRecord(source) && isRecord(source.details) && typeof source.details.totalDurationMs === "number"
    ? source.details.totalDurationMs
    : Math.max(...results.map(r => r.durationMs ?? 0));
  if (totalDuration > 0) parts.push(formatDuration(totalDuration));
  return parts.length > 0 ? `Total: ${parts.join(" · ")}` : "";
}

function toolArgSummary(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path) return shortPath(path);
  for (const key of ["command", "message", "input", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 70);
  }
  const first = Object.entries(args).find(([, value]) => typeof value === "string");
  return first ? `${first[0]}=${truncate(String(first[1]), 60)}` : "";
}

function toolResultText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  const content = value.content;
  if (Array.isArray(content)) {
    const text = content.map(item => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
    if (text) return text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = 1_000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;
  if (ms < sec) return `${Math.round(ms)}ms`;
  if (ms < min) return `${(ms / sec).toFixed(1)}s`;
  if (ms < hour) {
    const minutes = Math.floor(ms / min);
    const seconds = Math.floor((ms % min) / sec);
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  if (ms < day) {
    const hours = Math.floor(ms / hour);
    const minutes = Math.floor((ms % hour) / min);
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(ms / day);
  const hours = Math.floor((ms % day) / hour);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

// --- Markdown rendering ---

function renderMarkdown(text: string): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "markdown-body";

  const tokens = marked.lexer(text.trim());
  for (const token of tokens) {
    const node = renderMarkdownToken(token);
    if (node) wrapper.append(node);
  }

  if (!wrapper.hasChildNodes() && text.trim()) {
    const p = mkEl("p");
    p.textContent = text.trim();
    wrapper.append(p);
  }

  return wrapper;
}

function renderMarkdownToken(token: Token): Node | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return renderHeading(token as Tokens.Heading);
    case "paragraph":
      return renderParagraph((token as Tokens.Paragraph).tokens ?? []);
    case "code": {
      const code = token as Tokens.Code;
      return renderCodeBlock(code.lang ?? "", code.text);
    }
    case "list":
      return renderList(token as Tokens.List);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote);
    case "hr":
      return mkEl("hr");
    case "table":
      return renderTable(token as Tokens.Table);
    case "html":
      return renderPlainParagraph(token.raw.trim());
    default: {
      const text = tokenText(token).trim();
      return text ? renderPlainParagraph(text) : null;
    }
  }
}

function renderHeading(token: Tokens.Heading): HTMLElement {
  const depth = Math.min(Math.max(token.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const heading = mkEl(`h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
  heading.append(renderInlineTokens(token.tokens));
  return heading;
}

function renderParagraph(tokens: Token[]): HTMLParagraphElement {
  const p = mkEl("p");
  p.append(renderInlineTokens(tokens));
  return p;
}

function renderPlainParagraph(text: string): HTMLParagraphElement {
  const p = mkEl("p");
  p.textContent = text;
  return p;
}

function renderList(token: Tokens.List): HTMLOListElement | HTMLUListElement {
  if (token.ordered) {
    const list = mkEl("ol");
    if (typeof token.start === "number" && token.start !== 1) {
      list.start = token.start;
    }
    for (const item of token.items) {
      list.append(renderListItem(item));
    }
    return list;
  }

  const list = mkEl("ul");
  for (const item of token.items) {
    list.append(renderListItem(item));
  }
  return list;
}

function renderListItem(item: Tokens.ListItem): HTMLLIElement {
  const li = mkEl("li");
  if (item.task) {
    const checkbox = mkEl("input");
    checkbox.type = "checkbox";
    checkbox.disabled = true;
    checkbox.checked = Boolean(item.checked);
    li.append(checkbox, " ");
  }

  const tokens = item.tokens;
  for (const token of tokens) {
    if (token.type === "text") {
      li.append(renderInlineTokens(token.tokens ?? [token]));
      continue;
    }
    if (token.type === "paragraph") {
      const p = renderParagraph((token as Tokens.Paragraph).tokens ?? []);
      if (tokens.length === 1 || item.task) {
        li.append(...Array.from(p.childNodes));
      } else {
        li.append(p);
      }
      continue;
    }
    const node = renderMarkdownToken(token);
    if (node) li.append(node);
  }

  return li;
}

function renderBlockquote(token: Tokens.Blockquote): HTMLQuoteElement {
  const quote = mkEl("blockquote");
  for (const child of token.tokens) {
    const node = renderMarkdownToken(child);
    if (node) quote.append(node);
  }
  return quote;
}

function renderTable(token: Tokens.Table): HTMLTableElement {
  const table = mkEl("table");
  const thead = mkEl("thead");
  const headerRow = mkEl("tr");
  token.header.forEach((cell, index) => {
    const th = mkEl("th");
    setTableCellAlignment(th, token.align[index]);
    th.append(renderInlineTokens(cell.tokens));
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = mkEl("tbody");
  for (const row of token.rows) {
    const tr = mkEl("tr");
    row.forEach((cell, index) => {
      const td = mkEl("td");
      setTableCellAlignment(td, token.align[index]);
      td.append(renderInlineTokens(cell.tokens));
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);

  return table;
}

function setTableCellAlignment(cell: HTMLTableCellElement, align: Tokens.TableCell["align"] | undefined): void {
  if (align) cell.style.textAlign = align;
}

function renderInlineTokens(tokens: Token[]): DocumentFragment {
  const fragment = mkFrag();
  for (const token of tokens) {
    fragment.append(renderInlineToken(token));
  }
  return fragment;
}

function renderInlineToken(token: Token): Node {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) return renderInlineTokens(text.tokens);
      return mkText(text.text);
    }
    case "strong":
      return wrapInline("strong", (token as Tokens.Strong).tokens ?? []);
    case "em":
      return wrapInline("em", (token as Tokens.Em).tokens ?? []);
    case "del":
      return wrapInline("del", (token as Tokens.Del).tokens ?? []);
    case "codespan": {
      const code = mkEl("code");
      code.textContent = (token as Tokens.Codespan).text;
      return code;
    }
    case "link":
      return renderLink(token as Tokens.Link);
    case "br":
      return mkEl("br");
    case "html":
      return mkText(token.raw);
    default:
      return mkText(tokenText(token));
  }
}

function wrapInline(tagName: "strong" | "em" | "del", tokens: Token[]): HTMLElement {
  const el = mkEl(tagName);
  el.append(renderInlineTokens(tokens));
  return el;
}

function renderLink(token: Tokens.Link): HTMLElement {
  const href = safeHref(token.href);
  const el = href ? mkEl("a") : mkEl("span");
  el.append(renderInlineTokens(token.tokens));
  if (href && el instanceof HTMLAnchorElement) {
    el.href = href;
    el.target = "_blank";
    el.rel = "noreferrer noopener";
    if (token.title) el.title = token.title;
  }
  return el;
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function tokenText(token: Token): string {
  if ("text" in token && typeof token.text === "string") return token.text;
  if ("raw" in token && typeof token.raw === "string") return token.raw;
  return "";
}

function renderCodeBlock(lang: string, code: string): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "code-block";

  const header = mkEl("div");
  header.className = "code-block-header";

  const langLabel = mkEl("span");
  langLabel.className = "code-lang";
  langLabel.textContent = lang || "text";

  const copyBtn = mkEl("button");
  copyBtn.type = "button";
  copyBtn.className = "code-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = "Copied";
    window.setTimeout(() => { copyBtn.textContent = "Copy"; }, 900);
  });

  header.append(langLabel, copyBtn);
  wrapper.append(header);

  const pre = mkEl("pre");
  const codeEl = mkEl("code");
  if (lang && hljs.getLanguage(lang)) {
    codeEl.innerHTML = hljs.highlight(code, { language: lang }).value;
    codeEl.className = `hljs language-${lang}`;
  } else {
    codeEl.innerHTML = hljs.highlightAuto(code).value;
    codeEl.className = "hljs";
  }
  pre.append(codeEl);
  wrapper.append(pre);
  return wrapper;
}

// --- Block renderer ---

function renderBlock(block: ContentBlock, isNew: boolean, messageId: string, blockIndex: number): HTMLElement {
  if (block.kind === "text") {
    const wrapper = mkEl("div");
    wrapper.className = "text-block";
    wrapper.dataset.messageId = messageId;
    wrapper.dataset.blockIndex = String(blockIndex);
    wrapper.dataset.blockKind = "text";
    wrapper.append(renderMarkdown(block.text));
    return wrapper;
  }

  if (block.kind === "thinking") {
    const details = mkEl("details");
    details.className = "thinking-block";
    details.dataset.messageId = messageId;
    details.dataset.blockIndex = String(blockIndex);
    details.dataset.blockKind = "thinking";
    // The frontend visibility mode is UI-only; OMP still keeps the complete transcript.
    details.open = thinkingVisibilityMode === "shown" || isNew;

    const summary = mkEl("summary");
    summary.className = "thinking-label";
    summary.textContent = "Thinking\u2026";
    details.append(summary);

    const pre = mkEl("pre");
    pre.className = "thinking-content";
    pre.textContent = block.thinking;
    details.append(pre);

    return details;
  }

  // redactedthinking — show static label, no data
  const span = mkEl("p");
  span.className = "thinking-label thinking-redacted";
  span.dataset.messageId = messageId;
  span.dataset.blockIndex = String(blockIndex);
  span.dataset.blockKind = "redactedthinking";
  span.textContent = "Thinking\u2026 (redacted by provider)";
  return span;
}

// --- Image attachments ---

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mimeType>;base64,<data>" — strip the prefix
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function insertTextAtCursor(text: string): void {
  resetPromptHistoryNavigation();
  const start = promptInput.selectionStart ?? promptInput.value.length;
  const end = promptInput.selectionEnd ?? promptInput.value.length;
  const prefix = promptInput.value.slice(0, start);
  const suffix = promptInput.value.slice(end);
  const separator = prefix && !prefix.endsWith(" ") && !prefix.endsWith("\n") ? " " : "";
  const trailing = suffix && !suffix.startsWith(" ") && !suffix.startsWith("\n") ? " " : "";
  const inserted = `${separator}${text}${trailing}`;
  promptInput.value = `${prefix}${inserted}${suffix}`;
  const cursor = start + inserted.length;
  promptInput.selectionStart = cursor;
  promptInput.selectionEnd = cursor;
}

function createPendingMarker(label: "Image" | "Snippet"): string {
  return `[${label} ${nextPendingAttachmentId++}]`;
}

function removePendingMarker(marker: string): void {
  const index = promptInput.value.indexOf(marker);
  if (index === -1) return;

  let start = index;
  let end = index + marker.length;
  if (start > 0 && promptInput.value[start - 1] === " " && (end === promptInput.value.length || promptInput.value[end] === " ")) {
    start--;
  } else if (end < promptInput.value.length && promptInput.value[end] === " ") {
    end++;
  }

  resetPromptHistoryNavigation();
  promptInput.value = `${promptInput.value.slice(0, start)}${promptInput.value.slice(end)}`;
  updatePalette();
}

function expandSnippetTokens(text: string): string {
  let expanded = text;
  for (const snippet of pendingSnippets) {
    expanded = expanded.split(snippet.marker).join(`\n\n--- ${snippet.marker.slice(1, -1)} ---\n${snippet.text}\n---`);
  }
  return expanded;
}

function renderImagePreviews(): void {
  imagePreviews.replaceChildren();
  if (pendingImages.length === 0 && pendingSnippets.length === 0) {
    imagePreviews.hidden = true;
    return;
  }
  imagePreviews.hidden = false;
  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    const thumb = document.createElement("div");
    thumb.className = "image-thumb";

    const el = document.createElement("img");
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.alt = img.marker.slice(1, -1);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "\u00d7";
    remove.setAttribute("aria-label", "Remove image");
    remove.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      removePendingMarker(img.marker);
      renderImagePreviews();
    });

    thumb.append(el, remove);
    imagePreviews.append(thumb);
  }

  for (let i = 0; i < pendingSnippets.length; i++) {
    const snippet = pendingSnippets[i];
    const chip = document.createElement("div");
    chip.className = "snippet-chip";
    chip.textContent = `${snippet.marker} ${snippet.text.split(/\s+/).slice(0, 8).join(" ")}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "\u00d7";
    remove.setAttribute("aria-label", "Remove snippet");
    remove.addEventListener("click", () => {
      pendingSnippets.splice(i, 1);
      removePendingMarker(snippet.marker);
      renderImagePreviews();
    });
    chip.append(remove);
    imagePreviews.append(chip);
  }
}

// --- Model picker ---

function isModelPickerCommand(text: string): boolean {
  return /^\/models?(?:\s+(?:list|ls))?\s*$/i.test(text.trim());
}

function requireServerConfig(): ServerConfig | null {
  if (serverConfig) return serverConfig;
  appendLog("Cannot create a session before the bridge sends config; reconnect and try again.");
  return null;
}

function openCwdPicker(): void {
  const config = requireServerConfig();
  if (!config) return;
  cwdPickerNameInput.value = "";
  cwdPickerInput.value = config.defaultCwd;
  cwdPickerOverlay.hidden = false;
  window.setTimeout(() => cwdPickerNameInput.focus(), 0);
}

function closeCwdPicker(): void {
  cwdPickerOverlay.hidden = true;
  promptInput.focus();
}

function submitCwdPicker(): void {
  if (!requireServerConfig()) return;
  const name = cwdPickerNameInput.value.trim();
  const cwd = cwdPickerInput.value.trim();
  if (!name || !cwd) return;
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  send({ type: "session.create", name, cwd });
  closeCwdPicker();
}

function openForkPicker(): void {
  forkPickerNameInput.value = "";
  forkPickerOverlay.hidden = false;
  window.setTimeout(() => forkPickerNameInput.focus(), 0);
}

function closeForkPicker(): void {
  forkPickerOverlay.hidden = true;
  promptInput.focus();
}

function submitForkPicker(): void {
  if (!activeSessionId) return;
  const name = forkPickerNameInput.value.trim();
  if (!name) return;
  send({ type: "session.fork", sessionId: activeSessionId, name });
  closeForkPicker();
}

function openHandoffPicker(): void {
  handoffPickerNameInput.value = "";
  handoffPickerInstructions.value = "";
  handoffPickerOverlay.hidden = false;
  window.setTimeout(() => handoffPickerNameInput.focus(), 0);
}

function closeHandoffPicker(): void {
  handoffPickerOverlay.hidden = true;
  promptInput.focus();
}

function submitHandoffPicker(): void {
  if (!activeSessionId) return;
  const name = handoffPickerNameInput.value.trim();
  if (!name) return;
  const customInstructions = handoffPickerInstructions.value.trim() || undefined;
  send({ type: "session.handoff", sessionId: activeSessionId, name, customInstructions });
  closeHandoffPicker();
}

function openModelPicker(sessionId: string): void {
  modelPickerSessionId = sessionId;
  modelPickerModels = [];
  modelPickerSelectedIndex = 0;
  modelPickerLoading = true;
  modelPickerError = null;
  modelPickerSearch.value = "";
  modelPickerOverlay.hidden = false;
  renderModelPicker();
  send({ type: "model.list", sessionId });
  window.setTimeout(() => modelPickerSearch.focus(), 0);
}

function closeModelPicker(): void {
  modelPickerOverlay.hidden = true;
  modelPickerSessionId = null;
  modelPickerModels = [];
  modelPickerSelectedIndex = 0;
  modelPickerLoading = false;
  modelPickerError = null;
  promptInput.focus();
}

function filteredModelPickerModels(): ModelSummary[] {
  const query = normalizeModelQuery(modelPickerSearch.value);
  if (!query) return modelPickerModels;
  return modelPickerModels.filter(model => normalizeModelQuery(modelSearchText(model)).includes(query));
}

function normalizeModelQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function modelSearchText(model: ModelSummary): string {
  return [model.provider, model.id, model.name ?? ""].join(" ");
}

function handleModelPickerKeydown(event: KeyboardEvent): void {
  if (modelPickerOverlay.hidden) return;
  const models = filteredModelPickerModels();
  if (event.key === "Escape") {
    event.preventDefault();
    closeModelPicker();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (models.length > 0) {
      modelPickerSelectedIndex = Math.min(modelPickerSelectedIndex + 1, models.length - 1);
      renderModelPicker();
    }
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (models.length > 0) {
      modelPickerSelectedIndex = Math.max(modelPickerSelectedIndex - 1, 0);
      renderModelPicker();
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    selectCurrentModel();
  }
}

function selectCurrentModel(): void {
  const sessionId = modelPickerSessionId;
  if (!sessionId || modelPickerLoading) return;
  const model = filteredModelPickerModels()[modelPickerSelectedIndex];
  if (!model) return;
  modelPickerLoading = true;
  modelPickerError = null;
  renderModelPicker();
  send({ type: "model.set", sessionId, provider: model.provider, modelId: model.id });
}

function renderModelPicker(): void {
  const models = filteredModelPickerModels();
  if (modelPickerSelectedIndex >= models.length) {
    modelPickerSelectedIndex = Math.max(0, models.length - 1);
  }

  modelPickerList.replaceChildren();
  modelPickerSelect.disabled = modelPickerLoading || models.length === 0;
  modelPickerSearch.disabled = false;

  if (modelPickerError) {
    modelPickerStatus.textContent = modelPickerError;
    modelPickerStatus.className = "model-picker-status error";
  } else if (modelPickerLoading) {
    modelPickerStatus.textContent = modelPickerModels.length === 0 ? "Loading models…" : "Changing model…";
    modelPickerStatus.className = "model-picker-status";
  } else {
    modelPickerStatus.textContent = `${models.length} model${models.length === 1 ? "" : "s"}`;
    modelPickerStatus.className = "model-picker-status";
  }

  if (!modelPickerLoading && models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-picker-empty";
    empty.textContent = modelPickerSearch.value.trim() ? "No matching models." : "No models available for this session.";
    modelPickerList.append(empty);
    return;
  }

  const currentModel = modelPickerSessionId ? projections.get(modelPickerSessionId)?.model : null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const row = document.createElement("button");
    row.type = "button";
    row.disabled = modelPickerLoading;
    row.className = "model-picker-row";
    row.classList.toggle("selected", i === modelPickerSelectedIndex);
    row.classList.toggle("current", currentModel === model.id || currentModel === model.name || currentModel === formatModelSelector(model));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === modelPickerSelectedIndex));

    const title = document.createElement("span");
    title.className = "model-picker-row-title";
    title.textContent = formatModelSelector(model);

    const details = document.createElement("span");
    details.className = "model-picker-row-details";
    const detailParts = [model.name, formatModelContext(model), model.thinking ? "thinking" : null].filter(Boolean);
    details.textContent = detailParts.join(" · ");

    row.append(title, details);
    row.addEventListener("click", () => {
      modelPickerSelectedIndex = i;
      renderModelPicker();
    });
    row.addEventListener("dblclick", selectCurrentModel);
    modelPickerList.append(row);
  }
}

function formatModelSelector(model: ModelSummary): string {
  return `${model.provider}/${model.id}`;
}

function formatModelContext(model: ModelSummary): string | null {
  if (!model.contextWindow) return null;
  if (model.contextWindow >= 1_000_000) return `${(model.contextWindow / 1_000_000).toFixed(1)}M context`;
  if (model.contextWindow >= 1_000) return `${Math.round(model.contextWindow / 1_000)}K context`;
  return `${model.contextWindow} context`;
}

// --- Command palette ---

function updatePalette(): void {
  const text = promptInput.value;
  if (!text.startsWith("/") || text.includes(" ")) {
    hidePalette();
    return;
  }
  const query = text.slice(1);
  const matches = fuzzyMatchCommands(query).filter(cmd => cmd.support === "supported");
  if (matches.length === 0) {
    hidePalette();
    return;
  }
  paletteCommands = matches.slice(0, 10);
  paletteSelectedIndex = -1;
  renderPaletteItems();
  commandPalette.hidden = false;
}

function hidePalette(): void {
  commandPalette.hidden = true;
  paletteSelectedIndex = -1;
  paletteCommands = [];
}

function renderPaletteItems(): void {
  commandPalette.replaceChildren();
  for (let i = 0; i < paletteCommands.length; i++) {
    const cmd = paletteCommands[i];
    const item = document.createElement("div");
    item.className = "cmd-item";

    const nameEl = document.createElement("span");
    nameEl.className = "cmd-name";
    nameEl.textContent = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""}`;

    const descEl = document.createElement("span");
    descEl.className = "cmd-desc";
    descEl.textContent = cmd.description;

    item.append(nameEl, descEl);
    item.addEventListener("mousedown", e => {
      e.preventDefault();
      selectPaletteCommand(cmd);
    });
    commandPalette.append(item);
  }
}

function selectPaletteCommand(cmd: SlashCommandSpec): void {
  resetPromptHistoryNavigation();
  promptInput.value = `/${cmd.name} `;
  hidePalette();
  promptInput.focus();
}

function setPaletteSelected(index: number): void {
  const items = commandPalette.querySelectorAll<HTMLElement>(".cmd-item");
  paletteSelectedIndex = Math.max(-1, Math.min(index, items.length - 1));
  items.forEach((item, i) => item.classList.toggle("selected", i === paletteSelectedIndex));
  if (paletteSelectedIndex >= 0) {
    items[paletteSelectedIndex].scrollIntoView({ block: "nearest" });
  }
}

// --- Utilities ---

function send(message: ClientMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendLog("Not connected.");
    return;
  }
  socket.send(JSON.stringify(message));
}

function setStatus(label: string, className: string): void {
  connectionStatus.textContent = label;
  connectionStatus.className = `status ${className}`;
}

function appendLog(line: string): void {
  console.debug(`[fura] ${line}`);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function messageText(message: TranscriptMessage): string {
  return message.blocks
    .map(block => {
      if (block.kind === "text") return block.text;
      if (block.kind === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`#${id} missing`);
  }
  return element as T;
}
