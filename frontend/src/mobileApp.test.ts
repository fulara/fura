import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus, FuraConnection } from "./connection";
import { mountMobileApp, type MobileConnectionOptions } from "./mobileApp";
import { FURA_TOKEN_STORAGE_KEY } from "./bootstrapAuth";
import type { ClientMessage, ServerConfig, ServerMessage, SessionProjection, SessionSummary } from "./protocol";

class FakeConnection implements FuraConnection {
  sent: ClientMessage[] = [];
  connected = false;
  closed = false;

  constructor(readonly options: MobileConnectionOptions) {}

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

  emitClose(label = "reconnecting in 500ms", status: ConnectionStatus = "reconnecting"): void {
    this.connected = false;
    this.options.onStatus(label, status);
    this.options.onClose?.();
  }
}

const config: ServerConfig = { defaultCwd: "/repo", voiceLanguage: "en", showTools: true, thinkingVisibility: "auto", proposedModels: [] };

function createHarness(path = "/mobile.html", storedToken = "dev") {
  document.body.innerHTML = `<div id="app"></div>`;
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (storedToken) window.sessionStorage.setItem(FURA_TOKEN_STORAGE_KEY, storedToken);
  window.history.replaceState(null, "", path);
  const connections: FakeConnection[] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const app = mountMobileApp({
    document,
    window,
    createConnection: options => {
      const connection = new FakeConnection(options);
      connections.push(connection);
      return connection;
    },
  });
  const connection = connections[0];
  if (!connection) throw new Error("connection missing");
  connection.emit({ type: "hello", serverVersion: "test", protocolVersion: 1, config });
  return { app, connection, connections, debug };
}

function createUnauthenticatedHarness(path = "/mobile.html") {
  document.body.innerHTML = `<div id="app"></div>`;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", path);
  const connections: FakeConnection[] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const app = mountMobileApp({
    document,
    window,
    createConnection: options => {
      const connection = new FakeConnection(options);
      connections.push(connection);
      return connection;
    },
  });
  return { app, connections, debug };
}

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionMode: "standard",
    sessionId,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    cwd: "/repo",
    ...overrides,
  };
}

function projection(sessionId: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    summary: summary(sessionId, { title: `Session ${sessionId}` }),
    transcript: [
      {
        kind: "message",
        id: `message-${sessionId}`,
        role: "assistant",
        blocks: [{ kind: "text", text: `Transcript ${sessionId}` }],
        timestamp: null,
        isNew: false,
      },
    ],
    isBusy: false,
    tokensTotal: 0,
    costUsd: 0,
    todoPhases: [],
    ...overrides,
  };
}


function clickSession(index = 0): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#mobileSessionsList .session-item > button:not(.session-delete)");
  const button = buttons[index];
  if (!button) throw new Error(`session button ${index} missing`);
  button.click();
}

function openCreateDrawer(): void {
  const button = document.querySelector<HTMLButtonElement>("#mobileCreateToggle");
  if (!button) throw new Error("create toggle missing");
  button.click();
}

function submitCreateForm(name: string, cwd: string): void {
  const nameInput = document.querySelector<HTMLInputElement>("#mobileCreateName");
  const cwdInput = document.querySelector<HTMLInputElement>("#mobileCreateCwd");
  const form = document.querySelector<HTMLFormElement>("#mobileCreateForm");
  if (!nameInput || !cwdInput || !form) throw new Error("create form missing");
  nameInput.value = name;
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  cwdInput.value = cwd;
  cwdInput.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
}

