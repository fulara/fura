import "./style.css";
import "highlight.js/styles/github-dark.css";
import hljs from "highlight.js/lib/common";
import { marked, type Token, type Tokens } from "marked";
import { findSlashCommand, fuzzyMatchCommands, type SlashCommandSpec } from "./slashCommands";

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
};

type ServerMessage =
  | { type: "hello"; serverVersion: string; protocolVersion: number }
  | { type: "sessions.snapshot"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; sessionId: string; state: SessionProjection }
  | { type: "session.exited"; sessionId: string; code?: number; signal?: string }
  | { type: "dialog.request"; sessionId: string; dialog: unknown }
  | { type: "log.stderr"; sessionId: string; text: string }
  | { type: "session.notice"; sessionId: string; level: "info" | "warning" | "error"; text: string }
  | { type: "raw.omp"; sessionId: string; frame: unknown }
  | { type: "error"; requestId?: string | null; message: string };

type ClientMessage =
  | { type: "session.create"; cwd?: string; args?: string[] }
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
  | { type: "raw.rpc"; sessionId: string; command: unknown };

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
          <button id="abortButton" type="button">Abort</button>
          <button id="stopButton" type="button">Stop</button>
        </div>
      </header>

      <section id="transcript" class="transcript" aria-live="polite"></section>

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
`;

const connectionStatus = requireElement<HTMLSpanElement>("connectionStatus");
const tokenInput = requireElement<HTMLInputElement>("tokenInput");
const connectButton = requireElement<HTMLButtonElement>("connectButton");
const createSessionButton = requireElement<HTMLButtonElement>("createSessionButton");
const refreshSessionsButton = requireElement<HTMLButtonElement>("refreshSessionsButton");
const sessionsList = requireElement<HTMLElement>("sessionsList");
const sessionTitle = requireElement<HTMLHeadingElement>("sessionTitle");
const sessionMeta = requireElement<HTMLParagraphElement>("sessionMeta");
const transcript = requireElement<HTMLElement>("transcript");
const statusBar = requireElement<HTMLDivElement>("statusBar");
const promptForm = requireElement<HTMLFormElement>("promptForm");
const promptInput = requireElement<HTMLTextAreaElement>("promptInput");
const abortButton = requireElement<HTMLButtonElement>("abortButton");
const stopButton = requireElement<HTMLButtonElement>("stopButton");
const commandPalette = requireElement<HTMLDivElement>("commandPalette");
const imagePreviews = requireElement<HTMLDivElement>("imagePreviews");
const busyPromptChoice = requireElement<HTMLDivElement>("busyPromptChoice");
const sendButton = requireElement<HTMLButtonElement>("sendButton");

type PendingImage = { type: "image"; marker: string; data: string; mimeType: string };
type PendingSnippet = { type: "snippet"; marker: string; text: string };
type BusyPromptDraft = {
  sessionId: string;
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets: PendingSnippet[];
};
let pendingImages: PendingImage[] = [];
let pendingSnippets: PendingSnippet[] = [];
let nextPendingAttachmentId = 1;

let socket: WebSocket | null = null;
let activeSessionId: string | null = null;
let sessions: SessionSummary[] = [];
let lastRenderedSessionId: string | null = null;
let paletteCommands: SlashCommandSpec[] = [];
let paletteSelectedIndex = -1;
const projections = new Map<string, SessionProjection>();
const sessionNotices = new Map<string, Array<{ level: string; text: string }>>();
let busyPromptDraft: BusyPromptDraft | null = null;
const PROMPT_HISTORY_LIMIT = 100;
const promptHistories = new Map<string, string[]>();
const promptHistoryMessageIds = new Map<string, Set<string>>();
let promptHistoryIndex = -1;

const url = new URL(window.location.href);
const initialToken = url.searchParams.get("token") ?? window.localStorage.getItem("fura.token") ?? "";
tokenInput.value = initialToken;

connectButton.addEventListener("click", connect);
createSessionButton.addEventListener("click", () => send({ type: "session.create" }));
refreshSessionsButton.addEventListener("click", () => send({ type: "session.list" }));
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
promptForm.addEventListener("submit", event => {
  event.preventDefault();
  const editorText = promptInput.value.trim();
  const text = expandSnippetTokens(editorText);
  if ((!text && pendingImages.length === 0) || !activeSessionId) return;
  hidePalette();

  const projection = projections.get(activeSessionId);
  const isSlashCommandLike = /^\/[^\s:]+/.test(editorText);
  const knownSlashCommand = findSlashCommand(editorText);
  if (projection?.isBusy) {
    if (knownSlashCommand && pendingImages.length === 0) {
      sendPromptMessage(activeSessionId, text, pendingImages);
      clearPromptEditor();
      return;
    }
    if (isSlashCommandLike) {
      const notices = sessionNotices.get(activeSessionId) ?? [];
      notices.push({
        level: "warning",
        text: "Slash commands cannot be sent as steer or follow-up prompts while the agent is busy.",
      });
      sessionNotices.set(activeSessionId, notices);
      render();
      return;
    }
    busyPromptDraft = {
      sessionId: activeSessionId,
      text,
      editorText,
      images: pendingImages.map(image => ({ ...image })),
      snippets: pendingSnippets.map(snippet => ({ ...snippet })),
    };
    clearPromptEditor();
    renderBusyPromptChoice();
    return;
  }

  sendPromptMessage(activeSessionId, text, pendingImages);
  clearPromptEditor();
});
promptInput.addEventListener("paste", async event => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItems = items.filter(item => item.type.startsWith("image/"));
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  const shouldCaptureSnippet = imageItems.length === 0 && pastedText.length > 500;
  if (imageItems.length === 0 && !shouldCaptureSnippet) return; // let normal short text paste proceed
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
  // Delay so mousedown on a palette item fires before blur hides the palette.
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

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "hello":
      appendLog(`Connected to fura ${message.serverVersion} protocol ${message.protocolVersion}`);
      break;
    case "sessions.snapshot":
      sessions = message.sessions;
      if (activeSessionId && !sessions.some(session => session.sessionId === activeSessionId)) {
        activeSessionId = null;
        resetPromptHistoryNavigation();
      }
      render();
      break;
    case "session.snapshot":
      projections.set(message.sessionId, message.state);
      syncPromptHistoryFromProjection(message.sessionId, message.state);
      if (activeSessionId !== message.sessionId) resetPromptHistoryNavigation();
      activeSessionId = message.sessionId;
      render();
      break;
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
      break;
    case "raw.omp":
      appendLog(`[raw ${message.sessionId}] ${JSON.stringify(message.frame)}`);
      break;
    case "error":
      appendLog(`Error: ${message.message}`);
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
  busyPromptDraft = null;
  renderBusyPromptChoice();
  render();
}

function render(): void {
  renderSessions();
  renderActiveSession();
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
    button.className = session.sessionId === activeSessionId ? "session active" : "session";
    button.addEventListener("click", () => {
      if (activeSessionId !== session.sessionId) resetPromptHistoryNavigation();
      activeSessionId = session.sessionId;
      if (session.kind === "available" && session.sessionFile) {
        send({ type: "session.open", sessionFile: session.sessionFile });
      } else {
        send({ type: "session.attach", sessionId: session.sessionId });
      }
      render();
    });

    const title = document.createElement("span");
    title.className = "session-id";
    title.textContent = session.title || shortId(session.sessionId);

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.kind} \u00b7 ${session.status} \u00b7 ${session.messageCount} messages`;

    button.append(title, meta);

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

