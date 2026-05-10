import { beforeEach, describe, expect, it, vi } from "vitest";
import { FURA_TOKEN_STORAGE_KEY } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection } from "./connection";
import type { ClientMessage, ServerConfig, ServerMessage, SessionChangesSummaryState, SessionProjection, SessionSummary } from "./protocol";

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
  thinkingVisibility: "auto",
  proposedModels: [],
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
    ...overrides,
  };
}

function sessionChangesState(sessionId: string): SessionChangesSummaryState {
  return {
    status: "ready",
    targetClientId: "client-1",
    diffId: "diff-1",
    request: { scope: "sessionChanges", clientId: "client-1", diffId: "diff-1", sessionId, repoId: "/repo", detailMode: "statOnly", currentCommitOid: null, selectedFile: null },
    comparison: {
      repoRoot: "/repo",
      base: { kind: "sessionStartSnapshot", snapshot: { entryId: "snap-start", label: "session-start", createdAt: "now", refName: "refs/omp/diff-snapshots/start", tree: "tree", commit: "a".repeat(40) } },
      head: { kind: "workingTree" },
      leftTreeOrCommit: "a".repeat(40),
      rightTreeOrCommit: "tree",
      detailMode: "statOnly",
      currentCommitOid: null,
      selectedFile: null,
      generatedAt: "now",
      comparisonKey: "key",
    },
    sessionId,
    repos: [{ id: "/repo", repoRoot: "/repo", label: "repo · cwd", source: "cwd", hasSessionStartSnapshot: true, sessionStartSnapshot: { entryId: "snap-start", label: "session-start", createdAt: "now", refName: "refs/omp/diff-snapshots/start", tree: "tree", commit: "a".repeat(40) } }],
    selectedRepoId: "/repo",
    summary: { files: [], stat: "", truncated: false },
    review: { commits: [], currentCommitOid: null, currentCommitIndex: null, previousCommitOid: null },
    reviewWorktree: null,
    patch: null,
  };
}

let connections: FakeConnection[] = [];

function installMocks(): void {
  vi.doMock("./connection", () => ({
    createFuraConnection: (options: ConstructorParameters<typeof FakeConnection>[0]) => {
      const connection = new FakeConnection(options);
      connections.push(connection);
      return connection;
    },
  }));
  vi.doMock("./desktopDockview", () => ({
    initDesktopDockview: () => {
      const diffPanel = document.createElement("div");
      diffPanel.id = "testDiffPanel";
      const transcriptPanel = document.createElement("div");
      transcriptPanel.id = "testTranscriptPanel";
      const conflictResolverPanel = document.createElement("div");
      conflictResolverPanel.id = "testConflictResolverPanel";
      document.body.append(diffPanel, transcriptPanel, conflictResolverPanel);
      const panels: Record<string, HTMLElement> = {
        diffs: diffPanel,
        transcript: transcriptPanel,
        conflictResolver: conflictResolverPanel,
      };
      return {
        panelMounted: (id: string) => Boolean(panels[id]),
        panelContains: (id: string, element: Element) => Boolean(panels[id]?.contains(element)),
        isPanelActive: (id: string) => id === "diffs" || id === "conflictResolver",
        activatePanel: () => true,
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
      };
    },
  }));
}

async function createHarness() {
  vi.resetModules();
  vi.restoreAllMocks();
  connections = [];
  document.body.innerHTML = `<div id="app"></div>`;
  window.localStorage.clear();
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

describe("conflict resolver entry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("creates a Conflict Resolver session before opening the tool", async () => {
    const { connection } = await createHarness();
    const resolverButton = document.querySelector<HTMLButtonElement>("#conflictResolverButton");
    expect(resolverButton?.disabled).toBe(false);
    resolverButton?.click();
    expect(connection.sent).not.toContainEqual({ type: "conflict.scan", root: "/repo" });
    expect(document.querySelector("#cwdPickerOverlay")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#cwdPickerConflictBody")?.hasAttribute("hidden")).toBe(false);

    const repoInput = document.querySelector<HTMLInputElement>("#cwdPickerConflictRepo");
    if (!repoInput) throw new Error("conflict repo input missing");
    repoInput.value = "/custom/repo";
    document.querySelector<HTMLButtonElement>("#cwdPickerCreate")?.click();

    expect(connection.sent).toContainEqual({
      type: "session.create",
      requestId: expect.any(String),
      name: "conflicts: repo",
      cwd: "/custom/repo",
    });

    connection.emit({ type: "sessions.snapshot", sessions: [summary("conflict", { cwd: "/custom/repo" })] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "conflict",
      state: { ...projection("conflict"), summary: summary("conflict", { cwd: "/custom/repo" }) },
    });
    expect(connection.sent).toContainEqual({ type: "conflict.scan", root: "/custom/repo" });
  });

});

