import "./style.css";
import "./mobile.css";
import "highlight.js/styles/github-dark.css";
import { createFuraConnection, type FuraConnection } from "./connection";
import { setRenderDocument } from "./dom";
import { shortId } from "./format";
import type { ClientMessage, ServerConfig, ServerMessage, SessionProjection, SessionSummary, TodoPhase } from "./protocol";
import { sessionKindLabel, sessionStatusLabel } from "./sessionList";
import { createSessionListView } from "./sessionListView";
import { renderCurrentTodoCard, renderToolCard } from "./toolCards";
import { renderMessage } from "./transcriptView";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <main class="mobile-shell">
    <header class="mobile-topbar">
      <div class="mobile-brand-row">
        <div class="mobile-brand">
          <h1>Fura</h1>
          <p>Mobile session shell</p>
        </div>
        <span id="mobileConnectionStatus" class="status disconnected">disconnected</span>
      </div>
      <div class="mobile-session-row">
        <div class="mobile-session-heading">
          <h2 id="mobileSessionTitle">No session selected</h2>
          <p id="mobileSessionMeta">Choose a session to view its transcript.</p>
        </div>
        <button id="mobileSessionsToggle" class="mobile-sessions-toggle" type="button" aria-expanded="false" aria-controls="mobileSessionsDrawer">Sessions</button>
      </div>
      <p id="mobileLog" class="mobile-log" aria-live="polite"></p>
      <section id="mobileSessionsDrawer" class="mobile-session-drawer" hidden>
        <nav id="mobileSessionsList" class="sessions" aria-label="Sessions"></nav>
      </section>
    </header>

    <section class="mobile-main" aria-label="Active session transcript">
      <div id="mobileTranscript" class="mobile-transcript"></div>
    </section>

    <form id="mobilePromptForm" class="mobile-composer">
      <textarea id="mobilePromptInput" rows="3" placeholder="Select a session first"></textarea>
      <div class="mobile-composer-actions">
        <span id="mobileComposerStatus" class="mobile-composer-status">No active session</span>
        <button id="mobileSendButton" type="submit">Send</button>
      </div>
    </form>
  </main>
