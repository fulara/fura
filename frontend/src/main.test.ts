import { beforeEach, describe, expect, it, vi } from "vitest";
import { FURA_TOKEN_STORAGE_KEY } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection } from "./connection";
import type { ClientMessage, CodeLocation, DiffFileSummary, DiffRow, GitFileContent, PendingAskProjection, ReviewComment, ServerConfig, ServerMessage, SessionChangesSummaryState, SessionProjection, SessionSummary } from "./protocol";

class FakeConnection implements FuraConnection {
  sent: ClientMessage[] = [];
  connected = false;
  closed = false;

  constructor(readonly options: {
    onStatus(label: string, status: ConnectionStatus): void;
    onOpen?: () => void;
    onClose?: () => void;
    onAuthFailure(message: string): void;
    onMessage(message: ServerMessage): void;
    onLog(message: string): void;
  }) {}

  connect(): void {
    this.connected = true;
    this.closed = false;
    if (!fakeConnectionAutoOpen) return;
    this.options.onStatus("connected", "connected");
    this.options.onOpen?.();
  }

  disconnect(): void {
    this.connected = false;
    this.closed = true;
  }

  isOpen(): boolean {
    return this.connected && !this.closed;
  }

  send(message: ClientMessage): boolean {
    this.sent.push(message);
    return this.isOpen();
  }

  emit(message: ServerMessage): void {
    this.options.onMessage(message);
  }
}

const config: ServerConfig = {
  defaultCwd: "/repo",
  voiceLanguage: "en",
  showTools: true,
  showEditDiffs: true,
  thinkingVisibility: "auto",
  proposedModels: [],
  presets: [],
};

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: overrides.kind ?? "managed",
    sessionMode: overrides.sessionMode ?? "standard",
    sessionId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    messageCount: overrides.messageCount ?? 0,
    title: overrides.title ?? `Session ${sessionId}`,
    cwd: overrides.cwd ?? "/repo",
    sessionFile: overrides.sessionFile,
    timestamp: overrides.timestamp,
    category: overrides.category,
    worktree: overrides.worktree,
    awaitingAsk: overrides.awaitingAsk,
  };
}

function projection(sessionId: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    summary: summary(sessionId),
    transcript: [],
    isBusy: false,
    tokensTotal: 0,
    costUsd: 0,
    todoPhases: [],
    seq: 0,
    ...overrides,
  };
}

function sessionChangesState(sessionId: string): SessionChangesSummaryState {
  return {
    status: "ready",
    targetClientId: "client-1",
    diffId: "diff-1",
    request: { scope: "sessionChanges", changeKind: "unstaged", clientId: "client-1", diffId: "diff-1", sessionId, repoId: "/repo", detailMode: "statOnly", currentCommitOid: null, selectedFile: null, contextLines: 3 },
    comparison: {
      repoRoot: "/repo",
      base: { kind: "index" },
      head: { kind: "workingTree" },
      leftTreeOrCommit: "a".repeat(40),
      rightTreeOrCommit: "tree",
      detailMode: "statOnly",
      currentCommitOid: null,
      selectedFile: null,
      contextLines: 3,
      generatedAt: "now",
      comparisonKey: "key",
    },
    sessionId,
    repos: [{ id: "/repo", repoRoot: "/repo", label: "repo", source: "cwd", isDefault: true }],
    selectedRepoId: "/repo",
    summary: { files: [], stat: "", truncated: false },
    review: { commits: [], currentCommitOid: null, currentCommitIndex: null, previousCommitOid: null },
    reviewWorktree: null,
  };
}

function simpleDiffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldPath: string | null = null;
  let newPath = "";
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/u.exec(text);
    if (fileMatch) {
      oldPath = fileMatch[1] ?? null;
      newPath = fileMatch[2] ?? fileMatch[1] ?? "";
      hunk = null;
      rows.push({ type: "file", text, oldPath, newPath, filePath: newPath });
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      hunk = text;
      rows.push({ type: "hunk", text, oldPath, newPath, filePath: newPath, hunk });
      continue;
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ type: "line", prefix: "+", location: { oldPath, newPath, hunk, side: "right", kind: "add", newLine, text } });
      newLine += 1;
      continue;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ type: "line", prefix: "-", location: { oldPath, newPath, hunk, side: "left", kind: "remove", oldLine, text } });
      oldLine += 1;
      continue;
    }
    if (text.startsWith(" ")) {
      rows.push({ type: "line", prefix: " ", location: { oldPath, newPath, hunk, side: "right", kind: "context", oldLine, newLine, text } });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    rows.push({ type: "meta", text });
  }
  return rows;
}

let connections: FakeConnection[] = [];
let fakeConnectionAutoOpen = true;
let desktopMockActivePanelIds = new Set(["diffs"]);
const desktopMockActivatePanel = vi.fn(() => true);
// The Code panel is opt-in per harness so its rendering does not perturb tests
// that only assert on sent messages.
let desktopMockMountCodePanel = false;

function installMocks(): void {
  vi.doMock("./connection", () => ({
    createFuraConnection: (options: ConstructorParameters<typeof FakeConnection>[0]) => {
      const connection = new FakeConnection(options);
      connections.push(connection);
      return connection;
    },
  }));
  vi.doMock("./desktopDockview", () => ({
    initDesktopDockview: (options: {
      onPanelReady(id: string, container: HTMLElement): void;
      onPanelClosed?: (id: string) => void;
    }) => {
      const diffPanel = document.createElement("div");
      diffPanel.id = "testDiffPanel";
      const transcriptPanel = document.createElement("div");
      transcriptPanel.id = "testTranscriptPanel";
      const goalPanel = document.createElement("div");
      goalPanel.id = "testGoalPanel";
      const codePanel = document.createElement("div");
      codePanel.id = "testCodePanel";
      document.body.append(diffPanel, transcriptPanel, goalPanel);
      const panels: Record<string, HTMLElement> = {
        diffs: diffPanel,
        transcript: transcriptPanel,
        goal: goalPanel,
      };
      if (desktopMockMountCodePanel) {
        document.body.append(codePanel);
        panels.code = codePanel;
      }
      return {
        panelMounted: (id: string) => Boolean(panels[id]),
        panelContains: (id: string, element: Element) => Boolean(panels[id]?.contains(element)),
        isPanelActive: (id: string) => desktopMockActivePanelIds.has(id),
        activatePanel: desktopMockActivatePanel,
        withPanel: (id: string, render: (container: HTMLElement) => void) => {
          const panel = panels[id];
          if (!panel) return false;
          render(panel);
          return true;
        },
        ensureSessionChangesPanel: () => false,
        ensureDiffsPanel: () => false,
        ensureComparePanel: () => false,
        closePanel: () => false,
        openEphemeralPanel: (id: string) => {
          if (panels[id]) return false;
          const panel = document.createElement("div");
          panel.dataset.panelId = id;
          panels[id] = panel;
          document.body.append(panel);
          options.onPanelReady(id, panel);
          return true;
        },
        setPanelTitle: () => true,
        closeEphemeralPanel: (id: string) => {
          const panel = panels[id];
          if (!panel) return false;
          delete panels[id];
          panel.remove();
          options.onPanelClosed?.(id);
          return true;
        },
      };
    },
  }));
}

async function createHarness(options: { preserveLocalStorage?: boolean; mountCodePanel?: boolean } = {}) {
  vi.resetModules();
  vi.restoreAllMocks();
  // jsdom does not implement the native dialog lifecycle used by the real modal.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  connections = [];
  desktopMockActivePanelIds = new Set(["diffs"]);
  desktopMockActivatePanel.mockClear();
  desktopMockMountCodePanel = options.mountCodePanel ?? false;
  fakeConnectionAutoOpen = true;
  document.body.innerHTML = `<div id="app"></div>`;
  if (!options.preserveLocalStorage) window.localStorage.clear();
  window.sessionStorage.clear();
  window.sessionStorage.setItem(FURA_TOKEN_STORAGE_KEY, "dev");
  window.history.replaceState(null, "", "/");
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  installMocks();
  await import("./main");
  const connection = connections[0];
  if (!connection) throw new Error("connection missing");
  connection.emit({ type: "hello", serverVersion: "test", protocolVersion: 1, config });
  return { connection };
}

async function createPendingHarness() {
  vi.resetModules();
  vi.restoreAllMocks();
  connections = [];
  desktopMockActivePanelIds = new Set(["diffs"]);
  desktopMockMountCodePanel = false;
  fakeConnectionAutoOpen = false;
  document.body.innerHTML = `<div id="app"></div>`;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.sessionStorage.setItem(FURA_TOKEN_STORAGE_KEY, "dev");
  window.history.replaceState(null, "", "/");
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  installMocks();
  await import("./main");
  return { connection: connections[0] };
}


describe("auth gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    fakeConnectionAutoOpen = true;
    connections = [];
    vi.useRealTimers();
  });

  it("stays visible while a stored-token connection is pending", async () => {
    await createPendingHarness();

    expect(document.querySelector<HTMLElement>("#authGate")?.hidden).toBe(false);
    expect(document.querySelector("#authStatus")?.textContent).toBe("Connecting…");
  });

  it("does not crash on LAN HTTP where crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });

    await createPendingHarness();

    expect(document.querySelector<HTMLElement>("#authGate")?.hidden).toBe(false);
    expect(window.sessionStorage.getItem("fura.diff.clientId")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    vi.unstubAllGlobals();
  });
});

describe("desktop Goal Mode panel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("renders no-session Goal panel copy without implying background execution", async () => {
    const { connection } = await createHarness();
    desktopMockActivePanelIds.add("goal");
    connection.emit({ type: "sessions.snapshot", sessions: [] });

    expect(document.querySelector("#testGoalPanel")?.textContent).toContain("Select a session to view or set a goal.");
  });

  it("renders Goal Mode inside the normal Dockview goal panel", async () => {
    const { connection } = await createHarness();
    desktopMockActivePanelIds.add("goal");
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        goalMode: {
          enabled: true,
          mode: "active",
          goal: {
            id: "goal-1",
            objective: "Keep Goal Mode in the Dockview workspace",
            status: "active",
            tokenBudget: 50000,
            tokensUsed: 12500,
            timeUsedSeconds: 95,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      }),
    });

    expect(document.querySelector("#goalModeCardHost")).toBeNull();
    const goalPanel = document.querySelector("#testGoalPanel");
    expect(goalPanel?.querySelector(".goal-mode-card-desktop")?.textContent).toContain("Keep Goal Mode in the Dockview workspace");
    expect(goalPanel?.querySelector(".goal-mode-badge")?.textContent).toBe("Goal set");
  });
});

