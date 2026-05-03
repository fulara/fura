import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FuraConnection } from "./connection";
import { mountMobileApp, type MobileConnectionOptions } from "./mobileApp";
import type { ClientMessage, ServerConfig, ServerMessage, SessionProjection, SessionSummary } from "./protocol";

class FakeConnection implements FuraConnection {
  sent: ClientMessage[] = [];
  connected = false;
  closed = false;

  constructor(readonly options: MobileConnectionOptions) {}

  connect(): void {
    this.connected = true;
    this.options.onStatus("connected", "connected");
    this.options.onOpen?.();
  }

  disconnect(): void {
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

const config: ServerConfig = { defaultCwd: "/repo", voiceLanguage: "en" };

function createHarness(path = "/mobile.html?token=dev") {
  document.body.innerHTML = `<div id="app"></div>`;
  window.localStorage.clear();
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

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionId,
    status: "idle",
    createdAt: 1,
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

function diffState(
  diff = "src/main.ts | 2 ++",
  overrides: Partial<import("./protocol").RepoDiffState> = {},
): import("./protocol").RepoDiffState {
  const base = {
    entryId: "base-1",
    label: "session start",
    kind: "session-start" as const,
    createdAt: "2026-05-02T00:00:00Z",
    repoRoot: "/repo",
  };
  return {
    snapshots: [base],
    selectedSnapshot: base,
    headSnapshot: null,
    diff,
    stat: true,
    ...overrides,
  };
}

function clickSession(index = 0): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("#mobileSessionsList .session-item button");
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
  it("bootstraps cookie auth from the URL token and requests sessions on open", () => {
    const { connection, debug } = createHarness();

    expect(window.location.href).toBe("http://localhost:3000/mobile.html");
    expect(window.localStorage.getItem("fura.token")).toBe("dev");
    expect(connection.options.auth).toEqual({ type: "sessionCookie", token: "dev" });
    expect(connection.sent).toContainEqual({ type: "session.list" });
    expect(document.querySelector("#mobileConnectionStatus")?.textContent).toBe("connected");
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

    expect(connection.sent).toContainEqual({ type: "session.attach", sessionId: "live" });
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
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Ready · 1 image");

    previews?.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')?.click();

    expect(previews?.hidden).toBe(true);
    expect(previews?.querySelector("img")).toBeNull();
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Ready");
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
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Ready");
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

  it("applies extension editor text updates to the mobile prompt draft", () => {
    const { connection } = createHarness();
    connection.emit({
      type: "dialog.request",
      sessionId: "live",
      dialog: { id: "dialog-3", method: "set_editor_text", text: "draft from extension" },
    });

    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.value).toBe("draft from extension");
    expect(document.querySelector("#mobileLog")?.textContent).toBe("Extension updated the mobile prompt draft.");
    expect(connection.sent.some(message => message.type === "dialog.respond")).toBe(false);
  });

  it("disables the composer while the active session is busy", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("busy", { status: "busy" })] });
    clickSession();
    connection.emit({
      type: "session.snapshot",
      sessionId: "busy",
      state: projection("busy", { isBusy: true, summary: summary("busy", { status: "busy", title: "Busy session" }) }),
    });

    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#mobileSendButton")?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#mobileImageInput")?.disabled).toBe(true);
    expect(document.querySelector("#mobileComposerStatus")?.textContent).toBe("Agent busy");
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

  it("requests and renders mobile diff state for the active session", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });

    expect(connection.sent).not.toContainEqual({ type: "diff.refresh", sessionId: "live", stat: true });

    document.querySelector<HTMLButtonElement>("#mobileDiffTab")?.click();
    expect(connection.sent).toContainEqual({ type: "diff.refresh", sessionId: "live", stat: true });
    expect(document.querySelector("#mobileDiff")?.textContent).toContain("Loading diff");

    connection.emit({ type: "diff.state", sessionId: "live", state: diffState() });

    expect(document.querySelector("#mobileDiff")?.textContent).toContain("src/main.ts | 2 ++");
    expect(document.querySelector("#mobileDiff")?.textContent).toContain("Base: session start");
    expect(document.querySelector<HTMLTextAreaElement>("#mobilePromptInput")?.disabled).toBe(false);
  });

  it("renders structured mobile diff rows and requests selected comparisons", () => {
    const { connection } = createHarness();
    const base = { entryId: "base-1", label: "session start", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo" };
    const manual = { entryId: "manual-1", label: "manual", kind: "manual" as const, createdAt: "2026-05-02T01:00:00Z", repoRoot: "/repo" };
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "@@ -1 +1 @@",
      "-console.log('old')",
      "+console.log('new')",
    ].join("\n");
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    document.querySelector<HTMLButtonElement>("#mobileDiffTab")?.click();
    connection.emit({
      type: "diff.state",
      sessionId: "live",
      state: diffState(patch, { snapshots: [base, manual], selectedSnapshot: base, stat: false }),
    });

    expect(document.querySelector("#mobileDiff")?.textContent).toContain("Modified files (1)");
    expect(document.querySelector("#mobileDiff")?.textContent).toContain("+1 -1");
    expect(document.querySelector(".mobile-diff-file")?.textContent).toContain("diff --git");
    expect(document.querySelector(".mobile-diff-line-remove")?.textContent).toContain("old");
    expect(document.querySelector(".mobile-diff-line-add")?.textContent).toContain("new");

    const selects = document.querySelectorAll<HTMLSelectElement>(".mobile-diff-field select");
    selects[0]!.value = "manual-1";
    selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(connection.sent).toContainEqual({ type: "diff.refresh", sessionId: "live", selector: "manual-1", stat: false });
  });

  it("switches mobile diff between stat and full diff", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    document.querySelector<HTMLButtonElement>("#mobileDiffTab")?.click();
    connection.emit({ type: "diff.state", sessionId: "live", state: diffState() });

    const fullButton = [...document.querySelectorAll<HTMLButtonElement>(".mobile-diff-actions button")]
      .find(button => button.textContent === "Full");
    fullButton?.click();

    expect(connection.sent).toContainEqual({ type: "diff.refresh", sessionId: "live", selector: "base-1", stat: false });
  });

  it("shows diff errors without leaving the diff tab", () => {
    const { connection } = createHarness();
    connection.emit({ type: "sessions.snapshot", sessions: [summary("live")] });
    clickSession();
    connection.emit({ type: "session.snapshot", sessionId: "live", state: projection("live") });
    document.querySelector<HTMLButtonElement>("#mobileDiffTab")?.click();

    connection.emit({ type: "session.notice", sessionId: "live", level: "error", text: "diff failed" });

    expect(document.querySelector("#mobileDiff")?.textContent).toContain("diff failed");
    expect(document.querySelector("#mobileDiff")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("#mobileTranscript")?.hasAttribute("hidden")).toBe(true);
  });
});
