import { beforeEach, describe, expect, it, vi } from "vitest";
import { FURA_TOKEN_STORAGE_KEY } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection } from "./connection";
import type { ClientMessage, DiffRow, ReviewComment, ServerConfig, ServerMessage, SessionChangesSummaryState, SessionProjection, SessionSummary } from "./protocol";

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
    request: { scope: "sessionChanges", clientId: "client-1", diffId: "diff-1", sessionId, repoId: "/repo", detailMode: "statOnly", currentCommitOid: null, selectedFile: null, contextLines: 3 },
    comparison: {
      repoRoot: "/repo",
      base: { kind: "sessionStartSnapshot", snapshot: { entryId: "snap-start", label: "session-start", createdAt: "now", refName: "refs/omp/diff-snapshots/start", tree: "tree", commit: "a".repeat(40) } },
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
    repos: [{ id: "/repo", repoRoot: "/repo", label: "repo · cwd", source: "cwd", hasSessionStartSnapshot: true, sessionStartSnapshot: { entryId: "snap-start", label: "session-start", createdAt: "now", refName: "refs/omp/diff-snapshots/start", tree: "tree", commit: "a".repeat(40) } }],
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
let desktopMockActivePanelIds = new Set(["diffs", "conflictResolver"]);

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
      const goalPanel = document.createElement("div");
      goalPanel.id = "testGoalPanel";
      const conflictResolverPanel = document.createElement("div");
      conflictResolverPanel.id = "testConflictResolverPanel";
      document.body.append(diffPanel, transcriptPanel, goalPanel, conflictResolverPanel);
      const panels: Record<string, HTMLElement> = {
        diffs: diffPanel,
        transcript: transcriptPanel,
        goal: goalPanel,
        conflictResolver: conflictResolverPanel,
      };
      return {
        panelMounted: (id: string) => Boolean(panels[id]),
        panelContains: (id: string, element: Element) => Boolean(panels[id]?.contains(element)),
        isPanelActive: (id: string) => desktopMockActivePanelIds.has(id),
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

async function createHarness(options: { preserveLocalStorage?: boolean } = {}) {
  vi.resetModules();
  vi.restoreAllMocks();
  connections = [];
  desktopMockActivePanelIds = new Set(["diffs", "conflictResolver"]);
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
  desktopMockActivePanelIds = new Set(["diffs", "conflictResolver"]);
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
describe("conflict resolver entry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    connections = [];
    vi.useRealTimers();
  });

  it("creates a Conflict Resolver session before opening the tool", async () => {
    const { connection } = await createHarness();
    expect(document.querySelector<HTMLButtonElement>("#conflictResolverButton")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>("#openDiffButton")).toBeNull();
    document.querySelector<HTMLButtonElement>("#createSessionButton")?.click();
    document.querySelector<HTMLButtonElement>("#cwdPickerConflictTab")?.click();
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: request.detailMode, currentCommitOid: request.currentCommitOid, selectedFile: request.selectedFile, contextLines: request.contextLines ?? 3 },
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
        }],
      }),
    });
    const updatedButton = document.querySelector<HTMLButtonElement>('#testTranscriptPanel [data-message-id="assistant-1"] .message-actions button');
    expect(updatedButton).toBe(copyButton);
    expect(document.querySelector<HTMLElement>('#testTranscriptPanel [data-message-id="assistant-1"]')?.textContent).toContain("copyable answer updated");
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
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
    expect(contextButton?.previousElementSibling?.classList.contains("diff-comment-spacer")).toBe(true);
    expect(contextButton?.nextElementSibling?.tagName).toBe("CODE");

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

  it("shows commit messages only for explicit single-commit aggregate views", async () => {
    const { connection } = await createHarness();
    const commitOid = "b".repeat(40);
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    document.querySelector<HTMLButtonElement>("#sessionsList .session-item button")?.click();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const request = connection.sent.find(message => message.type === "sessionChanges.request");
    if (!request || request.type !== "sessionChanges.request") throw new Error("session changes request missing");
    const baseState = sessionChangesState("live");
    if (baseState.status !== "ready") throw new Error("ready session changes state missing");
    const commonState: Extract<SessionChangesSummaryState, { status: "ready" }> = {
      ...baseState,
      targetClientId: request.clientId,
      diffId: request.diffId,
      request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
      comparison: { ...baseState.comparison, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
      summary: { files: [{ oldPath: null, newPath: "src/main.ts", status: "modified", added: 1, removed: 1 }], stat: null, truncated: false },
      review: {
        commits: [{ oid: commitOid, shortOid: "bbbbbbbbbbbb", subject: "Add logging", message: "Add logging\n\nDetailed body.", committedAt: "2026-05-03T00:00:00Z", parentOids: ["a".repeat(40)], isMerge: false }],
        currentCommitOid: null,
        currentCommitIndex: null,
        previousCommitOid: null,
      },
    };

    connection.emit({ type: "sessionChanges.summary", state: commonState });
    expect(document.querySelector("#testDiffPanel .diff-commit-message")).toBeNull();

    connection.emit({
      type: "sessionChanges.summary",
      state: {
        ...commonState,
        request: { ...commonState.request, currentCommitOid: commitOid },
        comparison: {
          ...commonState.comparison,
          currentCommitOid: commitOid,
          displayedPatchRange: {
            base: { kind: "commit", oid: "a".repeat(40), shortOid: "aaaaaaaaaaaa", subject: null },
            head: { kind: "commit", oid: commitOid, shortOid: "bbbbbbbbbbbb", subject: "Add logging" },
          },
        },
        review: { ...commonState.review, currentCommitOid: commitOid, currentCommitIndex: 0, previousCommitOid: "a".repeat(40) },
      },
    });
    const commitMessage = document.querySelector("#testDiffPanel .diff-commit-message");
    expect(commitMessage?.textContent).toContain("Detailed body.");
    expect(commitMessage?.parentElement?.classList.contains("diffs-main-body")).toBe(true);
    expect(document.querySelector("#testDiffPanel .diff-step-actions")?.contains(commitMessage as Node)).toBe(false);
    expect(document.querySelector("#testDiffPanel .diffs-summary p")?.textContent).toBe("aaaaaaaaaaaa → bbbbbbbbbbbb — Add logging");

    document.querySelector<HTMLButtonElement>('#testDiffPanel .diffs-file-jump[data-diff-file-path="src/main.ts"]')?.click();
    expect(document.querySelector("#testDiffPanel .diff-commit-message")).toBeNull();
  });

  it("preserves selected snapshot repository when changing commits", async () => {
    const { connection } = await createHarness();
    const commitOid = "b".repeat(40);
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
        selectedRepoId: "snapshot-entry",
        repos: [
          ...baseState.repos,
          { id: "snapshot-entry", repoRoot: "/repo", label: "snapshot · historical", source: "snapshot", hasSessionStartSnapshot: true, sessionStartSnapshot: { entryId: "snapshot-entry", label: "historical", createdAt: "now", refName: "refs/omp/diff-snapshots/historical", tree: "tree", commit: "a".repeat(40) } },
        ],
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: "snapshot-entry", detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
        comparison: { ...baseState.comparison, detailMode: "filePatch", currentCommitOid: null },
        review: {
          commits: [{ oid: commitOid, shortOid: "bbbbbbbbbbbb", subject: "Add logging", message: "Add logging", committedAt: "2026-05-03T00:00:00Z", parentOids: ["a".repeat(40)], isMerge: false }],
          currentCommitOid: null,
          currentCommitIndex: null,
          previousCommitOid: null,
        },
      },
    });
    connection.sent.length = 0;

    const commitSelect = document.querySelector<HTMLSelectElement>("#testDiffPanel .diff-commit-select");
    if (!commitSelect) throw new Error("commit selector missing");
    commitSelect.value = commitOid;
    commitSelect.dispatchEvent(new Event("change"));

    expect(connection.sent).toContainEqual(expect.objectContaining({
      type: "sessionChanges.request",
      repoId: "snapshot-entry",
      detailMode: "filePatch",
      currentCommitOid: commitOid,
    }));
  });

  it("refreshes session changes with the current repo, mode, and commit", async () => {
    const { connection } = await createHarness();
    const commitOid = "b".repeat(40);
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
        request: { ...baseState.request, clientId: request.clientId, diffId: request.diffId, detailMode: "filePatch", currentCommitOid: commitOid },
        comparison: { ...baseState.comparison, detailMode: "filePatch", currentCommitOid: commitOid },
        review: { ...baseState.review, currentCommitOid: commitOid, currentCommitIndex: 0, previousCommitOid: "a".repeat(40) },
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

    const buttonTexts = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")].map(button => button.textContent);
    expect(buttonTexts).toContain("Refresh");
    const refreshButton = [...document.querySelectorAll<HTMLButtonElement>("#testDiffPanel button")]
      .find(button => button.textContent === "Refresh");
    expect(refreshButton?.disabled).toBe(false);
    refreshButton?.click();

    const refreshRequest = connection.sent.find(message => message.type === "sessionChanges.request");
    expect(refreshRequest).toEqual(expect.objectContaining({
      type: "sessionChanges.request",
      repoId: "repo-2",
      detailMode: "filePatch",
      currentCommitOid: commitOid,
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
        request: { ...baseState.request, clientId: refreshRequest.clientId, diffId: refreshRequest.diffId, detailMode: "filePatch", currentCommitOid: commitOid },
        comparison: { ...baseState.comparison, detailMode: "filePatch", currentCommitOid: commitOid },
        review: { ...baseState.review, currentCommitOid: commitOid, currentCommitIndex: 0, previousCommitOid: "a".repeat(40) },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
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
        request: { scope: "sessionChanges", clientId: reloadRequest.clientId, diffId: reloadRequest.diffId, sessionId: "live", repoId: reloadRequest.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: { oldPath: null, newPath: "src/main.ts" }, contextLines: 3 },
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
        request: { scope: "sessionChanges", clientId: request.clientId, diffId: request.diffId, sessionId: "live", repoId: request.repoId, detailMode: "filePatch", currentCommitOid: null, selectedFile: null, contextLines: 3 },
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
    document.querySelector<HTMLButtonElement>("#createSessionButton")?.click();
    document.querySelector<HTMLButtonElement>("#cwdPickerConflictTab")?.click();
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