describe("desktop ask cards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  function activateSessionWithAsk(
    connection: FakeConnection,
    pendingAsk: PendingAskProjection,
    awaitingAsk: boolean,
  ): void {
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live", { awaitingAsk })] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { pendingAsk, summary: summary("live", { awaitingAsk }) }),
    });
  }

  it("renders a select ask inline, locks the composer, and responds with the chosen option", async () => {
    const { connection } = await createHarness();
    activateSessionWithAsk(
      connection,
      { id: "select-1", method: "select", title: "Review Mode", options: ["Review uncommitted changes", "Review a commit"] },
      true,
    );

    const card = document.querySelector<HTMLElement>(".ask-card");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ask-card-title")?.textContent).toBe("Review Mode");
    expect(document.querySelector<HTMLTextAreaElement>("#promptInput")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#sendButton")?.disabled).toBe(true);

    [...document.querySelectorAll<HTMLButtonElement>(".ask-card-option")]
      .find(button => button.textContent === "Review a commit")
      ?.click();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "select-1",
      response: { value: "Review a commit" },
    });
  });

  it("renders an editor ask with prefill and sends the edited value", async () => {
    const { connection } = await createHarness();
    activateSessionWithAsk(
      connection,
      { id: "editor-1", method: "editor", title: "Custom instructions", prefill: "Focus on correctness.", promptStyle: true },
      true,
    );

    const textarea = document.querySelector<HTMLTextAreaElement>(".ask-card .ask-card-input");
    if (!textarea) throw new Error("ask editor missing");
    expect(textarea.value).toBe("Focus on correctness.");
    textarea.value = "Focus on concurrency and missed errors.";
    document.querySelector<HTMLButtonElement>(".ask-card .ask-card-submit")?.click();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "editor-1",
      response: { value: "Focus on concurrency and missed errors." },
    });
  });

  it("renders open_url asks as a safe link without locking the composer", async () => {
    const { connection } = await createHarness();
    activateSessionWithAsk(
      connection,
      { id: "open-1", method: "open_url", title: "Sign in", instructions: "Open the browser link.", url: "https://auth.example.test/start" },
      false,
    );

    const card = document.querySelector<HTMLElement>(".ask-card");
    expect(card?.querySelector(".ask-card-body")?.textContent).toContain("Open the browser link.");
    expect(card?.querySelector<HTMLAnchorElement>("a.ask-card-option")?.href).toBe("https://auth.example.test/start");
    expect(document.querySelector<HTMLTextAreaElement>("#promptInput")?.disabled).toBe(false);

    card?.querySelector<HTMLButtonElement>(".ask-card-cancel")?.click();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "open-1",
      response: { cancelled: true },
    });
  });

  it("sends cancelled=true when a blocking ask is cancelled", async () => {
    const { connection } = await createHarness();
    activateSessionWithAsk(
      connection,
      { id: "select-cancel-1", method: "select", title: "Review Mode", options: ["A", "B"] },
      true,
    );

    document.querySelector<HTMLButtonElement>(".ask-card .ask-card-cancel")?.click();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "select-cancel-1",
      response: { cancelled: true },
    });
  });
});