function enableWorktreeCreate(fields: {
  sourceRepo?: string;
  directory?: string;
  baseBranch?: string;
  branchName?: string;
} = {}): void {
  const enabled = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeEnabled");
  const sourceRepo = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeSourceRepo");
  const directory = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeDirectory");
  const baseBranch = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeBase");
  const branchName = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeBranch");
  if (!enabled || !sourceRepo || !directory || !baseBranch || !branchName) throw new Error("worktree form missing");
  enabled.checked = true;
  enabled.dispatchEvent(new Event("change", { bubbles: true }));
  if (fields.sourceRepo !== undefined) {
    sourceRepo.value = fields.sourceRepo;
    sourceRepo.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (fields.directory !== undefined) {
    directory.value = fields.directory;
    directory.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (fields.baseBranch !== undefined) {
    baseBranch.value = fields.baseBranch;
    baseBranch.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (fields.branchName !== undefined) {
    branchName.value = fields.branchName;
    branchName.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function stubFileReader(base64 = "aW1hZ2U="): void {
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;
    onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(blob: Blob): void {
      this.result = `data:${blob.type};base64,${base64}`;
      queueMicrotask(() => this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>));
    }
  }

  vi.stubGlobal("FileReader", MockFileReader);
}

async function selectMobileImage(file = new File(["image"], "image.png", { type: "image/png" })): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#mobileImageInput");
  if (!input) throw new Error("mobile image input missing");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mountMobileApp", () => {
  it("uses a sessionStorage token and strips URL tokens without storing them", () => {
    const { connection, debug } = createHarness("/mobile.html?token=url-token", "stored-token");

    expect(window.location.href).toBe("http://localhost:3000/mobile.html");
    expect(window.localStorage.getItem(FURA_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(FURA_TOKEN_STORAGE_KEY)).toBe("stored-token");
    expect(connection.options.auth).toEqual({ type: "sessionCookie", token: "stored-token" });
    expect(connection.sent).toContainEqual({ type: "session.list" });
    expect(connection.options.clientKind).toBe("mobile");
    expect(document.querySelector("#mobileConnectionStatus")?.textContent).toBe("connected");
    debug.mockRestore();
  });

  it("shows the auth gate instead of connecting without a stored token", () => {
    const { connections, debug } = createUnauthenticatedHarness("/mobile.html?token=url-token");

    expect(window.location.href).toBe("http://localhost:3000/mobile.html");
    expect(connections).toEqual([]);
    expect(document.querySelector<HTMLElement>("#mobileAuthGate")?.hidden).toBe(false);
    expect(document.querySelector("#mobileAuthStatus")?.textContent).toBe("Enter the bridge token to connect.");
    expect(window.localStorage.getItem(FURA_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(FURA_TOKEN_STORAGE_KEY)).toBeNull();
    debug.mockRestore();
  });

  it("clears the attempted session token when auth fails", () => {
    const { connection, debug } = createHarness();

    connection.options.onAuthFailure?.("invalid token");

    expect(window.sessionStorage.getItem(FURA_TOKEN_STORAGE_KEY)).toBeNull();
    expect(document.querySelector<HTMLElement>("#mobileAuthGate")?.hidden).toBe(false);
    expect(document.querySelector("#mobileAuthStatus")?.textContent).toBe("invalid token");
    debug.mockRestore();
  });

  it("clears stale connection failure text after a later successful connection", () => {
    const { connection, debug } = createHarness();
    const log = document.querySelector<HTMLElement>("#mobileLog");
    const status = document.querySelector<HTMLElement>("#mobileConnectionStatus");

    connection.options.onLog("Connection failed: Failed to fetch");
    connection.options.onStatus("connected", "connected");
    connection.options.onOpen?.();

    expect(log?.textContent).toBe("");
    expect(status?.textContent).toBe("connected");
    expect(document.querySelector<HTMLElement>("#mobileAuthGate")?.hidden).toBe(true);
    debug.mockRestore();
  });

  it("opens available sessions by session file", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "sessions.snapshot",
      sessions: [summary("saved", { kind: "available", status: "available", sessionFile: "/tmp/saved.jsonl" })],
    });

    clickSession();

    expect(connection.sent).toContainEqual({ type: "session.open", sessionFile: "/tmp/saved.jsonl" });
  });

  it("attaches managed sessions by session id", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });

    clickSession();

    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    expect(document.querySelector("#mobileSessionMeta")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#mobileStatusBar")?.textContent).toContain("/repo");
    expect(connection.sent).toContainEqual({ type: "session.attach", sessionId: "live" });
  });

  it("applies mobile session deltas after an initial snapshot", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live", { title: "Live", messageCount: 2 }),
        transcriptReplaceFrom: 1,
        transcriptAppend: [{
          kind: "message",
          id: "delta-message",
          role: "assistant",
          blocks: [{ kind: "text", text: "Delta transcript" }],
          timestamp: null,
          isNew: true,
        }],
        isBusy: false,
        tokensTotal: 10,
        costUsd: 0.01,
        todoPhases: [],
      },
    });

    expect(document.querySelector("#mobileTranscript")?.textContent).toContain("Transcript live");
    expect(document.querySelector("#mobileTranscript")?.textContent).toContain("Delta transcript");
    expect(document.querySelector("#mobileSessionTitle")?.textContent).toBe("Live");
  });

  it("keeps mobile copy controls stable across unchanged active snapshots", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    const copyButton = document.querySelector<HTMLButtonElement>('#mobileTranscript [data-message-id="message-live"] .message-actions button');
    if (!copyButton) throw new Error("copy button missing");

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", { tokensTotal: 15 }),
    });
    expect(document.querySelector<HTMLButtonElement>('#mobileTranscript [data-message-id="message-live"] .message-actions button')).toBe(copyButton);

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [{
          kind: "message",
          id: "message-live",
          role: "assistant",
          blocks: [{ kind: "text", text: "Updated transcript" }],
          timestamp: null,
          isNew: false,
        }],
      }),
    });
    expect(document.querySelector<HTMLButtonElement>('#mobileTranscript [data-message-id="message-live"] .message-actions button')).not.toBe(copyButton);
    expect(document.querySelector("#mobileTranscript")?.textContent).toContain("Updated transcript");
  });

  it("requests a full refresh when a mobile session delta cannot be applied", () => {
    const { connection } = createHarness();

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live"),
        transcriptReplaceFrom: 1,
        transcriptAppend: [],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });

    expect(connection.sent).toContainEqual({ type: "state.refresh", sessionId: "live" });
  });

  it("recovers from a rejected session delta when a full snapshot follows", () => {
    const { connection } = createHarness();

    connection.emit({
      type: "session.delta",
      sessionId: "live",
      state: {
        summary: summary("live"),
        transcriptReplaceFrom: 1,
        transcriptAppend: [],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
      },
    });
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        summary: summary("live", { title: "Recovered" }),
      }),
    });

    expect(connection.sent.filter(message => message.type === "state.refresh")).toEqual([
      { type: "state.refresh", sessionId: "live" },
    ]);
    expect(document.querySelector("#mobileSessionTitle")?.textContent).toBe("Recovered");
    expect(document.querySelector("#mobileTranscript")?.textContent).toContain("Transcript live");
  });

  it("keeps the mobile options menu open when visibility toggles are changed", () => {
    const { connection } = createHarness();

    document.querySelector<HTMLButtonElement>("#mobileOptionsToggle")?.click();
    document.querySelector<HTMLButtonElement>("#mobileToolVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", showTools: false });
    expect(document.querySelector("#mobileOptionsMenu")?.hasAttribute("hidden")).toBe(false);

    document.querySelector<HTMLButtonElement>("#mobileThinkingVisibilityToggle")?.click();

    expect(connection.sent).toContainEqual({ type: "config.set", thinkingVisibility: "shown" });
    expect(document.querySelector("#mobileOptionsMenu")?.hasAttribute("hidden")).toBe(false);
  });

  it("applies config visibility updates to the mobile transcript", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [
          {
            kind: "message",
            id: "message-live",
            role: "assistant",
            blocks: [
              { kind: "text", text: "Answer" },
              { kind: "thinking", thinking: "private" },
            ],
            timestamp: null,
            isNew: false,
          },
          {
            kind: "tool",
            toolCallId: "tool-1",
            toolName: "bash",
            args: {},
            isActive: false,
            isError: false,
          },
        ],
      }),
    });

    expect(document.querySelectorAll("#mobileTranscript .tool-card").length).toBe(1);
    expect(document.querySelectorAll("#mobileTranscript .thinking-block").length).toBe(1);

    connection.emit({
      type: "config.updated",
      config: {
        ...config,
        showTools: false,
        thinkingVisibility: "hidden",
      },
    });

    expect(document.querySelectorAll("#mobileTranscript .tool-card").length).toBe(0);
    expect(document.querySelectorAll("#mobileTranscript .thinking-block").length).toBe(0);
  });

  it("forces an immediate reconnect when the disconnected status is clicked", () => {
    const { connection } = createHarness();
    connection.sent = [];
    connection.emitClose("disconnected", "disconnected");

    document.querySelector<HTMLElement>("#mobileConnectionStatus")?.click();

    expect(connection.connected).toBe(true);
    expect(connection.sent).toEqual([{ type: "session.list" }]);
    expect(document.querySelector("#mobileConnectionStatus")?.textContent).toBe("connected");
  });

  it("does not send prompt.abort when the websocket closes", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession(0);
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    connection.sent = [];

    connection.emitClose("reconnecting in 500ms", "reconnecting");

    expect(connection.sent.some(message => message.type === "prompt.abort")).toBe(false);
  });

  it("refreshes the active and previously attached managed sessions after reconnect", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("other")] });
    clickSession(0);
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    clickSession(1);
    connection.emit({ type: "session.snapshot", sessionId: "other", state: projection("other") });
    connection.sent = [];

    connection.options.onOpen?.();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("other")] });

    expect(connection.sent).toEqual([
      { type: "session.list" },
      { type: "state.refresh", sessionId: "other" },
      { type: "state.refresh", sessionId: "live" },
    ]);
  });

  it("restores pending plan review from a post-reconnect session snapshot", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession(0);
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    connection.sent = [];

    connection.options.onOpen?.();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    expect(connection.sent).toEqual([
      { type: "session.list" },
      { type: "state.refresh", sessionId: "live" },
    ]);

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        planMode: { enabled: true, planFilePath: "local://PLAN.md", discussion: false },
        pendingPlanReview: {
          planFilePath: "local://PLAN.md",
          finalPlanFilePath: "local://FINAL.md",
          title: "Recovered review",
          content: "Recovered plan body",
        },
      }),
    });

    expect(document.querySelector(".plan-review-card")?.textContent).toContain("Plan ready: Recovered review");
    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(true);
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Plan review waiting");

    document.querySelector<HTMLButtonElement>(".plan-review-approve")?.click();
    expect(connection.sent).toContainEqual({
      type: "plan.approve",
      sessionId: "live",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Recovered review",
      content: "Recovered plan body",
      approvalMode: "execute",
    });
  });

  it("filters sessions by category without exposing mobile category editing", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "sessions.snapshot",
      sessions: [summary("live", { category: "ops" }), summary("other", { category: "personal" })],
    });

    const filter = document.querySelector<HTMLSelectElement>("#mobileSessionCategoryFilter");
    if (!filter) throw new Error("category filter missing");
    expect([...filter.options].map(option => option.value)).toEqual(["", "ops", "personal"]);
    filter.value = "ops";
    filter.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.querySelector("#mobileSessionsList")?.textContent).toContain("ops");
    expect(document.querySelector("#mobileSessionsList")?.textContent).not.toContain("personal");
    expect(document.querySelector("#mobileCategoryInput")).toBeNull();
    expect(document.querySelector("#mobileCategorySave")).toBeNull();
  });

  it("sends Ask Fura prompts with all known session ids despite category filters", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "sessions.snapshot",
      sessions: [summary("live", { category: "ops" }), summary("other", { category: "personal" })],
    });
    const filter = document.querySelector<HTMLSelectElement>("#mobileSessionCategoryFilter");
    const askTab = document.querySelector<HTMLButtonElement>("#mobileAskFuraButton");
    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!filter || !askTab || !input || !form) throw new Error("Ask Fura controls missing");
    filter.value = "ops";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    connection.sent = [];

    askTab.click();
    input.value = "find personal";
    form.requestSubmit();

    const prompt = connection.sent.find((message): message is Extract<ClientMessage, { type: "control.prompt" }> => message.type === "control.prompt");
    expect(prompt).toBeTruthy();
    expect(prompt?.text).toBe("find personal");
    expect(prompt?.uiSnapshot.sessionIds).toEqual(["live", "other"]);
    expect(prompt?.uiSnapshot).not.toHaveProperty("visibleSessionIds");
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Ask Fura thinking");
  });

  it("renders Ask Fura candidates and opens the selected session", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live", { title: "Live" })] });
    const askTab = document.querySelector<HTMLButtonElement>("#mobileAskFuraButton");
    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!askTab || !input || !form) throw new Error("Ask Fura controls missing");
    askTab.click();
    input.value = "find live";
    form.requestSubmit();
    const prompt = connection.sent.find((message): message is Extract<ClientMessage, { type: "control.prompt" }> => message.type === "control.prompt");
    if (!prompt) throw new Error("control prompt missing");

    connection.emit({
      type: "control.reply",
      targetClientId: prompt.clientId,
      conversationId: prompt.conversationId ?? "conversation",
      message: "Found it.",
      candidates: [{
        type: "session",
        candidateId: "session-1",
        sessionId: "live",
        title: "Live",
        cwd: "/repo",
        timestamp: null,
        status: "idle",
        kind: "managed",
        reason: "matched title",
      }],
    });

    expect(document.querySelector("#mobileController")?.textContent).toContain("Found it.");
    expect(document.querySelector("#mobileController")?.textContent).toContain("Live");
    document.querySelector<HTMLButtonElement>(".mobile-control-candidate button")?.click();

    expect(connection.sent).toContainEqual({ type: "session.attach", sessionId: "live" });
    expect(document.querySelector<HTMLButtonElement>("#mobileAskFuraButton")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector<HTMLElement>("#mobileTranscript")?.hidden).toBe(false);
  });

  it("deletes sessions with a worktree option only for managed worktree sessions", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "sessions.snapshot",
      sessions: [
        summary("regular", { title: "Regular" }),
        summary("worktree", { title: "Feature", worktree: { path: "/repo-feature" } }),
      ],
    });

    const deleteButtons = document.querySelectorAll<HTMLButtonElement>("#mobileSessionsList .session-delete");
    deleteButtons[0]?.click();
    expect(document.querySelector<HTMLElement>("#mobileDeleteSessionOverlay")?.hidden).toBe(false);
    expect(document.querySelector("#mobileDeleteSessionWorktreeRow")?.hasAttribute("hidden")).toBe(true);
    document.querySelector<HTMLButtonElement>("#mobileDeleteSessionConfirm")?.click();
    expect(connection.sent).toContainEqual({ type: "session.delete", sessionId: "regular" });

    deleteButtons[1]?.click();
    expect(document.querySelector("#mobileDeleteSessionWorktreeRow")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#mobileDeleteSessionWorktreePath")?.textContent).toBe("Linked worktree: /repo-feature");
    const checkbox = document.querySelector<HTMLInputElement>("#mobileDeleteSessionWorktree");
    if (!checkbox) throw new Error("delete worktree checkbox missing");
    checkbox.checked = true;
    document.querySelector<HTMLButtonElement>("#mobileDeleteSessionConfirm")?.click();
    expect(connection.sent).toContainEqual({ type: "session.delete", sessionId: "worktree", deleteWorktree: true });
  });

  it("sends prompts for the active ready session and clears the editor", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!input || !form) throw new Error("prompt form missing");
    input.value = "hello mobile";
    form.requestSubmit();

    expect(connection.sent).toContainEqual({ type: "prompt.send", sessionId: "live", text: "hello mobile" });
    expect(input.value).toBe("");
  });

  it("reviews transcript lines on mobile and sends previewed comments", () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Please clarify line two");
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        transcript: [{
          kind: "message",
          id: "message-live",
          role: "assistant",
          blocks: [{ kind: "text", text: "line one\nline two" }],
          timestamp: null,
          isNew: false,
        }],
      }),
    });

    const transcript = document.querySelector<HTMLElement>("#mobileTranscript");
    if (!transcript) throw new Error("mobile transcript missing");
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 200 });
    const replaceChildren = transcript.replaceChildren.bind(transcript);
    transcript.replaceChildren = (...nodes: Parameters<HTMLElement["replaceChildren"]>) => {
      replaceChildren(...nodes);
      transcript.scrollTop = 0;
    };
    transcript.scrollTop = 240;

    const reviewButton = [...document.querySelectorAll<HTMLButtonElement>(".message-actions button")]
      .find(button => button.textContent === "Review");
    reviewButton?.click();
    expect(transcript.scrollTop).toBe(240);
    document.querySelectorAll<HTMLButtonElement>(".transcript-review-comment-btn")[1]?.click();
    expect(prompt).toHaveBeenCalledWith("Comment on this transcript line");
    expect(document.querySelector(".transcript-review-inline-comment")?.textContent).toContain("Please clarify line two");
    expect(transcript.scrollTop).toBe(240);

    document.querySelector<HTMLButtonElement>(".transcript-review-actions button:last-child")?.click();
    expect(document.querySelector<HTMLElement>("#mobileReviewPreviewOverlay")?.hidden).toBe(false);
    const reviewPreview = document.querySelector<HTMLTextAreaElement>("#mobileReviewPreviewText");
    expect(reviewPreview?.readOnly).toBe(false);
    expect(reviewPreview?.value).toContain("Comment: Please clarify line two");
    if (!reviewPreview) throw new Error("review preview missing");
    reviewPreview.value = "Please clarify the reviewed transcript line.";

    document.querySelector<HTMLButtonElement>("#mobileReviewPreviewSend")?.click();

    const sentPrompt = connection.sent.find(
      message => message.type === "prompt.send" && message.sessionId === "live" && message.text === "Please clarify the reviewed transcript line.",
    );
    expect(sentPrompt).toBeTruthy();
    expect(document.querySelector<HTMLElement>("#mobileReviewPreviewOverlay")?.hidden).toBe(true);
    expect(document.querySelector(".transcript-review-body")).toBeNull();
  });

  it("attaches and removes mobile image previews", async () => {
    stubFileReader();
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    await selectMobileImage();

    const previews = document.querySelector<HTMLElement>("#mobileImagePreviews");
    expect(previews?.hidden).toBe(false);
    expect(previews?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("1 image attached");

    previews?.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')?.click();

    expect(previews?.hidden).toBe(true);
    expect(previews?.querySelector("img")).toBeNull();
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("");
  });

  it("sends mobile prompts with attached images and clears accepted drafts", async () => {
    stubFileReader("c21va2U=");
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    await selectMobileImage(new File(["smoke"], "smoke.png", { type: "image/png" }));

    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!input || !form) throw new Error("prompt form missing");
    input.value = "describe this";
    form.requestSubmit();

    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "live",
      text: "describe this",
      images: [{ type: "image", data: "c21va2U=", mimeType: "image/png" }],
    });
    expect(input.value).toBe("");
    expect(document.querySelector<HTMLElement>("#mobileImagePreviews")?.hidden).toBe(true);
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("");
  });

  it("sends image-only mobile prompts", async () => {
    stubFileReader("b25seS1pbWFnZQ==");
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    await selectMobileImage();

    document.querySelector<HTMLFormElement>("#mobilePromptForm")?.requestSubmit();

    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "live",
      text: "",
      images: [{ type: "image", data: "b25seS1pbWFnZQ==", mimeType: "image/png" }],
    });
  });

  it("renders confirm dialog requests and sends confirmed responses", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: {
        id: "dialog-1",
        method: "confirm",
        title: "Continue?",
        message: "Approve the operation?",
        timeout: 30000,
      },
    });

    const overlay = document.querySelector<HTMLElement>("#mobileDialogOverlay");
    expect(overlay?.hidden).toBe(false);
    expect(document.querySelector("#mobileDialogTitle")?.textContent).toBe("Continue?");
    expect(document.querySelector("#mobileDialogBody")?.textContent).toContain("Approve the operation?");
    expect(document.querySelector("#mobileDialogStatus")?.textContent).toContain("30s");

    document.querySelector<HTMLButtonElement>("#mobileDialogSubmit")?.click();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "dialog-1",
      response: { confirmed: true },
    });
    expect(overlay?.hidden).toBe(true);
  });

  it("renders select dialog requests and sends selected values", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: { id: "dialog-2", method: "select", title: "Pick target", options: ["alpha", "beta"] },
    });

    const select = document.querySelector<HTMLSelectElement>("#mobileDialogField select");
    if (!select) throw new Error("dialog select missing");
    select.value = "beta";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLFormElement>("#mobileDialogForm")?.requestSubmit();

    expect(connection.sent).toContainEqual({
      type: "dialog.respond",
      sessionId: "live",
      dialogId: "dialog-2",
      response: { value: "beta" },
    });
  });

  it("renders open_url dialog requests without sending extension responses", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: {
        id: "dialog-open",
        method: "open_url",
        title: "Open login URL",
        instructions: "Use this link to continue.",
        url: "https://auth.example.test/mobile",
      },
    });

    const overlay = document.querySelector<HTMLElement>("#mobileDialogOverlay");
    expect(overlay?.hidden).toBe(false);
    expect(document.querySelector("#mobileDialogTitle")?.textContent).toBe("Open login URL");
    expect(document.querySelector("#mobileDialogBody")?.textContent).toContain("Use this link to continue.");
    expect(document.querySelector<HTMLAnchorElement>("#mobileDialogField a")?.href).toBe("https://auth.example.test/mobile");
    expect(document.querySelector<HTMLButtonElement>("#mobileDialogSubmit")?.hidden).toBe(true);

    document.querySelector<HTMLButtonElement>("#mobileDialogCancel")?.click();

    expect(overlay?.hidden).toBe(true);
    expect(connection.sent.some(message => message.type === "dialog.respond")).toBe(false);
  });

  it("applies extension editor text updates to the mobile prompt draft", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: { id: "dialog-3", method: "set_editor_text", text: "draft from extension" },
    });

    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.value).toBe("draft from extension");
    expect(document.querySelector("#mobileLog")?.textContent).toBe("");
    expect(connection.sent.some(message => message.type === "dialog.respond")).toBe(false);
  });

  it("keeps the composer enabled while the active session is busy", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy session" }) }),
    });

    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#mobileSendButton")?.disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#mobileImageInput")?.disabled).toBe(false);
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Agent busy");
  });

  it("captures busy prompt drafts from submit and sends follow-up on demand", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy session" }) }),
    });

    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!input || !form) throw new Error("prompt form missing");
    input.value = "queue this after";
    form.requestSubmit();

    expect(connection.sent.some(message => message.type === "prompt.send" && message.text === "queue this after")).toBe(false);
    expect(document.querySelector<HTMLElement>("#mobileBusyPromptOverlay")?.hidden).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>("#mobileBusyPromptText")?.value).toBe("queue this after");

    document.querySelector<HTMLButtonElement>("#mobileBusyPromptFollowUp")?.click();

    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "busy",
      text: "queue this after",
      behavior: "followUp",
    });
    expect(document.querySelector<HTMLElement>("#mobileBusyPromptOverlay")?.hidden).toBe(true);
    expect(input.value).toBe("");
  });

  it("renders session-scoped plan review and blocks prompts until refine or approve", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    connection.emit({
      type: "plan.review",
      sessionId: "live",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Review me",
      content: "Plan body",
    });

    expect(document.querySelector(".plan-review-card")?.textContent).toContain("Plan ready: Review me");
    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#mobileSendButton")?.disabled).toBe(true);
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Plan review waiting");

    const input = document.querySelector<HTMLTextAreaElement>("#mobilePromptInput");
    const form = document.querySelector<HTMLFormElement>("#mobilePromptForm");
    if (!input || !form) throw new Error("prompt form missing");
    input.value = "should not send";
    form.requestSubmit();
    expect(connection.sent.some(message => message.type === "prompt.send" && message.text === "should not send")).toBe(false);

    document.querySelector<HTMLButtonElement>(".plan-review-discuss")?.click();
    expect(connection.sent).toContainEqual({ type: "plan.discuss", sessionId: "live" });
    expect(document.querySelector(".plan-review-card")?.textContent).toContain("Discussing plan: Review me");
    expect(input.disabled).toBe(false);

    connection.emit({
      type: "plan.review",
      sessionId: "live",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Review me",
      content: "Plan body",
    });

    document.querySelector<HTMLButtonElement>(".plan-review-refine")?.click();
    expect(document.querySelector(".plan-review-card")?.textContent).toContain("Refining plan: Review me");
    expect(document.querySelector(".message-review-toggle")?.textContent).toBe("Review");
    expect(input.disabled).toBe(false);
    vi.spyOn(window, "prompt").mockReturnValue("Fix the second step");
    document.querySelector<HTMLButtonElement>(".plan-review-card .message-review-toggle")?.click();
    document.querySelector<HTMLButtonElement>(".plan-review-card .transcript-review-comment-btn")?.click();
    document.querySelector<HTMLButtonElement>(".plan-review-card .transcript-review-actions button:last-child")?.click();
    expect(document.querySelector<HTMLTextAreaElement>("#mobileReviewPreviewText")?.value).toContain("I reviewed a finalized plan");
    document.querySelector<HTMLButtonElement>("#mobileReviewPreviewSend")?.click();
    expect(connection.sent.some(message =>
      message.type === "prompt.send" &&
      message.sessionId === "live" &&
      message.text.includes("Please refine the plan to address these comments"),
    )).toBe(true);

    connection.emit({
      type: "plan.review",
      sessionId: "live",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Review me",
      content: "Plan body",
    });
    document.querySelector<HTMLButtonElement>(".plan-review-approve")?.click();

    expect(connection.sent).toContainEqual({
      type: "plan.approve",
      sessionId: "live",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Review me",
      content: "Plan body",
      approvalMode: "execute",
    });
  });
  it("renders prompt busy choices and sends steer behavior", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy session" }) }),
    });

    connection.emit({ type: "prompt.busy", sessionId: "busy", text: "interrupt now", images: null });

    expect(document.querySelector<HTMLElement>("#mobileBusyPromptOverlay")?.hidden).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>("#mobileBusyPromptText")?.value).toBe("interrupt now");

    document.querySelector<HTMLButtonElement>("#mobileBusyPromptSteer")?.click();

    expect(connection.sent).toContainEqual({
      type: "prompt.send",
      sessionId: "busy",
      text: "interrupt now",
      behavior: "steer",
    });
    expect(document.querySelector<HTMLElement>("#mobileBusyPromptOverlay")?.hidden).toBe(true);
  });

  it("restores prompt busy drafts with image attachments on cancel", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy session" }) }),
    });

    connection.emit({
      type: "prompt.busy",
      sessionId: "busy",
      text: "look at this",
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    });

    expect(document.querySelector("#mobileBusyPromptAttachmentNote")?.textContent).toBe("1 attachment will be sent with this prompt.");
    document.querySelector<HTMLButtonElement>("#mobileBusyPromptCancel")?.click();

    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.value).toBe("look at this");
    const previews = document.querySelector<HTMLElement>("#mobileImagePreviews");
    expect(previews?.hidden).toBe(false);
    expect(previews?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(document.querySelector<HTMLElement>("#mobileBusyPromptOverlay")?.hidden).toBe(true);
  });

  it("clears the active session when a later snapshot no longer contains it", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live"), summary("other")] });
    clickSession(0);
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    expect(document.querySelector("#mobileSessionTitle")?.textContent).toBe("Session live");

    connection.emit({ type: "sessions.snapshot", sessions: [summary("other")] });

    expect(document.querySelector("#mobileSessionTitle")?.textContent).toBe("No session selected");
    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(true);
  });

  it("prefills the mobile create form from bridge config", () => {
    createHarness();

    openCreateDrawer();

    expect(document.querySelector<HTMLInputElement>("#mobileCreateCwd")?.value).toBe("/repo");
    expect(document.querySelector("#mobileCreateDrawer")?.hasAttribute("hidden")).toBe(false);
  });

  it("sends a normal cwd-based session.create from the mobile create form", () => {
    const { connection } = createHarness();

    openCreateDrawer();
    submitCreateForm("Mobile session", "/tmp/mobile");

    const createMessage = connection.sent.find(message => message.type === "session.create");
    expect(createMessage).toMatchObject({
      type: "session.create",
      cwd: "/tmp/mobile",
      name: "Mobile session",
    });
    expect(createMessage).not.toHaveProperty("worktree");
    expect(document.querySelector("#mobileCreateStatus")?.textContent).toBe("Creating session…");
  });

  it("renders proposed model options and sends selected proposedModelId", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "config.updated",
      config: {
        ...config,
        proposedModels: [{
          id: "fast-review",
          name: "Fast review",
          provider: "mock",
          modelId: "mock-reasoner",
          modelName: "Mock Reasoner",
          thinkingLevel: "high",
        }],
      },
    });

    openCreateDrawer();
    const select = document.querySelector<HTMLSelectElement>("#mobileCreateProposedModel");
    if (!select) throw new Error("model select missing");
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(["Default", "Fast review"]);
    select.value = "fast-review";
    submitCreateForm("Mobile session", "/tmp/mobile");

    expect(connection.sent.find(message => message.type === "session.create")).toMatchObject({
      proposedModelId: "fast-review",
    });
  });


  it("resets the mobile create proposed model selection when config removes it", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "config.updated",
      config: {
        ...config,
        proposedModels: [{
          id: "fast-review",
          name: "Fast review",
          provider: "mock",
          modelId: "mock-reasoner",
          modelName: "Mock Reasoner",
          thinkingLevel: "high",
        }],
      },
    });
    openCreateDrawer();
    const select = document.querySelector<HTMLSelectElement>("#mobileCreateProposedModel");
    if (!select) throw new Error("model select missing");
    select.value = "fast-review";
    connection.emit({
      type: "config.updated",
      config: {
        ...config,
        proposedModels: [],
      },
    });
    expect(select.value).toBe("default");
  });
  it("opens model templates in a dialog, requests the runtime catalog, and sends config.set when adding a mobile proposed model", () => {
    const { connection } = createHarness();
    document.querySelector<HTMLButtonElement>("#mobileOptionsToggle")?.click();
    expect(connection.sent.some(message => message.type === "config.modelCatalog.list")).toBe(false);
    document.querySelector<HTMLButtonElement>("#mobileModelTemplatesOpen")?.click();
    expect(document.querySelector("#mobileOptionsMenu")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#mobileProposedModelsOverlay")?.hasAttribute("hidden")).toBe(false);
    const catalogRequest = connection.sent.find(message => message.type === "config.modelCatalog.list");
    expect(catalogRequest).toBeTruthy();
    connection.emit({
      type: "config.modelCatalog.list",
      requestId: catalogRequest?.requestId,
      models: [{ provider: "mock", id: "mock-reasoner", name: "Mock Reasoner", contextWindow: 1000000, thinking: true }],
    });
    const search = document.querySelector<HTMLInputElement>("#mobileProposedModelSearch");
    if (!search) throw new Error("proposed model search missing");
    search.value = "reasoner";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const name = document.querySelector<HTMLInputElement>("#mobileProposedModelName");
    if (!name) throw new Error("proposed model name missing");
    name.value = "Fast review";
    document.querySelector<HTMLButtonElement>("#mobileProposedModelAdd")?.click();

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

  it("rejects mobile session creation without a working directory", () => {
    const { connection } = createHarness();

    openCreateDrawer();
    submitCreateForm("Mobile session", "");

    expect(connection.sent.some(message => message.type === "session.create")).toBe(false);
    expect(document.querySelector("#mobileCreateStatus")?.textContent).toBe("Working directory is required.");
  });

  it("derives mobile worktree defaults from the shared create view model", () => {
    createHarness();
    openCreateDrawer();
    const nameInput = document.querySelector<HTMLInputElement>("#mobileCreateName");
    const cwdInput = document.querySelector<HTMLInputElement>("#mobileCreateCwd");
    const enabled = document.querySelector<HTMLInputElement>("#mobileCreateWorktreeEnabled");
    if (!nameInput || !cwdInput || !enabled) throw new Error("create form missing");
    nameInput.value = "Feature Mobile";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    cwdInput.value = "/repo/app";
    cwdInput.dispatchEvent(new Event("input", { bubbles: true }));
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.querySelector<HTMLInputElement>("#mobileCreateWorktreeSourceRepo")?.value).toBe("/repo/app");
    expect(document.querySelector<HTMLInputElement>("#mobileCreateWorktreeDirectory")?.value).toBe("/repo/app-Feature Mobile");
    expect(document.querySelector<HTMLInputElement>("#mobileCreateWorktreeBase")?.value).toBe("HEAD");
    expect(document.querySelector<HTMLInputElement>("#mobileCreateWorktreeBranch")?.value).toBe("Feature Mobile");
    expect(document.querySelector("#mobileCreateWorktreeSummary")?.textContent)
      .toBe("Create branch Feature Mobile from HEAD at /repo/app-Feature Mobile, using /repo/app.");
  });

  it("sends a worktree session.create from the mobile create form", () => {
    const { connection } = createHarness();

    openCreateDrawer();
    enableWorktreeCreate({
      sourceRepo: "/repo",
      directory: "/repo-feature",
      baseBranch: "main",
      branchName: "feature/mobile",
    });
    submitCreateForm("Feature mobile", "/ignored-cwd");

    const createMessage = connection.sent.find(message => message.type === "session.create");
    expect(createMessage).toMatchObject({
      type: "session.create",
      name: "Feature mobile",
      worktree: {
        sourceRepo: "/repo",
        directory: "/repo-feature",
        baseBranch: "main",
        branchName: "feature/mobile",
      },
    });
    expect(createMessage).not.toHaveProperty("cwd");
  });

  it("rejects incomplete mobile worktree create fields", () => {
    const { connection } = createHarness();

    openCreateDrawer();
    enableWorktreeCreate({ sourceRepo: "/repo", directory: "", baseBranch: "main" });
    submitCreateForm("Feature mobile", "/ignored-cwd");

    expect(connection.sent.some(message => message.type === "session.create")).toBe(false);
    expect(document.querySelector("#mobileCreateStatus")?.textContent).toBe("Worktree working directory is required.");
    expect(document.activeElement).toBe(document.querySelector("#mobileCreateWorktreeDirectory"));
  });

  it("activates and closes the create drawer when the created session snapshot arrives", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("existing")] });

    openCreateDrawer();
    submitCreateForm("Mobile session", "/tmp/mobile");
    connection.emit({
      type: "session.snapshot",
      sessionId: "created",
      state: projection("created", { summary: summary("created", { title: "Mobile session", cwd: "/tmp/mobile" }) }),
    });

    expect(document.querySelector("#mobileSessionTitle")?.textContent).toBe("Mobile session");
    expect(document.querySelector("#mobileCreateDrawer")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#mobileCreateStatus")?.textContent).toBe("");
  });

  it("does not expose or request mobile diff workflows", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    expect(document.querySelector("#mobileDiffTab")).toBeNull();
    expect(document.querySelector("#mobileDiff")).toBeNull();
    expect(document.querySelector("#mobileDiffCommentOverlay")).toBeNull();
    expect(connection.sent.some(message => message.type === "sessionChanges.request")).toBe(false);
  });

  it("sends Goal Mode controls from the mobile goal card", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live", { goalMode: null }) });

    const objective = document.querySelector<HTMLTextAreaElement>(".goal-mode-objective-input");
    const budget = document.querySelector<HTMLInputElement>(".goal-mode-budget-input");
    objective!.value = "Ship mobile Goal Mode controls";
    budget!.value = "1234";
    document.querySelector<HTMLFormElement>(".goal-mode-start-controls")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    expect(connection.sent).toContainEqual({
      type: "goal.start",
      sessionId: "live",
      objective: "Ship mobile Goal Mode controls",
      tokenBudget: 1234,
    });

    connection.emit({
      type: "session.snapshot",
      sessionId: "live",
      state: projection("live", {
        goalMode: {
          enabled: true,
          mode: "active",
          goal: {
            id: "goal-1",
            objective: "Ship mobile Goal Mode controls",
            status: "active",
            tokenBudget: 1234,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      }),
    });
    document.querySelector<HTMLButtonElement>(".goal-mode-action-controls button")?.click();

    expect(connection.sent).toContainEqual({ type: "goal.control", sessionId: "live", action: "pause" });
  });
});