describe("desktop extension dialogs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("renders open_url requests as safe links without sending dialog responses", async () => {
    const { connection } = await createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: {
        id: "open-1",
        method: "open_url",
        title: "Sign in",
        instructions: "Open the browser link.",
        url: "https://auth.example.test/start",
      },
    });

    const overlay = document.querySelector<HTMLElement>("#extensionDialogOverlay");
    expect(overlay?.hidden).toBe(false);
    expect(document.querySelector("#extensionDialogTitle")?.textContent).toBe("Sign in");
    expect(document.querySelector("#extensionDialogBody")?.textContent).toContain("Open the browser link.");
    expect(document.querySelector<HTMLAnchorElement>("#extensionDialogField a")?.href).toBe("https://auth.example.test/start");
    expect(document.querySelector<HTMLButtonElement>("#extensionDialogSubmit")?.hidden).toBe(true);

    document.querySelector<HTMLButtonElement>("#extensionDialogCancel")?.click();

    expect(overlay?.hidden).toBe(true);
    expect(connection.sent.some(message => message.type === "dialog.respond")).toBe(false);
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

  it("opens a diff snapshot form with a timestamp-prefilled label", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T12:34:56Z"));
    const { connection } = await createHarness();

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...sessionChangesState("live"),
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile },
      },
    });
    connection.sent.length = 0;

    const snapshotButton = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Snapshot now");
    snapshotButton?.click();

    const overlay = document.querySelector<HTMLDivElement>("#snapshotLabelOverlay");
    const input = document.querySelector<HTMLInputElement>("#snapshotLabelInput");
    expect(overlay?.hasAttribute("hidden")).toBe(false);
    expect(input?.value).toContain("2026");

    if (!input) throw new Error("snapshot label input missing");
    input.value = "before risky refactor";
    document.querySelector<HTMLButtonElement>("#snapshotLabelCreate")?.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "sessionChanges.snapshot",
      sessionId: "live",
      repoId: "/repo",
      label: "before risky refactor",
    }));
    vi.useRealTimers();
  });

  it("sends explicit Git ref and repository root from the diff snapshot form", async () => {
    const { connection } = await createHarness();

    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...sessionChangesState("live"),
        targetClientId: request.clientId,
        diffId: request.diffId,
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile },
      },
    });
    connection.sent.length = 0;

    const snapshotButton = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Snapshot now");
    snapshotButton?.click();

    const explicitToggle = document.querySelector<HTMLInputElement>("#snapshotExplicitToggle");
    const explicitFields = document.querySelector<HTMLDivElement>("#snapshotExplicitFields");
    const labelInput = document.querySelector<HTMLInputElement>("#snapshotLabelInput");
    const refInput = document.querySelector<HTMLInputElement>("#snapshotRefInput");
    const repoInput = document.querySelector<HTMLInputElement>("#snapshotRepoInput");
    if (!explicitToggle || !labelInput || !refInput || !repoInput || !explicitFields) {
      throw new Error("snapshot form controls missing");
    }

    expect(explicitFields.hasAttribute("hidden")).toBe(true);
    explicitToggle.click();
    expect(explicitFields.hasAttribute("hidden")).toBe(false);
    expect(repoInput.value).toBe("/repo");

    labelInput.value = "historical baseline";
    refInput.value = "HEAD~1";
    repoInput.value = "/other/repo";
    document.querySelector<HTMLButtonElement>("#snapshotLabelCreate")?.click();

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "sessionChanges.snapshot",
      sessionId: "live",
      repoId: "/repo",
      label: "historical baseline",
      repoRoot: "/other/repo",
      ref: "HEAD~1",
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" } },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: { oldPath: null, newPath: "src/main.ts" } },
        summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
        patch: null,
      },
    });
    connection.emit({
      type: "diff.filePatch",
      patch: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/main.ts" },
        patch,
        truncated: false,
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

  it("keeps the diff file list mounted when selecting another file", async () => {
    const { connection } = await createHarness();
    const secondPatch = [
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const value = 'old b';",
      "+export const value = 'new b';",
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null },
        comparison: { ...baseState.comparison, detailMode: "filePatch", selectedFile: null },
        summary: {
          files: [
            { oldPath: null, newPath: "src/a.ts", status: "modified", added: 1, removed: 1 },
            { oldPath: null, newPath: "src/b.ts", status: "modified", added: 1, removed: 1 },
          ],
          stat: null,
          truncated: false,
        },
        patch: null,
      },
    });

    const sidebar = document.querySelector<HTMLElement>("#testDiffPanel .diffs-sidebar-scroll");
    const main = document.querySelector<HTMLElement>("#testDiffPanel .diffs-main");
    if (!sidebar || !main) throw new Error("diff layout missing");
    sidebar.scrollTop = 77;
    const fileButtons = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel .diffs-file-jump")];
    expect(fileButtons.map(button => button.dataset.diffFilePath)).toEqual(["src/a.ts", "src/b.ts"]);

    fileButtons[1]?.click();

    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-sidebar-scroll")).toBe(sidebar);
    expect(document.querySelector<HTMLElement>("#testDiffPanel .diffs-main")).toBe(main);
    expect(sidebar.scrollTop).toBe(77);
    expect(fileButtons[1]?.classList.contains("active")).toBe(true);
    expect(connection.sent.some(message =>
      message.type === "sessionChanges.request" &&
      message.selectedFile?.newPath === "src/b.ts"
    )).toBe(true);

    connection.emit({
      type: "diff.filePatch",
      patch: {
        targetClientId: request.clientId,
        diffId: request.diffId,
        scope: "sessionChanges",
        comparisonKey: "key",
        file: { oldPath: null, newPath: "src/b.ts" },
        patch: secondPatch,
        truncated: false,
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

  it("requests and applies conflict resolver agent proposal previews", async () => {
    const { connection } = await createHarness();
    const conflicted = [
      "const value = 1;",
      "<<<<<<< HEAD",
      "const picked = ours();",
      "||||||| base",
      "const picked = base();",
      "=======",
      "const picked = theirs();",
      ">>>>>>> incoming",
      "",
    ].join("\n");
    document.querySelector<HTMLButtonElement>("#conflictResolverButton")?.click();
    const repoInput = document.querySelector<HTMLInputElement>("#cwdPickerConflictRepo");
    if (!repoInput) throw new Error("conflict repo input missing");
    repoInput.value = "/repo";
    document.querySelector<HTMLButtonElement>("#cwdPickerCreate")?.click();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live"),
    });
    expect(connection.sent).toContainEqual({ type: "conflict.scan", root: "/repo" });
    connection.emit({
      type: "conflict.snapshot",
      repos: [{
        repoId: "/repo",
        root: "/repo",
        operation: "merge",
        files: [{ path: "src/main.ts", kind: "bothModified", supported: true }],
      }],
    });
    connection.emit({
      type: "conflict.file",
      file: {
        repoId: "/repo",
        path: "src/main.ts",
        kind: "bothModified",
        base: { label: "Common ancestor", language: "typescript", text: "const picked = base();\n", size: 22 },
        ours: { label: "Current branch", language: "typescript", text: "const picked = ours();\n", size: 22 },
        theirs: { label: "Incoming change", language: "typescript", text: "const picked = theirs();\n", size: 24 },
        result: { label: "Result", language: "typescript", text: conflicted, size: conflicted.length },
        conflicts: [{ id: "conflict-1", startLine: 2, separatorLine: 6, endLine: 8 }],
        version: "1:9",
      },
    });
    const instructions = document.querySelector<HTMLTextAreaElement>("#testConflictResolverPanel .conflict-agent-instructions");
    if (!instructions) throw new Error("conflict resolver agent instructions missing");
    instructions.value = "Prefer the smallest safe change.";
    instructions.dispatchEvent(new Event("input", { bubbles: true }));
    const proposeButton = [...document.querySelectorAll<HTMLButtonElement>("#testConflictResolverPanel button")]
      .find(button => button.textContent === "Propose conflict");
    proposeButton?.click();
    const request = connection.sent.find(message => message.type === "conflict.agent.run");
    expect(request).toMatchObject({
      sessionId: "live",
      type: "conflict.agent.run",
      repoId: "/repo",
      path: "src/main.ts",
      expectedVersion: "1:9",
      mode: "propose",
      scope: "selectedConflict",
      conflictId: "conflict-1",
      instructions: "Prefer the smallest safe change.",
    });
    connection.emit({
      type: "conflict.agentResult",
      result: {
        repoId: "/repo",
        path: "src/main.ts",
        sourceVersion: "1:9",
        mode: "propose",
        scope: "selectedConflict",
        conflictId: "conflict-1",
        risk: "medium",
        summary: "Merged the selected conflict and left the rest untouched.",
        explanation: "This keeps the surrounding file unchanged and resolves only the selected conflict block.",
        content: "const merged = true;\n",
        remainingConflictCount: 0,
      },
    });
    const applyButton = [...document.querySelectorAll<HTMLButtonElement>("#testConflictResolverPanel button")]
      .find(button => button.textContent === "Apply agent result");
    applyButton?.click();
    expect(document.querySelector<HTMLTextAreaElement>("#testConflictResolverPanel .conflict-result-editor")?.value).toBe("const merged = true;\n");
  });
});