function renderActiveSession(): void {
  const sessionChanged = activeSessionId !== lastRenderedSessionId;
  lastRenderedSessionId = activeSessionId;

  // Snapshot scroll position and open thinking-block state before clearing,
  // so we can restore both after the DOM rebuild.
  const wasNearBottom =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  const openThinking = new Set<string>();
  transcript.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
    if (el.open) openThinking.add(`${el.dataset.messageId}:${el.dataset.blockIndex}`);
  });

  transcript.replaceChildren();
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
    renderStatusBar(undefined);
    renderBusyPromptChoice();
    return;
  }

  sessionTitle.textContent = projection.summary.title || `Session ${shortId(activeSessionId)}`;
  sessionMeta.textContent = `${projection.summary.kind} · ${projection.summary.status} · ${projection.summary.cwd ?? "current bridge cwd"}`;
  promptInput.placeholder = "Send a prompt… (type / for commands)";
  renderStatusBar(projection);
  renderBusyPromptChoice();

  if (projection.transcript.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "Transcript is empty.";
    transcript.append(empty);
    return;
  }

  for (let i = 0; i < projection.transcript.length; i++) {
    const entry = projection.transcript[i];
    if (entry.kind === "message") {
      transcript.append(renderMessage(entry));
      continue;
    }

    if (isCompactReadCard(entry)) {
      const readCards = [entry];
      while (isCompactReadCard(projection.transcript[i + 1])) {
        readCards.push(projection.transcript[++i] as { kind: "tool" } & ToolCard);
      }
      transcript.append(readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards));
      continue;
    }

    transcript.append(renderToolCard(entry));
  }

  // Restore manually-toggled thinking block open state from before the rebuild.
  // isNew-driven blocks are already open from renderBlock; this only overrides blocks
  // the user explicitly opened/closed that aren't covered by isNew.
  transcript.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
    const key = `${el.dataset.messageId}:${el.dataset.blockIndex}`;
    if (openThinking.has(key)) el.open = true;
  });

  // Scroll to bottom when switching sessions; during live updates, only if already near bottom.
  const pending = activeSessionId ? (sessionNotices.get(activeSessionId) ?? []) : [];
  for (const notice of pending) {
    const bar = document.createElement("div");
    bar.className = `session-notice notice-${notice.level}`;
    bar.textContent = notice.text;
    transcript.append(bar);
  }

  if (sessionChanged || wasNearBottom) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

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