describe("desktop cog options", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("keeps the menu open when visibility toggles are changed", async () => {
    const { connection } = await createHarness();

    document.querySelector<HTMLButtonElement>("#workspaceOptionsToggle")?.click();
    document.querySelector<HTMLButtonElement>("#toolVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", showTools: false });
    expect(document.querySelector("#workspaceOptionsMenu")?.hasAttribute("hidden")).toBe(false);

    document.querySelector<HTMLButtonElement>("#thinkingVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", thinkingVisibility: "shown" });
    expect(document.querySelector("#workspaceOptionsMenu")?.hasAttribute("hidden")).toBe(false);
  });

  it("lists rollback points with the latest selected and restores an exact unsent draft", async () => {
    const { connection } = await createHarness();
    connection.emit({
      type: "sessions.snapshot",
      sessions: [summary("live", { updatedAt: 2 }), summary("branched", { updatedAt: 1 })],
    });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    connection.emit({ type: "session.snapshot", sessionId: "branched", state: projection("branched") });

    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    if (!input) throw new Error("composer missing");
    input.value = "current draft";
    document.querySelector<HTMLButtonElement>("#workspaceOptionsToggle")?.click();
    const rollbackButton = document.querySelector<HTMLButtonElement>("#rollbackChatButton");
    expect(rollbackButton?.classList.contains("danger-action")).toBe(false);
    rollbackButton?.click();

    const listRequest = connection.sent.find(message => message.type === "session.rewind.list");
    if (!listRequest || listRequest.type !== "session.rewind.list") throw new Error("rollback list request missing");
    connection.emit({
      type: "session.rewind.points",
      requestId: "stale",
      sessionId: "live",
      points: [{ entryId: "ignored", text: "ignored", imageCount: 0 }],
    });
    connection.emit({
      type: "session.rewind.points",
      requestId: listRequest.requestId,
      sessionId: "live",
      points: [
        { entryId: "first", text: "earlier text", imageCount: 0 },
        { entryId: "latest", text: "", imageCount: 2 },
      ],
    });

    const rows = document.querySelectorAll<HTMLButtonElement>("#rollbackChatList .rollback-chat-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
    expect(rows[1]?.textContent).toContain("Image-only prompt");
    expect(rows[1]?.textContent).toContain("2 images");
    expect(document.querySelector("#rollbackChatWarning")?.hasAttribute("hidden")).toBe(false);
    document.querySelector<HTMLButtonElement>("#rollbackChatRestore")?.click();

    const selectRequest = connection.sent.find(message => message.type === "session.rewind.select");
    if (!selectRequest || selectRequest.type !== "session.rewind.select") throw new Error("rollback select request missing");
    expect(selectRequest.entryId).toBe("latest");
    expect(document.querySelector("#rollbackChatStatus")?.textContent).toBe("Rolling back…");
    expect(document.querySelector<HTMLButtonElement>("#rollbackChatCancel")?.disabled).toBe(true);
    expect(connection.sent.some(message => message.type === "prompt.send")).toBe(false);

    connection.emit({
      type: "session.rewind.result",
      requestId: selectRequest.requestId,
      sourceSessionId: "live",
      sessionId: "branched",
      text: "restored [Image #1, 1x1] attachment://1",
      images: [{ type: "image", data: "abc", mimeType: "image/png", detail: "high", providerFile: "file-1" }],
      cancelled: false,
    });

    expect(input.value).toBe("restored [Image #1, 1x1] attachment://1");
    expect(document.querySelector<HTMLImageElement>("#imagePreviews img")).toBeTruthy();
    expect(document.querySelector<HTMLElement>("#rollbackChatOverlay")?.hidden).toBe(true);
    expect(connection.sent.some(message => message.type === "prompt.send")).toBe(false);

    document.querySelector<HTMLFormElement>("#promptForm")?.requestSubmit();
    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "branched",
      text: "restored [Image #1, 1x1] attachment://1",
      images: [{ type: "image", data: "abc", mimeType: "image/png", detail: "high", providerFile: "file-1" }],
    });
  });

  it("preserves the current draft on rollback errors and cancellation", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    if (!input) throw new Error("composer missing");
    input.value = "keep this draft";

    document.querySelector<HTMLButtonElement>("#workspaceOptionsToggle")?.click();
    document.querySelector<HTMLButtonElement>("#rollbackChatButton")?.click();
    const listRequest = connection.sent.find(message => message.type === "session.rewind.list");
    if (!listRequest || listRequest.type !== "session.rewind.list") throw new Error("rollback list request missing");
    connection.emit({
      type: "session.rewind.points",
      requestId: listRequest.requestId,
      sessionId: "live",
      points: [{ entryId: "point", text: "old prompt", imageCount: 0 }],
    });
    document.querySelector<HTMLButtonElement>("#rollbackChatRestore")?.click();
    const firstSelect = connection.sent.find(message => message.type === "session.rewind.select");
    if (!firstSelect || firstSelect.type !== "session.rewind.select") throw new Error("rollback select request missing");
    connection.emit({
      type: "session.rewind.error",
      requestId: firstSelect.requestId,
      sourceSessionId: "live",
      sessionId: "live",
      message: "Rollback hook failed.",
    });

    expect(input.value).toBe("keep this draft");
    expect(document.querySelector("#rollbackChatStatus")?.textContent).toBe("Rollback hook failed.");
    expect(document.querySelector("#rollbackChatRetry")?.hasAttribute("hidden")).toBe(false);

    document.querySelector<HTMLButtonElement>("#rollbackChatRetry")?.click();
    const retryRequest = [...connection.sent].reverse().find(message => message.type === "session.rewind.list");
    if (!retryRequest || retryRequest.type !== "session.rewind.list") throw new Error("rollback retry request missing");
    connection.emit({
      type: "session.rewind.points",
      requestId: retryRequest.requestId,
      sessionId: "live",
      points: [{ entryId: "point", text: "old prompt", imageCount: 0 }],
    });
    document.querySelector<HTMLButtonElement>("#rollbackChatRestore")?.click();
    const secondSelect = [...connection.sent].reverse().find(message => message.type === "session.rewind.select");
    if (!secondSelect || secondSelect.type !== "session.rewind.select") throw new Error("second rollback select missing");
    connection.emit({
      type: "session.rewind.result",
      requestId: secondSelect.requestId,
      sourceSessionId: "live",
      sessionId: "live",
      text: "old prompt",
      images: [],
      cancelled: true,
    });

    expect(input.value).toBe("keep this draft");
    expect(document.querySelector<HTMLElement>("#rollbackChatOverlay")?.hidden).toBe(true);
    expect(connection.sent.some(message => message.type === "prompt.send")).toBe(false);
  });

  it("opens model templates in a dialog and sends config.set from the form", async () => {
    const { connection } = await createHarness();

    document.querySelector<HTMLButtonElement>("#workspaceOptionsToggle")?.click();
    expect(document.querySelector("#workspaceOptionsMenu #proposedModelsList")).toBeNull();
    document.querySelector<HTMLButtonElement>("#proposedModelsOpen")?.click();

    expect(document.querySelector("#workspaceOptionsMenu")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#proposedModelsOverlay")?.hasAttribute("hidden")).toBe(false);
    const catalogRequest = connection.sent.find(message => message.type === "config.modelCatalog.list");
    expect(catalogRequest).toBeTruthy();

    connection.emit({
      type: "config.modelCatalog.list",
      requestId: catalogRequest?.requestId,
      models: [{ provider: "mock", id: "mock-reasoner", name: "Mock Reasoner", contextWindow: 1000000, thinking: true }],
    });
    document.querySelector<HTMLButtonElement>("#proposedModelAdd")?.click();
    const search = document.querySelector<HTMLInputElement>("#proposedModelSearchInput");
    if (!search) throw new Error("model search missing");
    search.value = "reasoner";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const name = document.querySelector<HTMLInputElement>("#proposedModelNameInput");
    if (!name) throw new Error("model template name missing");
    name.value = "Fast review";
    document.querySelector<HTMLButtonElement>("#proposedModelSave")?.click();

    expect(connection.sent).toContainEqual({
      type: "config.set",
      proposedModels: [{
        id: "fast-review",
        name: "Fast review",
        provider: "mock",
        modelId: "mock-reasoner",
        modelName: "Mock Reasoner",
        thinkingLevel: "default",
      }],
    });
  });

  it("opens the clicked diff file in Code after the workspace loads", async () => {
    const { connection } = await createHarness();

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: " src/main.ts | 2 +-\n", truncated: false },
      },
    });
    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="src/main.ts"]')?.click();
    connection.sent.length = 0;

    const menu = openGitFileMenu("src/main.ts");
    expect(menu.some(button => button.textContent === "View this revision in Code")).toBe(false);
    const codeButton = menu.find(button => button.textContent === "Open in Code");
    if (!codeButton) throw new Error("Open in Code menu action missing");
    codeButton.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "code.workspace.openRoot", root: "/repo", source: "session" }));

    // Simulate the Code panel becoming active after activatePanel("code") in the real shell.
    desktopMockActivePanelIds.add("code");
    connection.emit({
      type: "code.workspace.ready",
      workspace: { workspaceId: "ws-1", sessionId: null, root: "/repo", rustRoot: null, status: "filesOnly", statusMessage: "Files only.", source: "session", reviewWorktreeId: null },
    });

    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "code.file.open", workspaceId: "ws-1", path: "src/main.ts" }));
  });

  it("opens the clicked diff file in Code on the first try before the panel reports active", async () => {
    const { connection } = await createHarness();

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: " src/main.ts | 2 +-\n", truncated: false },
      },
    });
    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="src/main.ts"]')?.click();
    connection.sent.length = 0;

    const codeButton = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Code");
    if (!codeButton) throw new Error("Code button missing");
    codeButton.click();

    // The Code panel has NOT been marked active yet (activatePanel races the reply).
    expect(desktopMockActivePanelIds.has("code")).toBe(false);
    connection.emit({
      type: "code.workspace.ready",
      workspace: { workspaceId: "ws-1", sessionId: null, root: "/repo", rustRoot: null, status: "filesOnly", statusMessage: "Files only.", source: "session", reviewWorktreeId: null },
    });

    // The explicit open must still be honored on the first try.
    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "code.file.open", workspaceId: "ws-1", path: "src/main.ts" }));
  });


  function openCommentRepo(connection: FakeConnection, root: string, text: string, version = 1): void {
    const repos = [
      { id: "/repo", repoRoot: "/repo", label: "A", source: "cwd" as const, isDefault: true },
      { id: "/other", repoRoot: "/other", label: "B", source: "manual" as const, isDefault: false },
    ];
    const select = document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-repo-select");
    if (select) {
      select.value = root;
      select.dispatchEvent(new Event("change"));
    }
    answerGitRequest(connection, `${root}-${version}`, { repos, selectedRepoId: root });
    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="same.ts"]')!.click();
    const beforeOpen = connection.sent.length;
    clickGitButton("Code");
    desktopMockActivePanelIds.add("code");
    if (connection.sent.slice(beforeOpen).some(message => message.type === "code.workspace.openRoot")) {
      connection.emit({
        type: "code.workspace.ready",
        workspace: { workspaceId: `ws-${root}`, sessionId: null, root, rustRoot: null, status: "filesOnly", statusMessage: "Files only.", source: "session", reviewWorktreeId: null },
      });
    }
    connection.emit({ type: "code.tree", workspaceId: `ws-${root}`, path: "", entries: [{ name: "same.ts", path: "same.ts", kind: "file", size: text.length }] });
    connection.emit({ type: "code.file", workspaceId: `ws-${root}`, file: { path: "same.ts", language: "", text, size: text.length, version } });
  }

  it("isolates Code comment add/edit/delete/preview/flush across A/same.ts and B/same.ts", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    openCommentRepo(connection, "/repo", "A_WORK\n");
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("A_ONLY");
    document.querySelector<HTMLButtonElement>("#testCodePanel .diff-comment-btn")!.click();

    openCommentRepo(connection, "/other", "B_WORK\n");
    expect(document.querySelector("#testCodePanel")!.textContent).toContain("B_WORK");
    expect(document.querySelector("#testCodePanel")!.textContent).not.toContain("A_ONLY");
    expect(document.querySelector<HTMLButtonElement>("#testCodePanel .code-file-actions button")!.disabled).toBe(true);
    prompt.mockReturnValue("B_ONLY");
    document.querySelector<HTMLButtonElement>("#testCodePanel .diff-comment-btn")!.click();
    prompt.mockReturnValue("B_EDITED");
    document.querySelector<HTMLButtonElement>("#testCodePanel .review-comment-actions button:first-child")!.click();
    expect(document.querySelector("#testCodePanel .code-comments")!.textContent).toContain("B_EDITED");
    document.querySelector<HTMLButtonElement>("#testCodePanel .code-file-actions button")!.click();
    const preview = document.querySelector<HTMLTextAreaElement>("#diffPreviewText")!;
    expect(preview.value).toContain("Workspace root: /other");
    expect(preview.value).toContain("Location: /other/same.ts:1");
    expect(preview.value).toContain("Reviewed version: 1");
    expect(preview.value).toContain("B_EDITED");
    expect(preview.value).toContain("B_WORK");
    expect(preview.value).not.toContain("A_ONLY");
    expect(preview.value).not.toContain("A_WORK");
    document.querySelector<HTMLButtonElement>("#diffPreviewClose")!.click();
    document.querySelector<HTMLButtonElement>("#testCodePanel .review-comment-actions button:last-child")!.click();
    expect(document.querySelector("#testCodePanel .code-comments")).toBeNull();
    prompt.mockReturnValue("B_FLUSH");
    document.querySelector<HTMLButtonElement>("#testCodePanel .diff-comment-btn")!.click();
    document.querySelectorAll<HTMLButtonElement>("#testCodePanel .code-file-actions button")[1]!.click();
    document.querySelector<HTMLButtonElement>("#diffPreviewSend")!.click();
    const sent = connection.sent.find(message => message.type === "prompt.send");
    if (!sent || sent.type !== "prompt.send") throw new Error("Code comment prompt missing");
    expect(sent.text).toContain("Workspace root: /other");
    expect(sent.text).toContain("B_FLUSH");
    expect(sent.text).not.toContain("A_ONLY");
    expect(document.querySelector("#testCodePanel .code-comments")).toBeNull();
    openCommentRepo(connection, "/repo", "A_WORK\n");
    expect(document.querySelector("#testCodePanel .code-comments")!.textContent).toContain("A_ONLY");
    expect(document.querySelector("#testCodePanel")!.textContent).not.toContain("B_FLUSH");
  });

  it("keeps Code comments and an open preview pinned to reviewed content after a same-version file change", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    openCommentRepo(connection, "/repo", "OLD_WORK\n");
    vi.spyOn(window, "prompt").mockReturnValue("OLD_ONLY");
    document.querySelector<HTMLButtonElement>("#testCodePanel .diff-comment-btn")!.click();
    document.querySelector<HTMLButtonElement>("#testCodePanel .code-file-actions button")!.click();
    connection.emit({
      type: "code.file", workspaceId: "ws-/repo",
      file: { path: "same.ts", language: "", text: "NEW_WORK\n", size: 9, version: 1 },
    });
    expect(document.querySelector("#testCodePanel")!.textContent).toContain("NEW_WORK");
    expect(document.querySelector("#testCodePanel")!.textContent).not.toContain("OLD_ONLY");
    expect(document.querySelector<HTMLButtonElement>("#testCodePanel .code-file-actions button")!.disabled).toBe(true);
    const preview = document.querySelector<HTMLTextAreaElement>("#diffPreviewText")!;
    expect(preview.value).toContain("OLD_ONLY");
    expect(preview.value).toContain("OLD_WORK");
    expect(preview.value).not.toContain("NEW_WORK");
    document.querySelector<HTMLButtonElement>("#diffPreviewSend")!.click();
    const sent = connection.sent.find(message => message.type === "prompt.send");
    if (!sent || sent.type !== "prompt.send") throw new Error("Code comment prompt missing");
    expect(sent.text).toContain("OLD_WORK");
    expect(sent.text).not.toContain("NEW_WORK");
  });

  it("refreshes external Code root B without returning to session cwd A and retains the file and tree", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    openCommentRepo(connection, "/other", "B_WORK\n");
    connection.emit({ type: "code.tree", workspaceId: "ws-/other", path: "src", entries: [{ name: "same.ts", path: "src/same.ts", kind: "file" }] });
    document.querySelector<HTMLButtonElement>("#testCodePanel .code-tree-entry")!.click();
    connection.emit({ type: "code.file", workspaceId: "ws-/other", file: { path: "src/same.ts", language: "", text: "B_WORK\n", size: 7, version: 1 } });
    connection.sent.length = 0;
    document.querySelector<HTMLButtonElement>("#testCodePanel .code-workspace-header button")!.click();
    expect(connection.sent.some(message => message.type === "code.workspace.open")).toBe(false);
    const open = connection.sent.find(message => message.type === "code.workspace.openRoot");
    if (!open || open.type !== "code.workspace.openRoot") throw new Error("Refresh did not reopen a root");
    expect(open.root).toBe("/other");
    // A late ready from the session's original workspace must not hijack Refresh.
    connection.emit({ type: "code.workspace.ready", workspace: { workspaceId: "stale-A", sessionId: "live", root: "/repo", source: "session", status: "filesOnly" } });
    connection.emit({ type: "code.workspace.ready", workspace: { workspaceId: "refreshed-B", sessionId: null, root: open.root, source: open.source, status: "filesOnly", statusMessage: "Files only." } });
    expect(connection.sent).toContainEqual({ type: "code.file.open", workspaceId: "refreshed-B", path: "src/same.ts" });
    expect(connection.sent).toContainEqual({ type: "code.tree.list", workspaceId: "refreshed-B", path: "src" });
    connection.emit({ type: "code.tree", workspaceId: "refreshed-B", path: "src", entries: [{ name: "same.ts", path: "src/same.ts", kind: "file" }] });
    connection.emit({ type: "code.file", workspaceId: "refreshed-B", file: { path: "src/same.ts", language: "", text: "B_REFRESHED\n", size: 12, version: 2 } });
    connection.emit({ type: "code.workspace.ready", workspace: { workspaceId: "stale-A", sessionId: "live", root: "/repo", source: "session", status: "filesOnly" } });
    connection.emit({ type: "code.file", workspaceId: "stale-A", file: { path: "same.ts", language: "", text: "A_WORK\n", size: 7, version: 1 } });
    expect(document.querySelector("#testCodePanel .code-workspace-header")!.textContent).toContain("/other");
    expect(document.querySelector("#testCodePanel .code-file-path")!.textContent).toBe("src/same.ts");
    expect(document.querySelector("#testCodePanel .code-file-view")!.textContent).toContain("B_REFRESHED");
    expect(document.querySelector("#testCodePanel .code-file-view")!.textContent).not.toContain("A_WORK");
    expect(document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-repo-select")!.value).toBe("/other");
  });

  async function openCodeFileForNavigation(connection: FakeConnection): Promise<void> {
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    desktopMockActivePanelIds.add("code");
    connection.emit({
      type: "code.workspace.ready",
      workspace: { workspaceId: "ws-1", sessionId: "live", root: "/repo", rustRoot: "/repo", status: "filesOnly", statusMessage: "Files only.", source: "session", reviewWorktreeId: null },
    });
    // Plain language keeps the line a single text node so the caret stub is simple.
    connection.emit({
      type: "code.file",
      workspaceId: "ws-1",
      file: { path: "src/main.rs", language: "", text: "fn main() { target(); }\n", size: 24, version: 1 },
    });
  }

  // jsdom lacks caret APIs; stub one so a right-click resolves to a known column.
  // This drives the real contextmenu → popup → request path so a response can be
  // correlated by requestId.
  function rightClickCodeLine(): void {
    const content = document.querySelector<HTMLElement>("#testCodePanel .code-line-content");
    if (!content) throw new Error("code line content missing");
    const codeEl = content.querySelector("code");
    if (!codeEl) throw new Error("code element missing");
    (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range }).caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(codeEl.firstChild ?? codeEl, 3);
      range.collapse(true);
      return range;
    };
    content.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  }

  function triggerNavAction(label: string): void {
    rightClickCodeLine();
    const button = [...document.querySelectorAll<HTMLButtonElement>(".code-context-menu .code-context-action")]
      .find(candidate => candidate.textContent === label);
    if (!button) throw new Error(`${label} action missing`);
    button.click();
  }

  function sentRequestId(connection: FakeConnection, type: "code.definition" | "code.references"): string {
    const sent = [...connection.sent].reverse().find(
      (message): message is Extract<ClientMessage, { type: "code.definition" | "code.references" }> =>
        message.type === type,
    );
    if (!sent) throw new Error(`${type} request not sent`);
    return sent.requestId;
  }

  it("jumps to a local definition target for the issuing client's request", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    triggerNavAction("Go to definition");
    const requestId = sentRequestId(connection, "code.definition");
    connection.sent.length = 0;

    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId,
      path: "src/main.rs",
      locations: [{ kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }],
    });

    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "code.file.open", workspaceId: "ws-1", path: "src/target.rs" }));
    // The sidebar tree must follow the jump even if a tree load is in flight.
    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "code.tree.list", workspaceId: "ws-1", path: "src" }));
  });

  it("clears a prior navigation error when a new navigation runs", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    triggerNavAction("Go to definition");
    const firstId = sentRequestId(connection, "code.definition");
    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId: firstId,
      path: "src/main.rs",
      locations: [{ kind: "external", uri: "file:///dep/lib.rs", label: "/dep/lib.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }],
    });
    expect(document.querySelector("#testCodePanel .code-error")?.textContent).toContain("outside this workspace");

    triggerNavAction("Go to definition");
    const secondId = sentRequestId(connection, "code.definition");
    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId: secondId,
      path: "src/main.rs",
      locations: [{ kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }],
    });
    expect(document.querySelector("#testCodePanel .code-error")).toBeNull();
  });

  it("does not navigate when the definition resolves outside the workspace", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    triggerNavAction("Go to definition");
    const requestId = sentRequestId(connection, "code.definition");
    connection.sent.length = 0;

    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId,
      path: "src/main.rs",
      locations: [{ kind: "external", uri: "file:///dep/lib.rs", label: "/dep/lib.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }],
    });

    expect(connection.sent.some(message => message.type === "code.file.open")).toBe(false);
  });

  it("renders find-references results grouped by file", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    triggerNavAction("Find references");
    const requestId = sentRequestId(connection, "code.references");

    connection.emit({
      type: "code.references",
      workspaceId: "ws-1",
      requestId,
      path: "src/main.rs",
      locations: [
        { kind: "local", path: "src/main.rs", range: { start: { line: 0, character: 12 }, end: { line: 0, character: 18 } } },
        { kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } },
      ],
    });

    const panel = document.querySelector("#testCodePanel .code-references");
    expect(panel?.textContent).toContain("References (2)");
    expect(document.querySelectorAll("#testCodePanel .code-references-group").length).toBe(2);
  });

  it("requests hover and renders it in the right-click popup", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    rightClickCodeLine();
    const hoverSent = [...connection.sent].reverse().find(
      (message): message is Extract<ClientMessage, { type: "code.hover" }> => message.type === "code.hover",
    );
    if (!hoverSent) throw new Error("code.hover request not sent");
    expect(document.querySelector(".code-context-hover-muted")?.textContent).toContain("Loading");

    connection.emit({
      type: "code.hover",
      workspaceId: "ws-1",
      requestId: hoverSent.requestId,
      path: "src/main.rs",
      contents: "```rust\nfn target()\n```\nDocs.",
    });
    expect(document.querySelector(".code-context-hover")?.textContent).toContain("fn target()");

    // A reply for a superseded request id is ignored.
    connection.emit({
      type: "code.hover",
      workspaceId: "ws-1",
      requestId: "stale-hover",
      path: "src/main.rs",
      contents: "stale info",
    });
    expect(document.querySelector(".code-context-hover")?.textContent).not.toContain("stale info");

    // Escape dismisses the popup.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".code-context-menu")).toBeNull();
  });

  it("resolves a loading hover popup on failure status but leaves rendered hover intact", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    // A still-loading popup is resolved to a placeholder by a failure status.
    rightClickCodeLine();
    connection.emit({ type: "code.status", workspaceId: "ws-1", status: "error", message: "boom" });
    expect(document.querySelector(".code-context-hover-muted")?.textContent).toContain("unavailable");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // A rendered hover must NOT be clobbered by a later shared-workspace failure.
    rightClickCodeLine();
    const hoverSent = [...connection.sent].reverse().find(
      (message): message is Extract<ClientMessage, { type: "code.hover" }> => message.type === "code.hover",
    );
    if (!hoverSent) throw new Error("code.hover request not sent");
    connection.emit({ type: "code.hover", workspaceId: "ws-1", requestId: hoverSent.requestId, path: "src/main.rs", contents: "fn target()" });
    expect(document.querySelector(".code-context-hover")?.textContent).toContain("fn target()");
    connection.emit({ type: "code.status", workspaceId: "ws-1", status: "unavailable", message: "down" });
    expect(document.querySelector(".code-context-hover")?.textContent).toContain("fn target()");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("resolves a loading hover popup when a code.error arrives", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    rightClickCodeLine();
    expect(document.querySelector(".code-context-hover-muted")?.textContent).toContain("Loading");
    connection.emit({ type: "code.error", workspaceId: "ws-1", path: "src/main.rs", message: "file vanished" });
    expect(document.querySelector(".code-context-hover-muted")?.textContent).toContain("unavailable");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("survives a programmatic scroll and a code.status re-render, dismissing only on an outside wheel", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    rightClickCodeLine();
    // Re-query each time: a code-panel re-render rebuilds the lines container.
    const codeLines = () => {
      const el = document.querySelector("#testCodePanel .code-review-lines");
      if (!el) throw new Error("code lines missing");
      return el;
    };

    // A `scroll` event (e.g. the scroll-preservation restore fired by a
    // code-panel re-render) must NOT dismiss the popup — only user wheel gestures do.
    codeLines().dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(document.querySelector(".code-context-menu")).not.toBeNull();

    // A code.status update re-renders the code panel; the popup must stay open.
    connection.emit({ type: "code.status", workspaceId: "ws-1", status: "indexing" });
    expect(document.querySelector(".code-context-menu")).not.toBeNull();

    // A wheel gesture inside the hover pane must not dismiss it.
    const hoverPane = document.querySelector(".code-context-hover");
    if (!hoverPane) throw new Error("hover pane missing");
    hoverPane.dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(document.querySelector(".code-context-menu")).not.toBeNull();

    // A wheel gesture over the code lines invalidates the anchor → dismiss.
    codeLines().dispatchEvent(new Event("wheel", { bubbles: true }));
    expect(document.querySelector(".code-context-menu")).toBeNull();
  });

  it("ignores an uncorrelated definition response (stale or other client)", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);
    connection.sent.length = 0;

    // No matching request was issued by this client, so the reply is dropped.
    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId: "someone-elses-request",
      path: "src/main.rs",
      locations: [{ kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }],
    });

    expect(connection.sent.some(message => message.type === "code.file.open")).toBe(false);
  });

  it("drops a navigation reply after the user opens a different file", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);

    triggerNavAction("Go to definition");
    const requestId = sentRequestId(connection, "code.definition");

    // The user opens a different file before the reply arrives, which must
    // invalidate the in-flight navigation request.
    connection.emit({
      type: "code.tree",
      workspaceId: "ws-1",
      path: "src",
      entries: [{ name: "lib.rs", path: "src/lib.rs", kind: "file", size: 10 }],
    });
    const entry = [...document.querySelectorAll<HTMLButtonElement>("#testCodePanel .code-tree-entry-file")]
      .find(candidate => candidate.textContent?.includes("lib.rs"));
    if (!entry) throw new Error("tree entry missing");
    entry.click();
    connection.sent.length = 0;

    connection.emit({
      type: "code.definition",
      workspaceId: "ws-1",
      requestId,
      path: "src/main.rs",
      locations: [{ kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }],
    });

    expect(connection.sent.some(message => message.type === "code.file.open" && message.path === "src/target.rs")).toBe(false);
  });

  it("refreshes an active Diffs view when an agent turn settles", async () => {
    const { connection } = await createHarness();

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const initialRequest = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!initialRequest || initialRequest.type !== "sessionChanges.request") {
      throw new Error("initial session changes request missing");
    }
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...sessionChangesState("live"),
        targetClientId: initialRequest.clientId,
        diffId: initialRequest.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: initialRequest.clientId,
        diffId: initialRequest.diffId,
        sessionId: "live",
        repoId: initialRequest.repoId,
        detailMode: initialRequest.detailMode,
        currentCommitOid: initialRequest.currentCommitOid,
        selectedFile: initialRequest.selectedFile,
        contextLines: initialRequest.contextLines ?? 3, },
      },
    });
    connection.sent.length = 0;

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        isBusy: true,
        summary: summary("live", { status: "busy" }),
      }),
    });
    expect(connection.sent.some(message => message.type === "sessionChanges.request")).toBe(false);

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live"),
    });

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "sessionChanges.request",
      sessionId: "live",
      repoId: "/repo",
      detailMode: "statOnly",
    }));
  });



  function latestGitRequest(connection: FakeConnection): Extract<ClientMessage, { type: "sessionChanges.request" }> {
    const request = [...connection.sent].reverse().find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("Git request missing");
    return request;
  }

  function answerGitRequest(
    connection: FakeConnection,
    key: string,
    overrides: Partial<Extract<SessionChangesSummaryState, { status: "ready" }>> = {},
  ): Extract<ClientMessage, { type: "sessionChanges.request" }> {
    const request = latestGitRequest(connection);
    const base = sessionChangesState("live");
    if (base.status !== "ready") throw new Error("Git fixture missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...base,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { ...request, scope: "sessionChanges" },
        comparison: { ...base.comparison, repoRoot: overrides.selectedRepoId ?? "/repo", comparisonKey: key, detailMode: "filePatch", head: request.changeKind === "staged" ? { kind: "index" } : { kind: "workingTree" } },
        summary: { files: [{ newPath: "same.ts", status: "modified", added: 1, removed: 1 }], truncated: false },
        ...overrides,
      },
    });
    return request;
  }

  function clickGitButton(text: string): void {
    const button = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")].find(candidate => candidate.textContent === text);
    if (!button) throw new Error(`${text} button missing`);
    button.click();
  }

  function answerRevisionComparison(
    connection: FakeConnection,
    file: DiffFileSummary = { newPath: "src/history.rs", status: "modified", added: 1, removed: 1 },
    baseOid: string | null = "a".repeat(40),
    headOid = "b".repeat(40),
  ): void {
    const base = sessionChangesState("live");
    if (base.status !== "ready") throw new Error("Git fixture missing");
    answerGitRequest(connection, `revision-${baseOid}-${headOid}`, {
      comparison: {
        ...base.comparison,
        base: baseOid ? { kind: "commit", oid: baseOid, shortOid: baseOid.slice(0, 12) } : { kind: "emptyTree" },
        head: { kind: "commit", oid: headOid, shortOid: headOid.slice(0, 12) },
        leftTreeOrCommit: baseOid ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        rightTreeOrCommit: headOid,
        comparisonKey: `revision-${baseOid}-${headOid}`,
      },
      summary: { files: [file], truncated: false },
    });
  }

  function openGitFileMenu(path = "src/history.rs"): HTMLButtonElement[] {
    const file = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel .diffs-file-jump")]
      .find(button => button.dataset.diffFilePath === path);
    if (!file) throw new Error(`Git file ${path} missing`);
    file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    return [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel .diffs-file-menu button")];
  }

  function requestGitFileFromMenu(connection: FakeConnection, label = "View this revision in Code", path = "src/history.rs") {
    const action = openGitFileMenu(path).find(button => button.textContent === label);
    if (!action) throw new Error(`${label} menu action missing`);
    action.click();
    const request = [...connection.sent].reverse().find(message => message.type === "git.file.request");
    if (!request || request.type !== "git.file.request") throw new Error("Git file request missing");
    return request;
  }

  function gitFileReply(request: Extract<ClientMessage, { type: "git.file.request" }>, text: string): Extract<ServerMessage, { type: "git.file" }> {
    return {
      type: "git.file",
      targetClientId: request.clientId,
      requestId: request.requestId,
      file: { repoRoot: request.repoRoot, commitOid: request.commitOid, path: request.path, blobOid: "c".repeat(40), text },
      error: null,
    };
  }

  function revisionText(): string {
    return [...document.querySelectorAll("#testCodePanel .code-revision-view .code-line-content")]
      .map(line => line.textContent).join("\n");
  }

  function returnToWorkingCode(): void {
    const button = [...document.querySelectorAll<HTMLButtonElement>("#testCodePanel .code-revision-view button")]
      .find(candidate => candidate.textContent === "Back to working-tree Code");
    if (!button) throw new Error("Return to working-tree Code button missing");
    button.click();
  }

  it("opens adjacent modal and revision Code actions independently without checking out or opening a workspace", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    openCommentRepo(connection, "/repo", "WORKING_TREE\n");
    answerRevisionComparison(connection);
    const menu = openGitFileMenu();
    const modalIndex = menu.findIndex(button => button.textContent === "View committed file");
    expect(modalIndex).toBeGreaterThanOrEqual(0);
    expect(menu[modalIndex + 1]?.textContent).toBe("View this revision in Code");

    connection.sent.length = 0;
    desktopMockActivatePanel.mockClear();
    const revisionRequest = requestGitFileFromMenu(connection);
    expect(document.activeElement).toBe(document.querySelector("#testCodePanel .code-revision-back"));
    expect(desktopMockActivatePanel).toHaveBeenCalledWith("code");
    expect(document.querySelector(".git-file-dialog")).toBeNull();
    expect(document.querySelector("#testCodePanel .code-revision-view")).not.toBeNull();
    expect(connection.sent).toEqual([revisionRequest]);
    expect(revisionRequest).toMatchObject({ repoRoot: "/repo", commitOid: "b".repeat(40), path: "src/history.rs" });

    const modalAction = openGitFileMenu().find(button => button.textContent === "View committed file")!;
    modalAction.click();
    expect(document.querySelector(".git-file-dialog")).not.toBeNull();

    const historical = "// Outside the selected diff hunk\nfn historical() {\n    let original = \"<not-html>\";\n}\n// End of complete file";
    connection.emit(gitFileReply(revisionRequest, historical));
    expect(revisionText()).toBe(historical);
    const modalRequest = [...connection.sent].reverse().find(message => message.type === "git.file.request");
    if (!modalRequest || modalRequest.type !== "git.file.request") throw new Error("Queued modal request missing");
    expect(modalRequest.requestId).not.toBe(revisionRequest.requestId);
    connection.emit(gitFileReply(modalRequest, "MODAL_ONLY\n"));
    expect(document.querySelector(".git-file-content")?.textContent).toBe("MODAL_ONLY\n");
    expect(revisionText()).toBe(historical);
    expect(document.querySelector("#testCodePanel .code-file-path")?.textContent).toBe("src/history.rs");
    const revision = document.querySelector("#testCodePanel .code-revision-view")!;
    expect(revision.textContent).toContain("/repo");
    expect(revision.textContent).toContain("b".repeat(12));
    expect([...revision.querySelectorAll("[title]")].some(element => element.getAttribute("title")?.includes("b".repeat(40)))).toBe(true);
    connection.emit({ type: "code.file", workspaceId: "ws-/repo", file: { path: "same.ts", language: "", text: "LATE_WORKING_TREE\n", size: 18, version: 2 } });
    connection.emit({ type: "code.workspace.ready", workspace: { workspaceId: "ws-/repo", sessionId: null, root: "/repo", source: "session", status: "filesOnly" } });
    expect(revisionText()).toBe(historical);
    expect(document.querySelector(".git-file-content")?.textContent).toBe("MODAL_ONLY\n");
  });

  it("rejects unrelated revision replies and ignores a pending reply after returning to working-tree Code", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    openCommentRepo(connection, "/repo", "WORKING_TREE\n");
    answerRevisionComparison(connection);
    const request = requestGitFileFromMenu(connection);
    const reply = gitFileReply(request, "WRONG_REVISION");
    const file = reply.file as GitFileContent;
    const unrelated: Extract<ServerMessage, { type: "git.file" }>[] = [
      { ...reply, targetClientId: "another-client" },
      { ...reply, requestId: "another-request" },
      { ...reply, file: { ...file, repoRoot: "/other" } },
      { ...reply, file: { ...file, commitOid: "d".repeat(40) } },
      { ...reply, file: { ...file, path: "src/other.rs" } },
    ];
    for (const message of unrelated) {
      connection.emit(message);
      expect(revisionText()).not.toContain("WRONG_REVISION");
    }
    connection.emit(gitFileReply(request, "CORRELATED_REVISION"));
    expect(revisionText()).toBe("CORRELATED_REVISION");
    const pending = requestGitFileFromMenu(connection);
    expect(pending.requestId).not.toBe(request.requestId);
    returnToWorkingCode();
    expect(document.querySelector("#testCodePanel .code-revision-view")).toBeNull();
    expect(document.querySelector("#testCodePanel .code-file-path")?.textContent).toBe("same.ts");
    expect(document.querySelector("#testCodePanel")?.textContent).toContain("WORKING_TREE");
    connection.emit(gitFileReply(pending, "LATE_REVISION"));
    expect(document.querySelector("#testCodePanel .code-revision-view")).toBeNull();
    expect(document.querySelector("#testCodePanel")?.textContent).not.toContain("LATE_REVISION");
    expect(document.querySelector(".git-file-dialog")).toBeNull();
  });

  it("does not resume stale working-tree navigation after returning from a revision", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    await openCodeFileForNavigation(connection);
    triggerNavAction("Go to definition");
    const definitionId = sentRequestId(connection, "code.definition");
    triggerNavAction("Find references");
    const referencesId = sentRequestId(connection, "code.references");
    answerRevisionComparison(connection);
    requestGitFileFromMenu(connection);
    returnToWorkingCode();
    connection.sent.length = 0;
    const locations: CodeLocation[] = [{ kind: "local", path: "src/stale.rs", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
    connection.emit({ type: "code.definition", workspaceId: "ws-1", requestId: definitionId, path: "src/main.rs", locations });
    connection.emit({ type: "code.references", workspaceId: "ws-1", requestId: referencesId, path: "src/main.rs", locations });
    expect(connection.sent.some(message => message.type === "code.file.open")).toBe(false);
    expect(document.querySelector("#testCodePanel")?.textContent).not.toContain("src/stale.rs");
    expect(document.querySelector("#testCodePanel")?.contains(document.activeElement)).toBe(true);
  });

  it("invalidates a pending revision in a compare-backed diff-review session", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    const a = "a".repeat(40), b = "b".repeat(40);
    const review = summary("live", { sessionMode: "diffReview", title: `diff: ${a}..${b}` });
    connection.emit({ type: "sessions.snapshot", sessions: [review] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live", { summary: review }) });
    const request = [...connection.sent].reverse().find(message => message.type === "compareDiff.request");
    if (!request || request.type !== "compareDiff.request") throw new Error("Compare-backed review request missing");
    const base = sessionChangesState("live");
    if (base.status !== "ready") throw new Error("Diff fixture missing");
    const state: Extract<ServerMessage, { type: "compareDiff.summary" }>["state"] = {
      ...base, targetClientId: request.clientId, diffId: request.diffId, refs: [],
      request: { scope: "compareDiff", clientId: request.clientId, diffId: request.diffId, repoRoot: "/repo", base: request.base, head: request.head, detailMode: "filePatch", mergeBase: false, currentCommitOid: null, selectedFile: null, contextLines: 3 },
      comparison: { ...base.comparison, base: { kind: "commit", oid: a, shortOid: a.slice(0, 12) }, head: { kind: "commit", oid: b, shortOid: b.slice(0, 12) }, leftTreeOrCommit: a, rightTreeOrCommit: b, detailMode: "filePatch" },
      summary: { files: [{ newPath: "src/history.rs", status: "modified", added: 1, removed: 1 }], truncated: false },
    };
    connection.emit({ type: "compareDiff.summary", state });
    const pending = requestGitFileFromMenu(connection);
    expect(document.querySelector(".code-revision-view")).not.toBeNull();
    connection.emit({ type: "compareDiff.summary", state: { ...state, comparison: { ...state.comparison, rightTreeOrCommit: "c".repeat(40) } } });
    connection.emit(gitFileReply(pending, "SUPERSEDED_REVIEW_SESSION"));
    expect(document.querySelector(".code-revision-view")?.textContent).not.toContain("SUPERSEDED_REVIEW_SESSION");
  });

  it("invalidates a pending revision when its originating comparison or session changes", async () => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("other")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    answerRevisionComparison(connection);
    const superseded = requestGitFileFromMenu(connection);
    desktopMockActivePanelIds.add("code");
    answerRevisionComparison(connection, undefined, "a".repeat(40), "d".repeat(40));
    connection.emit(gitFileReply(superseded, "SUPERSEDED_REVISION"));
    expect(document.querySelector("#testCodePanel")?.textContent).not.toContain("SUPERSEDED_REVISION");

    const pending = requestGitFileFromMenu(connection);
    const other = [...document.querySelectorAll<HTMLButtonElement>("#sessionsList .session-item button")]
      .find(button => button.textContent?.includes("Session other"));
    if (!other) throw new Error("Other session button missing");
    other.click();
    connection.emit({ type: "session.snapshot", sessionId: "other", state: projection("other") });
    connection.emit(gitFileReply(pending, "PREVIOUS_SESSION_REVISION"));
    expect(document.querySelector("#testCodePanel .code-revision-view")).toBeNull();
    expect(document.querySelector("#testCodePanel")?.textContent).not.toContain("PREVIOUS_SESSION_REVISION");
  });

  it.each([
    { name: "deletion base", file: { oldPath: "src/deleted.rs", newPath: "src/deleted.rs", status: "deleted", added: 0, removed: 2 }, base: "a".repeat(40), expectedOid: "a".repeat(40), expectedPath: "src/deleted.rs" },
    { name: "renamed head path", file: { oldPath: "src/old.rs", newPath: "src/renamed.rs", status: "renamed", added: 1, removed: 1 }, base: "a".repeat(40), expectedOid: "b".repeat(40), expectedPath: "src/renamed.rs" },
    { name: "initial commit head", file: { newPath: "src/initial.rs", status: "added", added: 2, removed: 0 }, base: null, expectedOid: "b".repeat(40), expectedPath: "src/initial.rs" },
  ] satisfies { name: string; file: DiffFileSummary; base: string | null; expectedOid: string; expectedPath: string }[])("opens the $name as a historical file without a checkout", async ({ file, base, expectedOid, expectedPath }) => {
    const { connection } = await createHarness({ mountCodePanel: true });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")!.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    answerRevisionComparison(connection, file, base);
    connection.sent.length = 0;
    const request = requestGitFileFromMenu(connection, "View this revision in Code", file.newPath);
    expect(request).toMatchObject({ repoRoot: "/repo", commitOid: expectedOid, path: expectedPath });
    expect(connection.sent).toEqual([request]);
    desktopMockActivePanelIds.add("code");
    connection.emit(gitFileReply(request, `fn preserved() {}\n// ${expectedPath}`));
    expect(revisionText()).toBe(`fn preserved() {}\n// ${expectedPath}`);
    expect(document.querySelector("#testCodePanel .code-file-path")?.textContent).toBe(expectedPath);
    expect(document.querySelector("#testCodePanel .code-revision-view")?.textContent).toContain(expectedOid.slice(0, 12));
    expect(document.querySelector(".git-file-dialog")).toBeNull();
  });

  it("keeps group patches and comments separate and refreshes the chosen group without loops", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    expect(latestGitRequest(connection).changeKind).toBe("unstaged");
    const unstaged = answerGitRequest(connection, "unstaged-v1");
    const patch = "diff --git a/same.ts b/same.ts\n@@ -1 +1 @@\n-old\n+unstaged-only";
    const content = {
      targetClientId: unstaged.clientId, diffId: unstaged.diffId, scope: "sessionChanges" as const,
      comparisonKey: "unstaged-v1", file: null, patch, rows: simpleDiffRows(patch), truncated: false, contextLines: 3, generatedAt: "now",
    };
    connection.emit({ type: "diff.content", content });
    connection.emit({ type: "review.comments.snapshot", sessionId: "live", comments: [{
      id: "unstaged-note", sessionId: "live", repoRoot: "/repo", comparisonKey: "unstaged-v1", author: "user",
      body: "Only applies to unstaged version", stale: false, createdAt: "now", updatedAt: "now",
      anchor: { oldPath: "same.ts", newPath: "same.ts", hunk: "@@ -1 +1 @@", side: "right", kind: "add", newLine: 1, text: "+unstaged-only" },
    }] });
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("Only applies to unstaged version");
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("unstaged-only");
    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="same.ts"]')?.click();
    const group = document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-group-select");
    if (!group) throw new Error("Git group missing");
    group.value = "staged";
    group.dispatchEvent(new Event("change"));
    expect(latestGitRequest(connection)).toMatchObject({ changeKind: "staged", repoId: "/repo" });
    const staged = answerGitRequest(connection, "staged-v1");
    expect(document.querySelector("#testDiffPanel .diffs-file-jump.active")?.getAttribute("data-diff-file-path")).toBe("same.ts");
    expect(connection.sent).toContainEqual(expect.objectContaining({ type: "diff.content.request", comparisonKey: "staged-v1", selectedFile: { oldPath: null, newPath: "same.ts" } }));
    connection.emit({ type: "diff.content", content });
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).not.toContain("unstaged-only");
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).not.toContain("Only applies to unstaged version");
    expect([...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")].find(button => button.textContent === "Code")?.disabled).toBe(true);
    expect(document.querySelector("#testDiffPanel .diff-commit-select")).toBeNull();
    connection.sent.length = 0;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(connection.sent.filter(message => message.type === "sessionChanges.request")).toHaveLength(1);
    expect(latestGitRequest(connection)).toMatchObject({ changeKind: "staged", repoId: "/repo" });
    expect(latestGitRequest(connection).diffId).not.toBe(staged.diffId);
    answerGitRequest(connection, "staged-v2");
    const count = connection.sent.filter(message => message.type === "sessionChanges.request").length;
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    expect(connection.sent.filter(message => message.type === "sessionChanges.request")).toHaveLength(count);
  });

  it("keeps repository actions open when the initial Git summary arrives", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const optionsSummary = document.querySelector<HTMLElement>("#testDiffPanel .git-review-options > summary")!;
    optionsSummary.focus();
    optionsSummary.click();
    answerGitRequest(connection, "repo-v1");
    expect(document.querySelector<HTMLDetailsElement>("#testDiffPanel .git-review-options")?.open).toBe(true);
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector<HTMLDetailsElement>("#testDiffPanel .git-review-options")?.open).toBe(false);
    document.querySelector<HTMLElement>("#testDiffPanel .git-review-options > summary")!.click();
    vi.spyOn(window, "prompt").mockReturnValue("/new");
    clickGitButton("Add");
    expect(connection.sent).toContainEqual({ type: "sessionRepos.update", sessionId: "live", action: "add", path: "/new" });
    expect(document.querySelector<HTMLDetailsElement>("#testDiffPanel .git-review-options")?.open).toBe(false);
  });

  it("keeps explicit repository selection when discovery adds a default and reloads durable corrections", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const repos = [
      { id: "/repo", repoRoot: "/repo", label: "repo", source: "cwd" as const, isDefault: true },
      { id: "/other", repoRoot: "/other", label: "other", source: "manual" as const, isDefault: false },
    ];
    answerGitRequest(connection, "repo-v1", { repos });
    const select = document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-repo-select");
    if (!select) throw new Error("Repository selector missing");
    select.value = "/other";
    select.dispatchEvent(new Event("change"));
    answerGitRequest(connection, "other-v1", { repos, selectedRepoId: "/other" });
    vi.spyOn(window, "prompt").mockReturnValue("/new");
    clickGitButton("Add");
    expect(connection.sent).toContainEqual({ type: "sessionRepos.update", sessionId: "live", action: "add", path: "/new" });
    connection.sent.length = 0;
    connection.emit({ type: "session.notice", sessionId: "live", level: "info", text: "Unrelated notice" });
    expect(connection.sent.filter(message => message.type === "sessionChanges.request")).toHaveLength(0);
    connection.emit({ type: "session.notice", sessionId: "live", level: "info", text: "Git repositories updated: add /new" });
    expect(latestGitRequest(connection).repoId).toBe("/other");
    answerGitRequest(connection, "other-v2", {
      repos: [...repos.map(repo => ({ ...repo, isDefault: false })), { id: "/new", repoRoot: "/new", label: "new", source: "additionalDirectory", isDefault: true }],
      selectedRepoId: "/other",
    });
    expect(document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-repo-select")?.value).toBe("/other");
    clickGitButton("Set default");
    expect(connection.sent).toContainEqual({ type: "sessionRepos.update", sessionId: "live", action: "default", path: "/other" });
    connection.emit({ type: "session.notice", sessionId: "live", level: "info", text: "Git repositories updated: default /other" });
    expect(latestGitRequest(connection).repoId).toBe("/other");
    answerGitRequest(connection, "other-v3", { repos, selectedRepoId: "/other" });
    clickGitButton("Hide selected");
    expect(connection.sent).toContainEqual({ type: "sessionRepos.update", sessionId: "live", action: "hide", path: "/other" });
    connection.emit({ type: "session.notice", sessionId: "live", level: "info", text: "Git repositories updated: hide /other" });
    expect(latestGitRequest(connection).repoId).toBeNull();
  });
  it("does not rerender the diff panel for transcript-only session snapshots", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("other")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: " src/main.ts | 2 +-\n", truncated: false },
      },
    });

    const diffRoot = document.querySelector<HTMLElement>("#testDiffPanel .diffs-view");
    const diffMain = document.querySelector<HTMLElement>("#testDiffPanel .diffs-main");
    if (!diffRoot || !diffMain) throw new Error("diff panel missing");
    diffMain.scrollTop = 42;

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [{
          kind: "message",
          id: "assistant-1",
          role: "assistant",
          blocks: [{ kind: "text", text: "new transcript output" }],
          timestamp: null,
          isNew: true,
          renderHash: "test-main.test-653",
        }],
      }),
    });
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-view")).toBe(diffRoot);
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-main")).toBe(diffMain);
    expect(diffMain.scrollTop).toBe(42);

    connection.emit({
      type: "session.snapshot",
      sessionId: "other",
      state: projection("other", {
        transcript: [{
          kind: "message",
          id: "assistant-other",
          role: "assistant",
          blocks: [{ kind: "text", text: "other session output" }],
          timestamp: null,
          isNew: true,
          renderHash: "test-main.test-671",
        }],
      }),
    });
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-view")).toBe(diffRoot);
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-main")).toBe(diffMain);
    expect(diffMain.scrollTop).toBe(42);
  });

  it("keeps final transcript message controls stable across changing snapshots", async () => {
    const { connection } = await createHarness();
    const transcript = [{
      kind: "message" as const,
      id: "assistant-1",
      role: "assistant" as const,
      blocks: [{ kind: "text" as const, text: "copyable answer" }],
      timestamp: null,
      isNew: false,
      renderHash: "test-main.test-688",
    }];

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live", { transcript }) });
    const copyButton = document.querySelector<HTMLButtonElement>('#testTranscriptPanel [data-message-id="assistant-1"] .message-actions button');
    if (!copyButton) throw new Error("copy button missing");
    const transcriptPanel = document.querySelector<HTMLElement>("#testTranscriptPanel");
    if (!transcriptPanel) throw new Error("transcript panel missing");
    const replaceChildren = vi.spyOn(transcriptPanel, "replaceChildren");

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript,
        tokensTotal: 12,
      }),
    });
    expect(document.querySelector<HTMLButtonElement>('#testTranscriptPanel [data-message-id="assistant-1"] .message-actions button')).toBe(copyButton);
    expect(replaceChildren).not.toHaveBeenCalled();

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [{
          ...transcript[0],
          blocks: [{ kind: "text" as const, text: "copyable answer updated" }],
          renderHash: "updated-answer",
        }],
      }),
    });
    const updatedButton = document.querySelector<HTMLButtonElement>('#testTranscriptPanel [data-message-id="assistant-1"] .message-actions button');
    expect(updatedButton).toBe(copyButton);
    expect(document.querySelector<HTMLElement>('#testTranscriptPanel [data-message-id="assistant-1"]')?.textContent).toContain("copyable answer updated");
  });

  it("applies desktop session deltas to an existing projection", async () => {
    const { connection } = await createHarness();
    const baseTranscript = [{
      kind: "message" as const,
      id: "assistant-1",
      role: "assistant" as const,
      blocks: [{ kind: "text" as const, text: "first answer" }],
      timestamp: null,
      isNew: false,
      renderHash: "test-main.test-733",
    }];
    const appended = {
      kind: "message" as const,
      id: "assistant-2",
      role: "assistant" as const,
      blocks: [{ kind: "text" as const, text: "delta answer" }],
      timestamp: null,
      isNew: true,
      renderHash: "test-main.test-741",
    };

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { transcript: baseTranscript }),
    });
    connection.sent.length = 0;

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live", { messageCount: 2 }),
        transcriptReplaceFrom: 1,
        baseSeq: 0,
        seq: 1,
        transcriptAppend: [appended],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });

    expect(document.querySelector<HTMLElement>('#testTranscriptPanel [data-message-id="assistant-1"]')?.textContent).toContain("first answer");
    expect(document.querySelector<HTMLElement>('#testTranscriptPanel [data-message-id="assistant-2"]')?.textContent).toContain("delta answer");
    expect(connection.sent).not.toContainEqual({ type: "state.refresh", sessionId: "live" });
  });

  it("reuses unchanged tool-card DOM from session delta tails", async () => {
    const { connection } = await createHarness();
    const stableTool = {
      kind: "tool" as const,
      toolCallId: "tool-stable",
      toolName: "bash",
      args: { command: "echo stable" },
      isActive: false,
      isError: false,
      result: { text: "stable result" },
      renderHash: "stable-hash",
    };

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [{
          kind: "tool",
          toolCallId: "tool-changing",
          toolName: "bash",
          args: { command: "echo old" },
          isActive: true,
          isError: false,
          partialResult: { text: "old partial" },
          renderHash: "changing-old",
        }, stableTool],
      }),
    });
    const initialCards = document.querySelectorAll<HTMLElement>("#testTranscriptPanel .tool-card");
    const changingCard = initialCards[0];
    const stableCard = initialCards[1];
    if (!changingCard || !stableCard) throw new Error("tool cards missing");

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live"),
        transcriptReplaceFrom: 0,
        baseSeq: 0,
        seq: 1,
        transcriptAppend: [{
          kind: "tool",
          toolCallId: "tool-changing",
          toolName: "bash",
          args: { command: "echo old" },
          isActive: false,
          isError: false,
          result: { text: "new final" },
          renderHash: "changing-new",
        }, stableTool],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });

    const updatedCards = document.querySelectorAll<HTMLElement>("#testTranscriptPanel .tool-card");
    expect(updatedCards[0]).not.toBe(changingCard);
    expect(updatedCards[0]?.textContent).toContain("new final");
    expect(updatedCards[1]).toBe(stableCard);
  });

  it("updates desktop tool-card DOM structurally when renderHash is absent", async () => {
    const { connection } = await createHarness();
    const legacyTool = {
      kind: "tool" as const,
      toolCallId: "tool-legacy",
      toolName: "bash",
      args: { command: "echo legacy" },
      isActive: true,
      isError: false,
      partialResult: { text: "old partial" },
    };

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { transcript: [legacyTool] }),
    });
    const initialCard = document.querySelector<HTMLElement>("#testTranscriptPanel .tool-card");
    if (!initialCard) throw new Error("tool card missing");

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live"),
        transcriptReplaceFrom: 0,
        baseSeq: 0,
        seq: 1,
        transcriptAppend: [{
          ...legacyTool,
          isActive: false,
          partialResult: undefined,
          result: { text: "new final" },
        }],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });

    const updatedCard = document.querySelector<HTMLElement>("#testTranscriptPanel .tool-card");
    expect(updatedCard).not.toBe(initialCard);
    expect(updatedCard?.textContent).toContain("new final");
  });

  it("does not group image-bearing desktop read cards", async () => {
    const { connection } = await createHarness();
    const imageRead = {
      kind: "tool" as const,
      toolCallId: "read-image",
      toolName: "read",
      args: { path: "/tmp/image.png" },
      isActive: false,
      isError: false,
      result: { content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
      renderHash: "read-image-hash",
    };
    const textRead = {
      kind: "tool" as const,
      toolCallId: "read-text",
      toolName: "read",
      args: { path: "/tmp/file.txt" },
      isActive: false,
      isError: false,
      result: { text: "file contents" },
      renderHash: "read-text-hash",
    };

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { transcript: [imageRead, textRead] }),
    });

    const cards = document.querySelectorAll<HTMLElement>("#testTranscriptPanel .read-tool-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.classList.contains("read-tool-group")).toBe(false);
    expect(cards[0]?.querySelector(".tool-image-grid img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(cards[1]?.classList.contains("tool-compact")).toBe(true);
  });

  it("keeps the review card visible after the task card is hidden by Tools: off", async () => {
    const { connection } = await createHarness();
    const reviewTask = {
      kind: "tool" as const,
      toolCallId: "task-review",
      toolName: "task",
      args: { agent: "reviewer" },
      isActive: false,
      isError: false,
      result: { details: { results: [{ agent: "reviewer", output: "done" }] } },
      renderHash: "task-review-hash",
    };
    const reviewCard = {
      kind: "review" as const,
      toolCallId: "task-review",
      timestamp: null,
      isActive: false,
      verdicts: [{ overallCorrectness: "incorrect" as const, explanation: "Auth bug.", confidence: 0.9 }],
      findings: [{
        title: "Validate token",
        body: "Empty token authenticates.",
        priority: "P0" as const,
        confidence: 0.9,
        filePath: "src/auth.rs",
        lineStart: 12,
        lineEnd: 12,
      }],
      renderHash: "review-card-hash",
    };

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { transcript: [reviewTask, reviewCard] }),
    });

    const panel = "#testTranscriptPanel";
    expect(document.querySelector(`${panel} .tool-card[data-tool-name="task"]`)).not.toBeNull();
    expect(document.querySelector(`${panel} .review-card`)).not.toBeNull();
    expect(document.querySelector(`${panel} .review-finding-title`)?.textContent).toBe("Validate token");

    // Hiding tool bubbles must not hide the review deliverable.
    document.querySelector<HTMLButtonElement>("#toolVisibilityToggle")?.click();
    expect(connection.sent).toContainEqual({ type: "config.set", showTools: false });
    expect(document.querySelector(`${panel} .tool-card[data-tool-name="task"]`)).toBeNull();
    expect(document.querySelector(`${panel} .review-card`)).not.toBeNull();
    expect(document.querySelector(`${panel} .review-finding-title`)?.textContent).toBe("Validate token");
  });

  it("keeps edit diffs in the desktop transcript when ordinary tool bubbles are hidden", async () => {
    const { connection } = await createHarness();
    const diff = [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
    ].join("\n");

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [
          {
            kind: "tool",
            toolCallId: "bash-1",
            toolName: "bash",
            args: {},
            isActive: false,
            isError: false,
            renderHash: "bash-1-hash",
          },
          {
            kind: "tool",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/main.ts" },
            isActive: false,
            isError: false,
            result: { details: { diff } },
            renderHash: "edit-1-hash",
          },
        ],
      }),
    });

    const panel = "#testTranscriptPanel";
    expect(document.querySelector(`${panel} .tool-card[data-tool-name="bash"]`)).not.toBeNull();
    expect(document.querySelector(`${panel} .edit-diff-preview`)?.textContent).toContain("+const value = 2;");

    document.querySelector<HTMLButtonElement>("#toolVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", showTools: false });
    expect(document.querySelector(`${panel} .tool-card[data-tool-name="bash"]`)).toBeNull();
    expect(document.querySelector(`${panel} .edit-diff-preview`)?.textContent).toContain("+const value = 2;");

    document.querySelector<HTMLButtonElement>("#editDiffVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", showEditDiffs: false });
    expect(document.querySelector(`${panel} .edit-tool-card`)).toBeNull();
  });

  it("requests state refresh for desktop session deltas without a base projection", async () => {
    const { connection } = await createHarness();
    connection.sent.length = 0;

    connection.emit({
      type: "session.delta",
      sessionId: "missing",
      state: {
        summary: summary("missing", { messageCount: 1 }),
        transcriptReplaceFrom: 0,
        baseSeq: 0,
        seq: 1,
        transcriptAppend: [{
          kind: "message",
          id: "assistant-1",
          role: "assistant",
          blocks: [{ kind: "text", text: "orphan delta" }],
          timestamp: null,
          isNew: true,
          renderHash: "test-main.test-851",
        }],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });

    expect(connection.sent).toContainEqual({ type: "state.refresh", sessionId: "missing" });
  });

  it("re-requests a fresh snapshot for tracked sessions after reconnect", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    connection.sent.length = 0;
    // Simulate a WebSocket reconnect: the coordinator re-fires onOpen.
    connection.options.onOpen?.();
    // Refresh is deferred until the fresh session list arrives, so held
    // projections for pruned sessions are not blindly re-requested.
    expect(connection.sent).toContainEqual({ type: "session.list" });
    expect(connection.sent).not.toContainEqual({ type: "state.refresh", sessionId: "live" });

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    expect(connection.sent).toContainEqual({ type: "state.refresh", sessionId: "live" });
  });

  it("duplicates from the cog menu and activates only the correlated result", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    expect(document.querySelector("#btwButton")).toBeNull();
    document.querySelector<HTMLButtonElement>("#workspaceOptionsToggle")?.click();
    const duplicateButton = document.querySelector<HTMLButtonElement>("#workspaceOptionsMenu #duplicateSessionButton");
    if (!duplicateButton) throw new Error("duplicate session action missing");
    duplicateButton.click();

    const request = connection.sent.find(message => message.type === "session.fork");
    if (!request || request.type !== "session.fork") throw new Error("session fork request missing");
    expect(request.sessionId).toBe("live");
    expect(request.requestId).toMatch(/^session-fork-/);
    expect(duplicateButton.disabled).toBe(true);
    expect(duplicateButton.textContent).toBe("Duplicating…");

    const copiedSummary = summary("copy", { title: "Session live copy 2" });
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), copiedSummary] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "copy",
      state: projection("copy", { summary: copiedSummary }),
    });
    connection.emit({
      type: "session.forked",
      requestId: "unrelated-request",
      sourceSessionId: "live",
      sessionId: "copy",
    });
    expect(document.querySelector("#sessionTitle")?.textContent).toBe("Session live");

    connection.emit({
      type: "session.forked",
      requestId: request.requestId,
      sourceSessionId: "live",
      sessionId: "copy",
    });
    expect(document.querySelector("#sessionTitle")?.textContent).toBe("Session live copy 2");
    expect(duplicateButton.disabled).toBe(false);
    expect(duplicateButton.textContent).toBe("Duplicate chat");
  });

  it("drops projections and cached notices for sessions absent from a reconnect snapshot", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("gone")] });
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    connection.emit({ type: "session.snapshot", sessionId: "gone", state: projection("gone") });
    connection.emit({ type: "session.notice", sessionId: "gone", level: "warning", text: "stale gone notice" });

    connection.sent.length = 0;
    connection.options.onOpen?.();
    // Bridge pruned "gone" (its session file was deleted); it is absent from the snapshot.
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });

    expect(connection.sent).toContainEqual({ type: "state.refresh", sessionId: "live" });
    expect(connection.sent).not.toContainEqual({ type: "state.refresh", sessionId: "gone" });

    // Reusing the id must not resurrect client-only state from the pruned session.
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("gone")] });
    const goneButton = [...document.querySelectorAll<HTMLButtonElement>("#sessionsList .session-item button")]
      .find(button => button.textContent?.includes("Session gone"));
    if (!goneButton) throw new Error("gone session button missing");
    goneButton.click();
    connection.emit({ type: "session.snapshot", sessionId: "gone", state: projection("gone") });
    expect(document.querySelector("#testTranscriptPanel")?.textContent).not.toContain("stale gone notice");
  });

  it("renders aggregate patch by default and drills down without refetching all files", async () => {
    const { connection } = await createHarness();
    const aggregatePatch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const a = 'old';",
      "+export const a = 'new a';",
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 'old';",
      "+export const b = 'new b';",
    ].join("\n");
    const singlePatch = [
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 'old';",
      "+export const b = 'single b';",
    ].join("\n");
    const singlePatchRows: DiffRow[] = [
      { type: "file", text: "diff --git a/src/b.ts b/src/b.ts", oldPath: "src/b.ts", newPath: "src/b.ts", filePath: "src/b.ts" },
      { type: "hunk", text: "@@ -1 +1 @@", oldPath: "src/b.ts", newPath: "src/b.ts", filePath: "src/b.ts", hunk: "@@ -1 +1 @@" },
      { type: "line", prefix: "-", location: { oldPath: "src/b.ts", newPath: "src/b.ts", hunk: "@@ -1 +1 @@", side: "left", kind: "remove", oldLine: 1, text: "-export const b = 'old';" } },
      { type: "line", prefix: "+", location: { oldPath: "src/b.ts", newPath: "src/b.ts", hunk: "@@ -1 +1 @@", side: "right", kind: "add", newLine: 1, text: "+export const b = 'single b';" } },
    ];
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.sent.length = 0;
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: null, contextLines: 3 },
        summary: {
          files: [
            { oldPath: null, newPath: "src/a.ts", status: "modified", added: 1, removed: 1 },
            { oldPath: null, newPath: "src/b.ts", status: "modified", added: 1, removed: 1 },
          ],
          stat: null,
          truncated: false,
        },
      },
    });
    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "diff.content.request",
      scope: "sessionChanges",
      selectedFile: null,
    }));
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: null,
        patch: aggregatePatch,
        truncated: false,
        rows: simpleDiffRows(aggregatePatch),
        contextLines: 3,
        generatedAt: "now",
      },
    });

    expect(document.querySelector<HTMLButtonElement>("#testDiffPanel .diffs-all-files-jump")?.classList.contains("active")).toBe(true);
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("new a");
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("new b");
    expect(connection.sent.some(message => message.type === "sessionChanges.request" && message.selectedFile)).toBe(false);

    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="src/b.ts"]')?.click();
    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "diff.content.request",
      selectedFile: { oldPath: null, newPath: "src/b.ts" },
    }));
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/b.ts" },
        patch: singlePatch,
        truncated: false,
        rows: singlePatchRows,
        contextLines: 3,
        generatedAt: "now",
      },
    });
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).not.toContain("new a");
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("single b");

    const contextButton = document.querySelector<HTMLButtonElement>("#testDiffPanel .diff-context-more");

    connection.sent.length = 0;
    contextButton?.click();
    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "diff.content.request",
      selectedFile: { oldPath: null, newPath: "src/b.ts" },
      contextLines: 13,
    }));
    connection.sent.length = 0;
    document.querySelector<HTMLButtonElement>("#testDiffPanel .diffs-all-files-jump")?.click();
    expect(document.querySelector<HTMLButtonElement>("#testDiffPanel .diffs-all-files-jump")?.classList.contains("active")).toBe(true);
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("new a");
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("new b");
    expect(connection.sent.some(message => message.type === "sessionChanges.request")).toBe(false);
  });



  it("refreshes Git changes with the current repo, mode, and group", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        selectedRepoId: "repo-2",
        request: { ...baseState.request, scope: "sessionChanges", sessionId: "live", clientId: request.clientId, diffId: request.diffId, detailMode: "filePatch", changeKind: "staged" },
        comparison: { ...baseState.comparison, detailMode: "filePatch", head: { kind: "index" } },
      },
    });
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: null,
        patch: "diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old\n+cached",
        truncated: false,
        rows: simpleDiffRows("diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-old\n+cached"),
        contextLines: 3,
        generatedAt: "now",
      },
    });
    connection.sent.length = 0;

    const refreshButton = document.querySelector<HTMLButtonElement>('#testDiffPanel button[aria-label="Refresh"]');
    expect(refreshButton?.disabled).toBe(false);
    refreshButton?.click();

    const refreshRequest = connection.sent.find(message => message.type === "sessionChanges.request");
    expect(refreshRequest).toEqual(expect.objectContaining({
      type: "sessionChanges.request",
      repoId: "repo-2",
      detailMode: "filePatch",
      changeKind: "staged",
      currentCommitOid: null,
      selectedFile: null,
    }));
    if (!refreshRequest || refreshRequest.type !== "sessionChanges.request") throw new Error("refresh request missing");
    connection.sent.length = 0;
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: refreshRequest.clientId,
        diffId: refreshRequest.diffId,
        selectedRepoId: "repo-2",
        request: { ...baseState.request, scope: "sessionChanges", sessionId: "live", clientId: refreshRequest.clientId, diffId: refreshRequest.diffId, detailMode: "filePatch", changeKind: "staged" },
        comparison: { ...baseState.comparison, detailMode: "filePatch", head: { kind: "index" } },
      },
    });
    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "diff.content.request",
      selectedFile: null,
    }));
  });

  it("sends edited Diffs question preview text", async () => {
    const { connection } = await createHarness();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Should this become a helper?");
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "@@ -1 +1 @@",
      "-console.log('old')",
      "+console.log('new')",
    ].join("\n");
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
      },
    });
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/main.ts" },
        patch,
        truncated: false,
        rows: simpleDiffRows(patch),
        contextLines: 3,
        generatedAt: "now",
      },
    });

    document.querySelector<HTMLButtonElement>("#testDiffPanel .diff-question-btn")?.click();
    expect(prompt).toHaveBeenCalledWith("Ask the agent about this diff line");
    [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Preview questions (1)")
      ?.click();

    const preview = document.querySelector<HTMLTextAreaElement>("#diffPreviewText");
    expect(preview?.readOnly).toBe(false);
    expect(preview?.value).toContain("request for an implementation change");
    if (!preview) throw new Error("diff preview missing");
    preview.value = "Please extract the repeated console logging into a helper.";
    document.querySelector<HTMLButtonElement>("#diffPreviewSend")?.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "prompt.send",
      sessionId: "live",
      text: "Please extract the repeated console logging into a helper.",
    }));
  });

  it("creates persisted Diffs comments anchored to the clicked diff line", async () => {
    const { connection } = await createHarness();
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "@@ -1 +1 @@",
      "-console.log('old')",
      "+console.log('new')",
    ].join("\n");
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
      },
    });
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/main.ts" },
        patch,
        truncated: false,
        rows: simpleDiffRows(patch),
        contextLines: 3,
        generatedAt: "now",
      },
    });
    const addedLine = [...document.querySelectorAll<HTMLElement>("#testDiffPanel .diff-line-wrap")]
      .find(line => line.textContent?.includes("+console.log('new')"));
    if (!addedLine) throw new Error("added diff line missing");
    expect(addedLine.querySelector(".hljs-string.diff-intraline-add")?.textContent).toBe("new");
    addedLine.querySelector<HTMLButtonElement>(".diff-comment-btn")?.click();
    const composer = document.querySelector<HTMLFormElement>("#testDiffPanel .review-comment-composer-create");
    const textarea = composer?.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer || !textarea) throw new Error("comment composer missing");
    textarea.value = "Use structured logging here.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    composer.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "review.comment.create",
      sessionId: "live",
      repoRoot: "/repo",
      comparisonKey: "key",
      body: "Use structured logging here.",
      anchor: expect.objectContaining({
        oldPath: "src/main.ts",
        newPath: "src/main.ts",
        side: "right",
        kind: "add",
        newLine: 1,
        text: "+console.log('new')",
      }),
    }));
  });


  it("previews and sends persisted Diffs comments to the agent", async () => {
    const { connection } = await createHarness();
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "@@ -1 +1 @@",
      "-console.log('old')",
      "+console.log('new')",
    ].join("\n");
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
      },
    });
    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/main.ts" },
        patch,
        truncated: false,
        rows: simpleDiffRows(patch),
        contextLines: 3,
        generatedAt: "now",
      },
    });
    const persisted: ReviewComment = {
      id: "comment-1",
      sessionId: "live",
      repoRoot: "/repo",
      comparisonKey: "key",
      author: "user",
      body: "Please avoid raw console logging here.",
      stale: false,
      staleReason: null,
      anchor: {
        oldPath: "src/main.ts",
        newPath: "src/main.ts",
        hunk: "@@ -1 +1 @@",
        side: "right",
        kind: "add",
        oldLine: null,
        newLine: 1,
        text: "+console.log('new')",
      },
      createdAt: "now",
      updatedAt: "now",
    };
    connection.emit({ type: "review.comments.snapshot", sessionId: "live", comments: [persisted] });

    [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Preview comments (1)")
      ?.click();

    const preview = document.querySelector<HTMLTextAreaElement>("#diffPreviewText");
    expect(preview?.value.split("\n")[0]).toBe("I have read the code and have some comments please read them and address them");
    expect(preview?.value).toContain("File: src/main.ts");
    expect(preview?.value).toContain("Comment: Please avoid raw console logging here.");
    if (!preview) throw new Error("diff preview missing");
    preview.value = "Please replace the raw console logging.";
    document.querySelector<HTMLButtonElement>("#diffPreviewSend")?.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "prompt.send",
      sessionId: "live",
      text: "Please replace the raw console logging.",
    }));
    expect(connection.sent).toContainEqual({
      type: "review.comment.markFlushed",
      comments: [{ id: "comment-1", updatedAt: "now" }],
    });
    expect([...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .some(button => button.textContent === "Preview comments (1)")).toBe(false);
    expect(document.querySelector("#testDiffPanel")?.textContent).toContain("flushed");

    const reloaded = await createHarness({ preserveLocalStorage: true });
    reloaded.connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    reloaded.connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const reloadRequest = reloaded.connection.sent.find(message => message.type === "sessionChanges.request");
    if (!reloadRequest || reloadRequest.type !== "sessionChanges.request") throw new Error("reloaded session changes request missing");
    reloaded.connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: reloadRequest.clientId,
        diffId: reloadRequest.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: reloadRequest.clientId, diffId: reloadRequest.diffId, sessionId: "live", repoId: reloadRequest.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
      },
    });
    reloaded.connection.emit({ type: "review.comments.snapshot", sessionId: "live", comments: [{ ...persisted, flushedAt: "flushed" }] });
    expect([...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .some(button => button.textContent === "Preview comments (1)")).toBe(false);
  });
  it("keeps the diff file list mounted when selecting another file", async () => {
    const { connection } = await createHarness();
    const secondPatch = [
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const value = 'old b';",
      "+export const value = 'new b';",
    ].join("\n");
    const secondPatchRows = simpleDiffRows(secondPatch);
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...baseState,
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", changeKind: "unstaged", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: null, contextLines: 3 },
        summary: {
          files: [
            { oldPath: null, newPath: "src/a.ts", status: "modified", added: 1, removed: 1 },
            { oldPath: null, newPath: "src/b.ts", status: "modified", added: 1, removed: 1 },
          ],
          stat: null,
          truncated: false,
        },
      },
    });

    const sidebar = document.querySelector<HTMLElement>("#testDiffPanel .diffs-sidebar-scroll");
    const main = document.querySelector<HTMLElement>("#testDiffPanel .diffs-main");
    if (!sidebar || !main) throw new Error("diff layout missing");
    sidebar.scrollTop = 77;
    const fileButtons = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel .diffs-file-jump[data-diff-file-path]")];
    expect(fileButtons.map(button => button.dataset.diffFilePath)).toEqual(["src/a.ts", "src/b.ts"]);

    fileButtons[1]?.click();

    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-sidebar-scroll")).toBe(sidebar);
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-main")).toBe(main);
    expect(sidebar.scrollTop).toBe(77);
    expect(fileButtons[1]?.classList.contains("active")).toBe(true);
    expect(connection.sent.some(message =>
      message.type === "diff.content.request" &&
      message.selectedFile?.newPath === "src/b.ts"
    )).toBe(true);

    connection.emit({
      type: "diff.content",
      content: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/b.ts" },
        patch: secondPatch,
        truncated: false,
        rows: secondPatchRows,
        contextLines: 3,
        generatedAt: "now",
      },
    });

    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-sidebar-scroll")).toBe(sidebar);
    expect(sidebar.scrollTop).toBe(77);
    expect(document.querySelector("#testDiffPanel .diffs-main")?.textContent).toContain("new b");
  });

  it("preserves transcript scroll and cached bubbles while entering transcript review", async () => {
    const { connection } = await createHarness();
    const transcriptPanels = [...document.querySelectorAll<HTMLElement>("#testTranscriptPanel")];
    if (transcriptPanels.length === 0) throw new Error("transcript panel missing");
    for (const panel of transcriptPanels) {
      Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(panel, "clientHeight", { configurable: true, value: 200 });
      const replaceChildren = panel.replaceChildren.bind(panel);
      panel.replaceChildren = (...nodes: Parameters<HTMLElement["replaceChildren"]>) => {
        replaceChildren(...nodes);
        panel.scrollTop = 0;
      };
    }

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [0, 1, 2].map(index => ({
          kind: "message",
          id: `message-${index}`,
          role: "assistant",
          blocks: [{ kind: "text", text: `line ${index}` }],
          timestamp: null,
          isNew: false,
          renderHash: "test-main.test-1498",
        })),
      }),
    });
    const transcriptPanel = transcriptPanels.find(panel => panel.querySelector('[data-message-id="message-1"]'));
    if (!transcriptPanel) throw new Error(`rendered transcript panel missing: ${transcriptPanels.map(panel => panel.textContent).join(" | ")}`);
    transcriptPanel.scrollTop = 320;
    const untouchedBubble = transcriptPanel.querySelector<HTMLElement>('[data-message-id="message-1"]');

    transcriptPanel.querySelector<HTMLButtonElement>('[data-message-id="message-0"] .message-review-toggle')?.click();

    expect(transcriptPanel.scrollTop).toBe(320);
    expect(transcriptPanel.querySelector('[data-message-id="message-0"] .transcript-review-body')).toBeTruthy();
    expect(transcriptPanel.querySelector<HTMLElement>('[data-message-id="message-1"]')).toBe(untouchedBubble);
  });

});

