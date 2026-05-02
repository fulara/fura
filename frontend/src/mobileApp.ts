import { consumeBootstrapToken, storeBootstrapToken } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection, WebSocketAuth } from "./connection";
import { setRenderDocument } from "./dom";
import { diffRepoRoots, formatDiffRepoLabel } from "./diffState";
import { shortId } from "./format";
import type { ClientMessage, RepoDiffState, ServerConfig, ServerMessage, SessionProjection, SessionSummary, TodoPhase } from "./protocol";
import { sessionKindLabel, sessionStatusLabel } from "./sessionList";
import { activateSession as activateSessionState, applySessionSnapshot, applySessionsSnapshot, sessionOpenOrAttachMessage } from "./sessionClientState";
import { createSessionListView } from "./sessionListView";
import { renderCurrentTodoCard, renderToolCard } from "./toolCards";
import { renderMessage } from "./transcriptView";

type MobileWindow = Pick<Window, "history" | "localStorage" | "location" | "setTimeout">;

export type MobileConnectionOptions = {
  auth: WebSocketAuth;
  onStatus(status: ConnectionStatus, label: string): void;
  onOpen?(): void;
  onClose?(): void;
  onMessage(message: ServerMessage): void;
  onLog(message: string): void;
};

export type MobileConnectionFactory = (options: MobileConnectionOptions) => FuraConnection;

export type MobileAppOptions = {
  document: Document;
  window: MobileWindow;
  createConnection: MobileConnectionFactory;
};

export type MobileAppHandle = {
  send(message: ClientMessage): boolean;
  connect(token: string): void;
};