function formatContext(percent: number, window: number): string {
  const pct = percent < 1 ? percent.toFixed(2) : percent.toFixed(1);
  const win = window >= 1_000_000 ? `${(window / 1_000_000).toFixed(1)}M`
    : window >= 1_000 ? `${Math.round(window / 1_000)}K`
    : `${window}`;
  return `${pct}%/${win}`;
}


function renderMessage(message: TranscriptMessage): HTMLElement {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id;

  // System-role messages (bash/python executions) carry no header — the fenced code
  // block header already labels the content type. All other roles get a header row.
  if (message.role !== "system") {
    const header = document.createElement("header");
    const roleLabel = document.createElement("strong");
    roleLabel.textContent = message.role === "user" ? "You" : message.role;
    const copy = document.createElement("button");
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

  for (let i = 0; i < message.blocks.length; i++) {
    article.append(renderBlock(message.blocks[i], message.isNew, message.id, i));
  }

  return article;
}

function renderToolCard(card: ToolCard): HTMLElement {
  if (card.toolName === "todo_write") return renderTodoWriteCard(card);
  if (card.toolName === "task") return renderTaskCard(card);
  if (card.toolName === "read") return renderReadToolCard(card);
  if (card.toolName === "grep") return renderGrepToolCard(card);
  const wrapper = document.createElement("section");
  wrapper.className = `tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = card.toolName;

  const header = document.createElement("div");
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
  const wrapper = document.createElement("section");
  wrapper.className = `tool-card read-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${card.isError ? "" : "tool-compact"}`;
  wrapper.dataset.toolName = "read";

  const header = document.createElement("div");
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
  const wrapper = document.createElement("section");
  const isActive = cards.some(card => card.isActive);
  wrapper.className = `tool-card read-tool-card read-tool-group ${isActive ? "tool-active" : ""} tool-compact`;
  wrapper.dataset.toolName = "read";

  const header = document.createElement("div");
  header.className = "tool-header read-tool-header";
  header.append(
    toolStatusIcon({ ...cards[0], isActive }),
    toolHeaderText("Read", "tool-name"),
    toolHeaderText(`(${cards.length})`, "tool-count"),
  );
  wrapper.append(header);

  const list = document.createElement("div");
  list.className = "read-tool-list";
  cards.forEach((card, index) => {
    const row = document.createElement("div");
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
  const wrapper = document.createElement("section");
  wrapper.className = `tool-card grep-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${card.isError ? "" : "tool-compact"}`;
  wrapper.dataset.toolName = "grep";

  const header = document.createElement("div");
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
    const row = document.createElement("div");
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
  const body = document.createElement("div");
  body.className = "tool-result-body";
  const pre = document.createElement("pre");
  pre.className = "tool-result-text";
  pre.textContent = truncate(resultText, 8000);
  body.append(pre);
  wrapper.append(body);
}

function renderTodoWriteCard(card: ToolCard): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = `tool-card todo-write-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "todo_write";

  const header = document.createElement("div");
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
    const tree = document.createElement("div");
    tree.className = "todo-tree";
    for (const phase of phases) tree.append(renderTodoPhase(phase, phases.length > 1));
    wrapper.append(tree);
  } else {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
  }

  return wrapper;
}