describe("desktop compaction indicator", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("surfaces a compaction indicator and locks the composer while compacting", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { isBusy: true, compacting: true }),
    });

    expect(document.querySelector("#statusBar .status-part.compacting")?.textContent).toContain("Compacting");
    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    expect(input?.disabled).toBe(true);
    expect(input?.placeholder).toContain("Compacting");
    expect(document.querySelector<HTMLButtonElement>("#sendButton")?.disabled).toBe(true);

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { isBusy: false, compacting: false }),
    });

    expect(document.querySelector("#statusBar .status-part.compacting")).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("#promptInput")?.disabled).toBe(false);
  });

  it("sends live OMP slash commands while the session is busy", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", {
        isBusy: true,
        summary: summary("busy", { status: "busy", title: "Busy" }),
        availableCommands: [
          { name: "prewalk", aliases: ["pw"], subcommands: [], source: "builtin", description: "Prewalk" },
        ],
      }),
    });

    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    const form = document.querySelector<HTMLFormElement>("#promptForm");
    if (!input || !form) throw new Error("composer missing");
    connection.sent.length = 0;
    input.value = "/prewalk next";
    form.requestSubmit();

    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "busy",
      text: "/prewalk next",
    });
    expect(document.querySelector<HTMLElement>("#busyPromptOverlay")?.hidden).toBe(true);
  });

  it("rejects live prompt-template commands while the session is busy", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", {
        isBusy: true,
        summary: summary("busy", { status: "busy", title: "Busy" }),
        availableCommands: [
          { name: "deploy", aliases: [], subcommands: [], source: "file", description: "Deploy" },
        ],
      }),
    });

    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    const form = document.querySelector<HTMLFormElement>("#promptForm");
    if (!input || !form) throw new Error("composer missing");
    connection.sent.length = 0;
    input.value = "/deploy";
    form.requestSubmit();

    expect(connection.sent.some(message => message.type === "prompt.send")).toBe(false);
    expect(input.value).toBe("/deploy");
    expect(document.querySelector("#testTranscriptPanel")?.textContent).toContain(
      "Slash commands cannot be sent as steer or follow-up prompts while the agent is busy.",
    );
  });

  it("hides the busy-prompt choice and blocks steer/follow-up while compacting", async () => {
    const { connection } = await createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy" }) }),
    });

    const input = document.querySelector<HTMLTextAreaElement>("#promptInput");
    const form = document.querySelector<HTMLFormElement>("#promptForm");
    if (!input || !form) throw new Error("composer missing");
    input.value = "steer this";
    form.requestSubmit();
    expect(document.querySelector<HTMLElement>("#busyPromptOverlay")?.hidden).toBe(false);

    // Another client compacts the shared session.
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, compacting: true, summary: summary("busy", { status: "busy", title: "Busy" }) }),
    });
    expect(document.querySelector<HTMLElement>("#busyPromptOverlay")?.hidden).toBe(true);

    connection.sent.length = 0;
    document.querySelector<HTMLButtonElement>("#busyPromptFollowUp")?.click();
    expect(connection.sent.some(message => message.type === "prompt.send")).toBe(false);
  });
});