export function mountMobileApp(options: MobileAppOptions): MobileAppHandle {
  const { document, window, createConnection } = options;
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
          <div class="mobile-header-actions">
            <button id="mobileCreateToggle" class="mobile-create-toggle" type="button" aria-expanded="false" aria-controls="mobileCreateDrawer">New</button>
            <button id="mobileSessionsToggle" class="mobile-sessions-toggle" type="button" aria-expanded="false" aria-controls="mobileSessionsDrawer">Sessions</button>
          </div>
        </div>
        <p id="mobileLog" class="mobile-log" aria-live="polite"></p>
        <section id="mobileSessionsDrawer" class="mobile-session-drawer" hidden>
          <nav id="mobileSessionsList" class="sessions" aria-label="Sessions"></nav>
        </section>
        <section id="mobileCreateDrawer" class="mobile-create-drawer" hidden>
          <form id="mobileCreateForm" class="mobile-create-form">
            <label for="mobileCreateName">Session name <span class="mobile-optional-label">optional</span></label>
            <input id="mobileCreateName" autocomplete="off" spellcheck="false" placeholder="my-session" />
            <label for="mobileCreateCwd">Working directory</label>
            <input id="mobileCreateCwd" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
            <p id="mobileCreateStatus" class="mobile-create-status" aria-live="polite"></p>
            <div class="mobile-create-actions">
              <button id="mobileCreateClose" type="button">Close</button>
              <button id="mobileCreateSubmit" type="submit">Create</button>
            </div>
          </form>
        </section>
      </header>

      <section class="mobile-main" aria-label="Active session workspace">
        <nav class="mobile-workspace-tabs" aria-label="Mobile workspace views">
          <button id="mobileTranscriptTab" type="button" class="mobile-workspace-tab active" aria-pressed="true">Transcript</button>
          <button id="mobileDiffTab" type="button" class="mobile-workspace-tab" aria-pressed="false">Diff</button>
        </nav>
        <div id="mobileTranscript" class="mobile-transcript"></div>
        <div id="mobileDiff" class="mobile-diff" hidden></div>
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

  const connectionStatus = requireElement<HTMLSpanElement>(document, "mobileConnectionStatus");
  const sessionTitle = requireElement<HTMLHeadingElement>(document, "mobileSessionTitle");
  const sessionMeta = requireElement<HTMLParagraphElement>(document, "mobileSessionMeta");
  const createToggle = requireElement<HTMLButtonElement>(document, "mobileCreateToggle");
  const sessionsToggle = requireElement<HTMLButtonElement>(document, "mobileSessionsToggle");
  const sessionsDrawer = requireElement<HTMLElement>(document, "mobileSessionsDrawer");
  const sessionsList = requireElement<HTMLElement>(document, "mobileSessionsList");
  const createDrawer = requireElement<HTMLElement>(document, "mobileCreateDrawer");
  const createForm = requireElement<HTMLFormElement>(document, "mobileCreateForm");
  const createNameInput = requireElement<HTMLInputElement>(document, "mobileCreateName");
  const createCwdInput = requireElement<HTMLInputElement>(document, "mobileCreateCwd");
  const createStatus = requireElement<HTMLParagraphElement>(document, "mobileCreateStatus");
  const createClose = requireElement<HTMLButtonElement>(document, "mobileCreateClose");
  const createSubmit = requireElement<HTMLButtonElement>(document, "mobileCreateSubmit");
  const transcriptTab = requireElement<HTMLButtonElement>(document, "mobileTranscriptTab");
  const diffTab = requireElement<HTMLButtonElement>(document, "mobileDiffTab");
  const transcript = requireElement<HTMLDivElement>(document, "mobileTranscript");
  const diffView = requireElement<HTMLDivElement>(document, "mobileDiff");
  const promptForm = requireElement<HTMLFormElement>(document, "mobilePromptForm");
  const promptInput = requireElement<HTMLTextAreaElement>(document, "mobilePromptInput");
  const sendButton = requireElement<HTMLButtonElement>(document, "mobileSendButton");
  const composerStatus = requireElement<HTMLSpanElement>(document, "mobileComposerStatus");
  const mobileLog = requireElement<HTMLParagraphElement>(document, "mobileLog");

  let connection: FuraConnection | null = null;
  let serverConfig: ServerConfig | null = null;
  let sessions: SessionSummary[] = [];
  let activeSessionId: string | null = null;
  let projections = new Map<string, SessionProjection>();
  const unreadSessions = new Set<string>();
  let createCwdDirty = false;
  let createPendingRequestId: string | null = null;
  let pendingCreatedSessionBaseline: Set<string> | null = null;
  let activeMobileView: "transcript" | "diff" = "transcript";
  const diffStates = new Map<string, RepoDiffState>();
  const diffErrors = new Map<string, string>();
  const diffLoadingSessions = new Set<string>();

  const sessionListView = createSessionListView(sessionsList, {
    onSelectSession: selectSession,
    onDeleteSession: () => undefined,
  });

  transcriptTab.addEventListener("click", () => setActiveMobileView("transcript"));
  diffTab.addEventListener("click", () => setActiveMobileView("diff"));

  createToggle.addEventListener("click", () => {
    const open = createDrawer.hidden;
    setCreateDrawerOpen(open);
    if (open) {
      sessionsDrawer.hidden = true;
      sessionsToggle.setAttribute("aria-expanded", "false");
      window.setTimeout(() => createNameInput.focus(), 0);
    }
  });

  sessionsToggle.addEventListener("click", () => {
    const open = sessionsDrawer.hidden;
    sessionsDrawer.hidden = !open;
    sessionsToggle.setAttribute("aria-expanded", String(open));
    if (open) setCreateDrawerOpen(false);
  });

  createClose.addEventListener("click", () => setCreateDrawerOpen(false));
  createCwdInput.addEventListener("input", () => {
    createCwdDirty = true;
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createNameInput.addEventListener("input", () => {
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createForm.addEventListener("submit", event => {
    event.preventDefault();
    submitCreateSession();
  });

  promptForm.addEventListener("submit", event => {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text || !activeSessionId) return;
    const accepted = send({ type: "prompt.send", sessionId: activeSessionId, text });
    if (accepted) promptInput.value = "";
  });

  const initialToken = consumeBootstrapToken(
    window.location.href,
    window.localStorage,
    url => window.history.replaceState(null, "", url),
  );
  render();
  if (initialToken) connect(initialToken);
  else appendLog("No bridge token found. Open mobile.html with ?token=<token> from the Rust server URL.");

  function connect(token: string): void {
    const bridgeToken = storeBootstrapToken(token, window.localStorage);
    if (!bridgeToken) return;
    connection?.disconnect();
    connection = createConnection({
      auth: { type: "sessionCookie", token: bridgeToken },
      onStatus: setStatus,
      onOpen: () => send({ type: "session.list" }),
      onClose: () => handleConnectionClosed(),
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

  function setCreateDrawerOpen(open: boolean): void {
    createDrawer.hidden = !open;
    createToggle.setAttribute("aria-expanded", String(open));
    if (open) syncCreateCwdDefault();
  }

  function syncCreateCwdDefault(): void {
    if (!createCwdDirty) createCwdInput.value = serverConfig?.defaultCwd ?? "";
  }

  function setCreatePending(pending: boolean, requestId: string | null = null): void {
    createPendingRequestId = pending ? requestId : null;
    createNameInput.disabled = pending;
    createCwdInput.disabled = pending;
    createSubmit.disabled = pending;
    createClose.disabled = pending;
    createStatus.textContent = pending ? "Creating session…" : "";
  }

  function submitCreateSession(): void {
    const cwd = createCwdInput.value.trim();
    const name = createNameInput.value.trim();
    if (!cwd) {
      createStatus.textContent = "Working directory is required.";
      return;
    }

    const requestId = nextClientRequestId("mobile-session-create");
    pendingCreatedSessionBaseline = new Set(sessions.map(session => session.sessionId));
    setCreatePending(true, requestId);
    // Mobile intentionally starts with normal cwd-based session creation.
    // Worktree creation, model picker, desktop panel workspace, and Ask Fura are outside the mobile shell scope.
    const accepted = send({
      type: "session.create",
      requestId,
      cwd,
      ...(name ? { name } : {}),
    });
    if (!accepted) {
      pendingCreatedSessionBaseline = null;
      setCreatePending(false);
      createStatus.textContent = "Not connected to the Fura bridge.";
    }
  }

  function isPendingCreatedSession(sessionId: string): boolean {
    return Boolean(pendingCreatedSessionBaseline && !pendingCreatedSessionBaseline.has(sessionId));
  }

  function finishCreateSession(): void {
    pendingCreatedSessionBaseline = null;
    setCreatePending(false);
    createNameInput.value = "";
    createCwdDirty = false;
    syncCreateCwdDefault();
    setCreateDrawerOpen(false);
  }

  function handleCreateError(requestId: string | null, message: string): boolean {
    if (!createPendingRequestId || requestId !== createPendingRequestId) return false;
    pendingCreatedSessionBaseline = null;
    setCreatePending(false);
    setCreateDrawerOpen(true);
    createStatus.textContent = message;
    return true;
  }

  function handleConnectionClosed(): void {
    if (!createPendingRequestId) return;
    const requestId = createPendingRequestId;
    handleCreateError(requestId, "Connection closed before session creation completed.");
  }

  function nextClientRequestId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function setActiveMobileView(view: "transcript" | "diff"): void {
    activeMobileView = view;
    transcript.hidden = view !== "transcript";
    diffView.hidden = view !== "diff";
    transcriptTab.classList.toggle("active", view === "transcript");
    diffTab.classList.toggle("active", view === "diff");
    transcriptTab.setAttribute("aria-pressed", String(view === "transcript"));
    diffTab.setAttribute("aria-pressed", String(view === "diff"));
    if (view === "diff" && activeSessionId) requestMobileDiffState(activeSessionId);
    renderActiveSession();
  }

  function requestMobileDiffState(sessionId: string): void {
    if (!projections.has(sessionId) || diffLoadingSessions.has(sessionId)) return;
    diffErrors.delete(sessionId);
    diffLoadingSessions.add(sessionId);
    send({ type: "diff.refresh", sessionId, stat: true });
    renderDiffView(projections.get(sessionId));
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        serverConfig = message.config;
        syncCreateCwdDefault();
        appendLog(`Connected to fura ${message.serverVersion}.`);
        break;
      case "config.updated":
        serverConfig = message.config;
        syncCreateCwdDefault();
        break;
      case "sessions.snapshot":
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
        render();
        break;
      case "session.snapshot": {
        const createdByPendingRequest = isPendingCreatedSession(message.sessionId);
        ({ sessions, projections } = applySessionSnapshot(sessions, projections, message.sessionId, message.state));
        if (createdByPendingRequest || !activeSessionId || activeSessionId === message.sessionId) {
          activateSession(message.sessionId);
          if (createdByPendingRequest) finishCreateSession();
          render();
        } else {
          unreadSessions.add(message.sessionId);
          renderSessions();
        }
        break;
      }
      case "session.exited":
        appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
        render();
        break;
      case "session.notice":
        appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
        if (message.level === "error" && diffLoadingSessions.has(message.sessionId)) {
          diffLoadingSessions.delete(message.sessionId);
          diffErrors.set(message.sessionId, message.text);
          if (message.sessionId === activeSessionId) renderActiveSession();
        }
        break;
      case "prompt.busy":
        appendLog("Session is busy. Mobile shell does not support steer/follow-up yet.");
        break;
      case "log.stderr":
        appendLog(`[${message.sessionId}] ${message.text}`);
        break;
      case "error":
        appendLog(`Error: ${message.message}`);
        if (handleCreateError(message.requestId ?? null, message.message)) break;
        break;
      case "dialog.request":
      case "model.list":
      case "model.changed":
      case "plan.review":
      case "raw.omp":
        break;
      case "diff.state":
        diffLoadingSessions.delete(message.sessionId);
        diffErrors.delete(message.sessionId);
        diffStates.set(message.sessionId, message.state);
        if (message.sessionId === activeSessionId) renderActiveSession();
        break;
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

  function selectSession(sessionId: string): void {
    const session = sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) return;
    activateSession(sessionId);
    sessionsDrawer.hidden = true;
    sessionsToggle.setAttribute("aria-expanded", "false");
    send(sessionOpenOrAttachMessage(session));
    render();
  }

  function activateSession(sessionId: string): void {
    activeSessionId = activateSessionState(unreadSessions, sessionId);
    if (activeMobileView === "diff" && projections.has(sessionId)) requestMobileDiffState(sessionId);
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
      renderDiffView(undefined);
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
    renderDiffView(projection);
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

  function renderDiffView(projection: SessionProjection | undefined): void {
    setRenderDocument(diffView.ownerDocument);
    diffView.replaceChildren();

    if (!activeSessionId || !projection) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Select a session to load its diff.";
      diffView.append(empty);
      return;
    }

    const sessionId = activeSessionId;
    const state = diffStates.get(sessionId);
    const error = diffErrors.get(sessionId);
    if (error) {
      const message = diffView.ownerDocument.createElement("p");
      message.className = "mobile-empty-state";
      message.textContent = error;
      diffView.append(message);
      return;
    }

    if (diffLoadingSessions.has(sessionId) && !state) {
      const loading = diffView.ownerDocument.createElement("p");
      loading.className = "mobile-empty-state";
      loading.textContent = "Loading diff…";
      diffView.append(loading);
      return;
    }

    if (!state) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "No diff loaded yet.";
      diffView.append(empty);
      return;
    }

    const summary = diffView.ownerDocument.createElement("section");
    summary.className = "mobile-diff-summary";
    const roots = diffRepoRoots(state);
    const title = diffView.ownerDocument.createElement("h3");
    title.textContent = roots.length === 1 ? formatDiffRepoLabel(roots[0] ?? "") : "Diff";
    const meta = diffView.ownerDocument.createElement("p");
    meta.textContent = [
      state.selectedSnapshot ? `Base: ${state.selectedSnapshot.label}` : "Base: current state",
      state.headSnapshot ? `Compare: ${state.headSnapshot.label}` : "Compare: working tree",
      state.stat ? "Stat" : "Full diff",
    ].join(" · ");
    summary.append(title, meta);
    diffView.append(summary);

    if (!state.diff.trim()) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = diffLoadingSessions.has(sessionId) ? "Loading diff…" : "No diff changes.";
      diffView.append(empty);
      return;
    }

    const pre = diffView.ownerDocument.createElement("pre");
    pre.className = "mobile-diff-pre";
    pre.textContent = state.diff;
    diffView.append(pre);
  }

  return { connect, send };
}

function requireElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  return element as T;
}

function renderTodoCards(phases: TodoPhase[]): HTMLElement[] {
  const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
  return nonEmpty.length > 0 ? [renderCurrentTodoCard(nonEmpty)] : [];
}