function renderTodoPhase(phase: TodoPhase, showPhaseName: boolean): HTMLElement {
  const section = document.createElement("section");
  section.className = "todo-phase";

  if (showPhaseName) {
    const title = document.createElement("div");
    title.className = "todo-phase-title";
    title.textContent = `└─ ${phase.name}`;
    section.append(title);
  }

  const list = document.createElement("div");
  list.className = "todo-task-list";
  phase.tasks.forEach((todo, index) => {
    list.append(renderTodoItem(todo, index === 0));
  });
  section.append(list);
  return section;
}

function renderTodoItem(todo: TodoItem, firstInPhase: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = `todo-task todo-${todo.status}`;

  const prefix = document.createElement("span");
  prefix.className = "todo-prefix";
  prefix.textContent = firstInPhase ? "└─" : "  ";

  const icon = document.createElement("span");
  icon.className = "todo-icon";
  icon.textContent = todo.status === "completed" ? "☑" : "☐";

  const content = document.createElement("span");
  content.className = "todo-content";
  content.textContent = todo.content;

  row.append(prefix, icon, content);

  if (todo.status === "in_progress" && todo.details) {
    for (const line of todo.details.split("\n")) {
      const details = document.createElement("div");
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
  const wrapper = document.createElement("section");
  wrapper.className = `tool-card task-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "task";

  const header = document.createElement("div");
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
    const list = document.createElement("div");
    list.className = "task-progress";
    for (const agent of progress) list.append(renderTaskAgent(agent));
    wrapper.append(list);
  } else if (results.length > 0) {
    const list = document.createElement("div");
    list.className = "task-progress task-results";
    for (let i = 0; i < results.length; i++) list.append(renderTaskResult(results[i], i === results.length - 1));
    wrapper.append(list);
  } else {
    appendToolResultBody(wrapper, toolResultText(source));
  }

  const totals = shouldRenderProgress ? taskProgressTotals(progress) : taskResultTotals(results, source);
  if (totals) {
    const total = document.createElement("div");
    total.className = "task-total";
    total.textContent = totals;
    wrapper.append(total);
  }

  return wrapper;
}

function renderTaskAgent(agent: AgentProgress): HTMLElement {
  const row = document.createElement("div");
  row.className = `task-agent status-${agent.status}`;

  const main = document.createElement("div");
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
    const activity = document.createElement("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${agent.lastIntent ?? `${agent.currentTool} ${agent.currentToolArgs ?? ""}`}`;
    row.append(activity);
  }

  return row;
}

function renderTaskResult(result: TaskResult, isLast: boolean): HTMLElement {
  const resultStatus = taskResultStatus(result);
  const row = document.createElement("div");
  row.className = `task-agent task-result status-${resultStatus} ${isLast ? "task-last" : ""}`;

  const main = document.createElement("div");
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
    const activity = document.createElement("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${activityText}`;
    row.append(activity);
  }

  const outputLines = taskOutputPreview(result.output);
  if (outputLines.length > 0) {
    const output = document.createElement("pre");
    output.className = "task-result-output";
    output.textContent = outputLines.join("\n");
    row.append(output);
  }

  const artifactPath = result.patchPath ?? result.branchName ?? result.outputPath;
  if (artifactPath) {
    const path = document.createElement("div");
    path.className = "task-result-path";
    path.textContent = `${result.patchPath ? "Patch" : result.branchName ? "Branch" : "Output"}: ${artifactPath}`;
    row.append(path);
  }

  return row;
}

function toolStatusIcon(card: ToolCard): HTMLElement {
  const span = document.createElement("span");
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
  const span = document.createElement("span");
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
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-body";

  const tokens = marked.lexer(text.trim());
  for (const token of tokens) {
    const node = renderMarkdownToken(token);
    if (node) wrapper.append(node);
  }

  if (!wrapper.hasChildNodes() && text.trim()) {
    const p = document.createElement("p");
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
      return document.createElement("hr");
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
  const heading = document.createElement(`h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
  heading.append(renderInlineTokens(token.tokens));
  return heading;
}

function renderParagraph(tokens: Token[]): HTMLParagraphElement {
  const p = document.createElement("p");
  p.append(renderInlineTokens(tokens));
  return p;
}

function renderPlainParagraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function renderList(token: Tokens.List): HTMLOListElement | HTMLUListElement {
  if (token.ordered) {
    const list = document.createElement("ol");
    if (typeof token.start === "number" && token.start !== 1) {
      list.start = token.start;
    }
    for (const item of token.items) {
      list.append(renderListItem(item));
    }
    return list;
  }

  const list = document.createElement("ul");
  for (const item of token.items) {
    list.append(renderListItem(item));
  }
  return list;
}

function renderListItem(item: Tokens.ListItem): HTMLLIElement {
  const li = document.createElement("li");
  if (item.task) {
    const checkbox = document.createElement("input");
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
  const quote = document.createElement("blockquote");
  for (const child of token.tokens) {
    const node = renderMarkdownToken(child);
    if (node) quote.append(node);
  }
  return quote;
}

function renderTable(token: Tokens.Table): HTMLTableElement {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  token.header.forEach((cell, index) => {
    const th = document.createElement("th");
    setTableCellAlignment(th, token.align[index]);
    th.append(renderInlineTokens(cell.tokens));
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of token.rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, index) => {
      const td = document.createElement("td");
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
  const fragment = document.createDocumentFragment();
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
      return document.createTextNode(text.text);
    }
    case "strong":
      return wrapInline("strong", (token as Tokens.Strong).tokens ?? []);
    case "em":
      return wrapInline("em", (token as Tokens.Em).tokens ?? []);
    case "del":
      return wrapInline("del", (token as Tokens.Del).tokens ?? []);
    case "codespan": {
      const code = document.createElement("code");
      code.textContent = (token as Tokens.Codespan).text;
      return code;
    }
    case "link":
      return renderLink(token as Tokens.Link);
    case "br":
      return document.createElement("br");
    case "html":
      return document.createTextNode(token.raw);
    default:
      return document.createTextNode(tokenText(token));
  }
}

function wrapInline(tagName: "strong" | "em" | "del", tokens: Token[]): HTMLElement {
  const el = document.createElement(tagName);
  el.append(renderInlineTokens(tokens));
  return el;
}

function renderLink(token: Tokens.Link): HTMLElement {
  const href = safeHref(token.href);
  const el = href ? document.createElement("a") : document.createElement("span");
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
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";

  const header = document.createElement("div");
  header.className = "code-block-header";

  const langLabel = document.createElement("span");
  langLabel.className = "code-lang";
  langLabel.textContent = lang || "text";

  const copyBtn = document.createElement("button");
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

  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
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
    const wrapper = document.createElement("div");
    wrapper.className = "text-block";
    wrapper.dataset.messageId = messageId;
    wrapper.dataset.blockIndex = String(blockIndex);
    wrapper.dataset.blockKind = "text";
    wrapper.append(renderMarkdown(block.text));
    return wrapper;
  }

  if (block.kind === "thinking") {
    const details = document.createElement("details");
    details.className = "thinking-block";
    details.dataset.messageId = messageId;
    details.dataset.blockIndex = String(blockIndex);
    details.dataset.blockKind = "thinking";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "thinking-label";
    summary.textContent = "Thinking\u2026";
    details.append(summary);

    const pre = document.createElement("pre");
    pre.className = "thinking-content";
    pre.textContent = block.thinking;
    details.append(pre);

    return details;
  }

  // redactedthinking — show static label, no data
  const span = document.createElement("p");
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
    remove.textContent = "\u00d7"; // ×
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


// --- Command palette ---

function updatePalette(): void {
  const text = promptInput.value;
  // Show only when text starts with / and no space yet (still typing the command name).
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
      e.preventDefault(); // keep focus on textarea
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
