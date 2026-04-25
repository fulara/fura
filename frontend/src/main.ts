import "./style.css";
import "highlight.js/styles/github-dark.css";
import hljs from "highlight.js/lib/common";
import { fuzzyMatchCommands, type SlashCommandSpec } from "./slashCommands";

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
  messages: TranscriptMessage[];
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
  | { type: "prompt.send"; sessionId: string; text: string; images?: unknown[] }
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
        <div class="prompt-field">
          <div id="commandPalette" class="command-palette" hidden></div>
          <div id="imagePreviews" class="image-previews" hidden></div>
          <textarea id="promptInput" rows="4" placeholder="Send a prompt…"></textarea>
        </div>
        <button type="submit">Send</button>
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

type PendingImage = { type: "image"; data: string; mimeType: string };
let pendingImages: PendingImage[] = [];

let socket: WebSocket | null = null;
let activeSessionId: string | null = null;
let sessions: SessionSummary[] = [];
let lastRenderedSessionId: string | null = null;
let paletteCommands: SlashCommandSpec[] = [];
let paletteSelectedIndex = -1;
const projections = new Map<string, SessionProjection>();

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
  const text = promptInput.value.trim();
  if ((!text && pendingImages.length === 0) || !activeSessionId) return;
  hidePalette();
  const msg: { type: "prompt.send"; sessionId: string; text: string; images?: PendingImage[] } = {
    type: "prompt.send",
    sessionId: activeSessionId,
    text,
  };
  if (pendingImages.length > 0) msg.images = pendingImages;
  send(msg);
  pendingImages = [];
  renderImagePreviews();
  promptInput.value = "";
});
promptInput.addEventListener("paste", async event => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItems = items.filter(item => item.type.startsWith("image/"));
  if (imageItems.length === 0) return; // let text paste proceed normally
  event.preventDefault();
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    try {
      const base64 = await blobToBase64(file);
      pendingImages.push({ type: "image", data: base64, mimeType: file.type });
    } catch {
      appendLog("Failed to read pasted image.");
    }
  }
  renderImagePreviews();
});
promptInput.addEventListener("input", () => updatePalette());
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
  if (commandPalette.hidden) return;
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
      }
      render();
      break;
    case "session.snapshot":
      projections.set(message.sessionId, message.state);
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
      break;
    case "raw.omp":
      appendLog(`[raw ${message.sessionId}] ${JSON.stringify(message.frame)}`);
      break;
    case "error":
      appendLog(`Error: ${message.message}`);
      break;
  }
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

  abortButton.disabled = !activeSessionId;
  stopButton.disabled = !activeSessionId;
  promptInput.disabled = !activeSessionId;

  if (!activeSessionId || !projection) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = "Create or attach to a session to begin.";
    promptInput.placeholder = "Select a session first";
    renderStatusBar(undefined);
    return;
  }

  sessionTitle.textContent = projection.summary.title || `Session ${shortId(activeSessionId)}`;
  sessionMeta.textContent = `${projection.summary.kind} · ${projection.summary.status} · ${projection.summary.cwd ?? "current bridge cwd"}`;
  promptInput.placeholder = "Send a prompt… (type / for commands)";
  renderStatusBar(projection);

  if (projection.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "Transcript is empty.";
    transcript.append(empty);
    return;
  }

  for (const message of projection.messages) {
    transcript.append(renderMessage(message));
  }

  // Restore manually-toggled thinking block open state from before the rebuild.
  // isNew-driven blocks are already open from renderBlock; this only overrides blocks
  // the user explicitly opened/closed that aren't covered by isNew.
  transcript.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
    const key = `${el.dataset.messageId}:${el.dataset.blockIndex}`;
    if (openThinking.has(key)) el.open = true;
  });

  // Scroll to bottom when switching sessions; during live updates, only if already near bottom.
  if (sessionChanged || wasNearBottom) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function renderStatusBar(projection?: SessionProjection): void {
  statusBar.replaceChildren();

  const parts: HTMLElement[] = [];
  parts.push(statusPart("π", "status-pi"));

  if (!projection) {
    parts.push(statusPart("No session", "muted"));
    statusBar.append(...interleaveStatusParts(parts));
    return;
  }

  const cwd = projection.summary.cwd ?? "current cwd";
  parts.push(statusPart(projection.model ?? "model unknown", "model"));
  parts.push(statusPart(projection.thinkingLevel ?? "thinking inherit", "thinking"));
  parts.push(statusPart(`\uD83D\uDCC1 ${shortPath(cwd)}`, "cwd"));
  parts.push(statusPart(formatTokens(projection.tokensTotal), "tokens"));
  parts.push(statusPart(formatCost(projection.costUsd), "cost"));
  if (projection.contextPercent != null && projection.contextWindow != null) {
    parts.push(statusPart(formatContext(projection.contextPercent, projection.contextWindow), "context"));
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

// --- Text segment parsing ---

type TextSegment =
  | { kind: "prose"; text: string }
  | { kind: "code"; lang: string; code: string };

const FENCE_RE = /^```(\w*)\n([\s\S]*?)^```[ \t]*$/gm;

function parseTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      segments.push({ kind: "prose", text: before.trim() });
    }
    segments.push({ kind: "code", lang: match[1] ?? "", code: match[2] });
    lastIndex = FENCE_RE.lastIndex;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) {
    segments.push({ kind: "prose", text: tail.trim() });
  }
  return segments.length > 0 ? segments : [{ kind: "prose", text }];
}

function renderProse(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "prose";
  // Split on blank lines into paragraphs; fall back to a single block.
  const paras = text.split(/\n{2,}/);
  for (const para of paras) {
    const p = document.createElement("p");
    p.textContent = para.trim();
    if (p.textContent) div.append(p);
  }
  return div;
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
    const segments = parseTextSegments(block.text);
    for (const segment of segments) {
      if (segment.kind === "prose") {
        wrapper.append(renderProse(segment.text));
      } else {
        wrapper.append(renderCodeBlock(segment.lang, segment.code));
      }
    }
    return wrapper;
  }

  if (block.kind === "thinking") {
    const details = document.createElement("details");
    details.className = "thinking-block";
    details.dataset.messageId = messageId;
    details.dataset.blockIndex = String(blockIndex);
    details.dataset.blockKind = "thinking";
    if (isNew) {
      details.open = true;
    }

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

function renderImagePreviews(): void {
  imagePreviews.replaceChildren();
  if (pendingImages.length === 0) {
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
    el.alt = "Attached image";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "\u00d7"; // ×
    remove.setAttribute("aria-label", "Remove image");
    remove.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });

    thumb.append(el, remove);
    imagePreviews.append(thumb);
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