`;

const connectionStatus = requireElement<HTMLSpanElement>("mobileConnectionStatus");
const sessionTitle = requireElement<HTMLHeadingElement>("mobileSessionTitle");
const sessionMeta = requireElement<HTMLParagraphElement>("mobileSessionMeta");
const sessionsToggle = requireElement<HTMLButtonElement>("mobileSessionsToggle");
const sessionsDrawer = requireElement<HTMLElement>("mobileSessionsDrawer");
const sessionsList = requireElement<HTMLElement>("mobileSessionsList");
const transcript = requireElement<HTMLDivElement>("mobileTranscript");
const promptForm = requireElement<HTMLFormElement>("mobilePromptForm");
const promptInput = requireElement<HTMLTextAreaElement>("mobilePromptInput");
const sendButton = requireElement<HTMLButtonElement>("mobileSendButton");
const composerStatus = requireElement<HTMLSpanElement>("mobileComposerStatus");
const mobileLog = requireElement<HTMLParagraphElement>("mobileLog");

let connection: FuraConnection | null = null;
let serverConfig: ServerConfig | null = null;
let sessions: SessionSummary[] = [];
let activeSessionId: string | null = null;
const projections = new Map<string, SessionProjection>();
const unreadSessions = new Set<string>();

const sessionListView = createSessionListView(sessionsList, {
  onSelectSession: selectSession,
  onDeleteSession: () => undefined,
});

sessionsToggle.addEventListener("click", () => {
  const open = sessionsDrawer.hidden;
  sessionsDrawer.hidden = !open;
  sessionsToggle.setAttribute("aria-expanded", String(open));
});

promptForm.addEventListener("submit", event => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text || !activeSessionId) return;
  const accepted = send({ type: "prompt.send", sessionId: activeSessionId, text });
  if (accepted) promptInput.value = "";
});

const initialToken = consumeBootstrapToken();
render();
if (initialToken) connect(initialToken);
else appendLog("No bridge token found. Open mobile.html with ?token=<token> from the Rust server URL.");

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  return element as T;
}

function consumeBootstrapToken(): string {
  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get("token")?.trim() ?? "";
  const storedToken = window.localStorage.getItem("fura.token")?.trim() ?? "";
  if (urlToken) {
    window.localStorage.setItem("fura.token", urlToken);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return urlToken || storedToken;
}

function connect(token: string): void {
  const bridgeToken = token.trim();
  if (!bridgeToken) return;
  window.localStorage.setItem("fura.token", bridgeToken);
  connection?.disconnect();
  connection = createFuraConnection({
    auth: { type: "sessionCookie", token: bridgeToken },
    onStatus: setStatus,
    onOpen: () => send({ type: "session.list" }),
    onMessage: handleServerMessage,
    onLog: appendLog,
  });
  connection.connect();
}

function setStatus(label: string, className: string): void {
  connectionStatus.textContent = label;
  connectionStatus.className = `status ${className}`;
}

function appendLog(message: string): void {
  mobileLog.textContent = message;
  console.debug(`[fura-mobile] ${message}`);
}

function send(message: ClientMessage): boolean {
  if (!connection) {
    appendLog("Not connected.");
    return false;
  }
  return connection.send(message);
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "hello":
      serverConfig = message.config;
      appendLog(`Connected to fura ${message.serverVersion}.`);
      break;
    case "config.updated":
      serverConfig = message.config;
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
      mergeSessionSummary(message.state.summary);
      if (!activeSessionId || activeSessionId === message.sessionId) {
        activateSession(message.sessionId);
        render();
      } else {
        unreadSessions.add(message.sessionId);
        renderSessions();
      }
      break;
    case "session.exited":
      appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
      render();
      break;
    case "session.notice":
      appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
      break;
    case "prompt.busy":
      appendLog("Session is busy. Mobile shell does not support steer/follow-up yet.");
      break;
    case "log.stderr":
      appendLog(`[${message.sessionId}] ${message.text}`);
      break;
    case "error":
      appendLog(`Error: ${message.message}`);
      break;
    case "dialog.request":
    case "model.list":
    case "model.changed":
    case "plan.review":
    case "raw.omp":
    case "diff.state":
    case "control.reply":
    case "control.status":
    case "frontend.control":
    case "voice.status":
    case "voice.delta":
    case "voice.final":
    case "voice.error":
      break;
  }
}

function mergeSessionSummary(summary: SessionSummary): void {
  const index = sessions.findIndex(session => session.sessionId === summary.sessionId);
  if (index === -1) {
    sessions = [summary, ...sessions];
    return;
  }
  sessions = sessions.map(session => session.sessionId === summary.sessionId ? summary : session);
}

function selectSession(sessionId: string): void {
  const session = sessions.find(candidate => candidate.sessionId === sessionId);
  if (!session) return;
  activateSession(sessionId);
  sessionsDrawer.hidden = true;
  sessionsToggle.setAttribute("aria-expanded", "false");
  if (session.kind === "available" && session.sessionFile) {
    send({ type: "session.open", sessionFile: session.sessionFile });
  } else {
    send({ type: "session.attach", sessionId });
  }
  render();
}

function activateSession(sessionId: string): void {
  activeSessionId = sessionId;
  unreadSessions.delete(sessionId);
}

function render(): void {
  renderSessions();
  renderActiveSession();
}

function renderSessions(): void {
  sessionListView.render({
    sessions,
    visibleSessions: sessions,
    selectedCategoryFilter: "",
    activeSessionId,
    unreadSessionIds: unreadSessions,
  });
}

function renderActiveSession(): void {
  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  const summary = projection?.summary ?? sessions.find(session => session.sessionId === activeSessionId);
  if (!activeSessionId || !summary) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = serverConfig ? "Choose a session to view its transcript." : "Waiting for bridge connection.";
    promptInput.disabled = true;
    sendButton.disabled = true;
    promptInput.placeholder = "Select a session first";
    composerStatus.textContent = "No active session";
    renderTranscript(undefined);
    return;
  }

  const isBusy = projection?.isBusy ?? summary.status === "busy";
  sessionTitle.textContent = summary.title || `Session ${shortId(summary.sessionId)}`;
  sessionMeta.textContent = `${sessionKindLabel(summary.kind)} · ${sessionStatusLabel(summary)} · ${summary.cwd ?? "no dir"}`;
  promptInput.disabled = !projection || isBusy;
  sendButton.disabled = !projection || isBusy;
  promptInput.placeholder = isBusy ? "Agent is busy…" : "Send a prompt…";
  composerStatus.textContent = isBusy ? "Agent busy" : "Ready";
  renderTranscript(projection);
}

function renderTranscript(projection: SessionProjection | undefined): void {
  setRenderDocument(transcript.ownerDocument);
  const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;

  if (!projection) {
    const empty = transcript.ownerDocument.createElement("p");
    empty.className = "mobile-empty-state";
    empty.textContent = "Select a session to load its transcript.";
    transcript.replaceChildren(empty);
    return;
  }

  const fragment = transcript.ownerDocument.createDocumentFragment();
  for (const entry of projection.transcript) {
    if (entry.kind === "message") {
      fragment.append(renderMessage(entry, { thinkingVisibilityMode: "auto" }));
    } else {
      fragment.append(renderToolCard(entry));
    }
  }

  for (const phaseCard of renderTodoCards(projection.todoPhases ?? [])) {
    fragment.append(phaseCard);
  }

  if (!fragment.hasChildNodes()) {
    const empty = transcript.ownerDocument.createElement("p");
    empty.className = "mobile-empty-state";
    empty.textContent = "Transcript is empty.";
    fragment.append(empty);
  }

  transcript.replaceChildren(fragment);
  if (wasNearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderTodoCards(phases: TodoPhase[]): HTMLElement[] {
  const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
  return nonEmpty.length > 0 ? [renderCurrentTodoCard(nonEmpty)] : [];
}
