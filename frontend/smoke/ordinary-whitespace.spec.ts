import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ClientMessage, ServerMessage } from "../src/protocol";

// External config must use a private Fura bridge and fixtures/mock-omp-rpc.mjs.
// Git fixtures, index, clipboard and popup windows belong only to this test.
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "",
};
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false", "-C", root, ...args], {
    env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
type Repo = {
  root: string; base: string; head: string; tip: string;
  committed: string; staged: string; working: string;
  put(file: string, text: string): void; cleanup(): void;
};
function fixture(): Repo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-ordinary-whitespace-")));
  const put = (file: string, text: string) => writeFileSync(path.join(root, file), text);
  const commit = (subject: string) => {
    git(root, "add", "."); git(root, "commit", "-qm", subject);
    return git(root, "rev-parse", "HEAD").trim();
  };
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Whitespace Reviewer");
    git(root, "config", "user.email", "whitespace@example.invalid");
    const mixed = (name: string, spaced: boolean) => [
      "export const context_1 = 1;", "export const context_2 = 2;",
      spaced ? "\texport  const whitespace_only = 3;  \t" : "export const whitespace_only = 3;",
      "export const context_4 = 4;", `export const ${name} = 5;`,
      "export const context_6 = 6;", ...(spaced ? [""] : []),
      "export const context_7 = 7;", "export const context_8 = 8;", "",
    ].join("\n");
    put("mixed.ts", mixed("BASE_VALUE", false));
    put("spaces.txt", "alpha beta\ngamma delta\n");
    const base = commit("Whitespace base");
    const committed = mixed("COMMITTED_VALUE", true);
    put("mixed.ts", committed);
    put("spaces.txt", "\talpha  beta  \ngamma\tdelta\t\n");
    const head = commit("Whitespace and substantive change");
    put("later.txt", "LATER_COMMIT\n");
    const tip = commit("Later independent change");
    const staged = mixed("STAGED_VALUE", false);
    put("mixed.ts", staged);
    put("spaces.txt", "alpha\tbeta\ngamma   delta\n");
    git(root, "add", ".");
    const working = mixed("WORKTREE_VALUE", true);
    put("mixed.ts", working);
    put("spaces.txt", "  alpha beta\t\ngamma delta  \n");
    return { root, base, head, tip, committed, staged, working, put,
      cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
const diffs = (page: Page) => page.locator(".session-changes-view:visible");
const compare = (page: Page) => page.locator(".compare-view:visible");
const layout = (view: Locator) => view.getByRole("combobox", { name: "Diff layout", exact: true });
const whitespace = (view: Locator) => view.getByRole("checkbox", { name: "Ignore whitespace", exact: true });
const tab = (page: Page, title: string) => page.locator(".dv-tab:visible").filter({ hasText: new RegExp(`^${title}$`) });
const group = (page: Page, title: string) => page.locator(".dv-groupview:visible").filter({ has: tab(page, title) });
async function authenticate(page: Page) {
  await page.goto("/");
  // Install after Playwright's routing shim, before authentication opens the WS.
  await page.evaluate(() => {
    const received: string[] = [];
    Object.assign(window, { __ordinaryWhitespaceDelivered: received });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const fence = new MessageChannel();
        fence.port1.onmessage = event => received.push(String(event.data));
        this.addEventListener("message", event => fence.port2.postMessage(String(event.data)));
        this.addEventListener("close", () => { fence.port1.close(); fence.port2.close(); });
      }
    };
  });
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: Repo) {
  const name = `Whitespace ${path.basename(repo.root)}`;
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill(repo.root);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await tab(page, "Git changes").click();
  return name;
}
async function file(view: Locator, name = "mixed.ts") {
  await view.locator(`.diffs-file-jump[data-diff-file-path="${name}"]`).click();
  await expect(view.locator(`.diffs-file-jump.active[data-diff-file-path="${name}"]`)).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.FURA_SMOKE_EVIDENCE_DIR;
  if (directory) mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: directory ? path.join(directory, `${info.testId.replace(/[^a-z0-9_-]/gi, "_")}-${name}.png`) : info.outputPath(`${name}.png`), fullPage: false });
}

test.use({ viewport: { width: 1600, height: 1100 }, serviceWorkers: "block" });
test.setTimeout(60_000);
test.beforeEach(({ page }) => { page.on("pageerror", error => { throw error; }); });

test("Current changes loads a real patch before exposing Ignore whitespace", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); await createSession(page, repo);
    const view = diffs(page);
    await view.getByRole("button", { name: "Current changes", exact: true }).click();
    await file(view);
    await expect(view.locator(".diff-line-add").filter({ hasText: "WORKTREE_VALUE" })).toBeVisible();
    // RED must occur here, after the existing backend-generated patch is visible.
    await expect(whitespace(view)).toBeVisible();
    await expect(whitespace(view)).not.toBeChecked();
    await screenshot(page, info, "current-default-docked");
  } finally { repo.cleanup(); }
});

declare global {
  interface Window { __ordinaryWhitespaceDelivered: string[]; }
}
type Summary = Extract<ServerMessage, { type: "sessionChanges.summary" | "compareDiff.summary" }>;
type Content = Extract<ServerMessage, { type: "diff.content" }>["content"];
type Request = Extract<ClientMessage, { type: "sessionChanges.request" | "compareDiff.request" }>;
type Wire = {
  requests: ClientMessage[]; responses: ServerMessage[];
  hold(message: ServerMessage): boolean;
  held: Array<{ message: ServerMessage; send(): void }>;
  delivered(): Promise<void>; release(): Promise<void>;
};
async function transport(page: Page): Promise<Wire> {
  const forwarded: string[] = [];
  const wire: Wire = {
    requests: [], responses: [], held: [], hold: () => false,
    async delivered() {
      const expected = forwarded.slice();
      await expect.poll(() => page.evaluate(count => window.__ordinaryWhitespaceDelivered.slice(0, count), expected.length)).toEqual(expected);
    },
    async release() {
      for (const frame of wire.held.splice(0).reverse()) frame.send();
      await wire.delivered();
    },
  };
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(raw => { wire.requests.push(JSON.parse(raw.toString())); server.send(raw); });
    server.onMessage(raw => {
      const text = raw.toString(), message: ServerMessage = JSON.parse(text);
      wire.responses.push(message);
      const send = () => { forwarded.push(text); route.send(raw); };
      if (wire.hold(message)) wire.held.push({ message, send });
      else send();
    });
  });
  return wire;
}
async function summary(wire: Wire, enabled: boolean, scope: "sessionChanges" | "compareDiff" = "sessionChanges") {
  const matching = () => wire.responses.filter((message): message is Summary =>
    message.type === `${scope}.summary`).findLast(message =>
      (message.type === "compareDiff.summary" || message.state.status === "ready") && message.state.request.ignoreWhitespace === enabled);
  await expect.poll(matching).toBeDefined();
  const message = matching()!;
  if (message.type === "compareDiff.summary") return message.state;
  if (message.state.status !== "ready") throw new Error("No ready summary");
  return message.state;
}
async function content(wire: Wire, enabled: boolean, name = "mixed.ts", scope: "sessionChanges" | "compareDiff" = "sessionChanges") {
  const state = await summary(wire, enabled, scope);
  const matching = () => wire.responses.filter(message => message.type === "diff.content")
    .findLast(message => message.content.comparisonKey === state.comparison.comparisonKey
      && message.content.ignoreWhitespace === enabled && message.content.file?.newPath === name);
  await expect.poll(matching).toBeDefined();
  await wire.delivered();
  const patch = matching()!.content;
  expect(wire.requests.some(message => message.type === "diff.content.request"
    && message.diffId === patch.diffId && message.ignoreWhitespace === enabled
    && message.selectedFile?.newPath === name)).toBe(true);
  return patch;
}
function oracle(repo: Repo, mode: "unstaged" | "staged" | "history", patch: Content, enabled: boolean) {
  const refs = mode === "history" ? [repo.base, repo.head] : mode === "staged" ? ["--cached", repo.tip] : [];
  const expected = git(repo.root, "diff", "--no-ext-diff", "--no-textconv", "--no-color",
    "--find-renames=50%", "--diff-algorithm=myers", "--no-indent-heuristic",
    "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", ...refs,
    `--unified=${patch.contextLines}`, ...(enabled ? ["--ignore-all-space"] : []), "--", patch.file!.newPath);
  // Compare complete native output, including whitespace and empty-patch metadata.
  expect(patch.patch).toBe(expected);
  expect(patch.truncated).toBe(false);
}
async function openCompare(page: Page, repo: Repo) {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerDiffTab").click();
  await page.locator("#cwdPickerDiffMode").selectOption("full");
  await page.locator("#cwdPickerDiffRepo").fill(repo.root);
  await page.locator("#cwdPickerDiffBase").fill(repo.base);
  await page.locator("#cwdPickerDiffHead").fill(repo.head);
  await page.locator("#cwdPickerDiffAgentSession").uncheck();
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await file(compare(page));
}

test("saved whitespace preference never makes whitespace-only worktree enter clean History", async ({ page }, info) => {
  const repo = fixture(), wire = await transport(page);
  try {
    repo.put("mixed.ts", repo.committed);
    git(repo.root, "add", "mixed.ts");
    await authenticate(page);
    await page.evaluate(() => sessionStorage.setItem("fura.diff.ignoreWhitespace", "true"));
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await createSession(page, repo);
    const view = diffs(page);
    await expect(view.getByRole("button", { name: "Current changes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(whitespace(view)).toBeChecked();
    for (const kind of ["unstaged", "staged"]) {
      await view.getByRole("combobox", { name: "Git change group", exact: true }).selectOption(kind);
      await file(view, "spaces.txt");
      await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
      await expect(view.locator('.diffs-file-jump[data-diff-file-path="spaces.txt"]')).toBeVisible();
      expect(git(repo.root, "diff", ...(kind === "staged" ? ["--cached"] : []), "--ignore-all-space")).toBe("");
      const state = await summary(wire, true);
      expect(state).toMatchObject({ workingTreeDirty: true });
      expect(state.summary.files.map(file => file.newPath)).toEqual(["spaces.txt"]);
    }
    await screenshot(page, info, "whitespace-only-dirty-current");
  } finally { repo.cleanup(); }
});

for (const kind of ["unstaged", "staged"] as const) {
  test(`Current ${kind}: native whitespace semantics, unchanged real statistics, explicit empty patch in both layouts`, async ({ page }, info) => {
    const repo = fixture(), wire = await transport(page);
    const index = readFileSync(path.join(repo.root, ".git", "index"));
    try {
      await authenticate(page); await createSession(page, repo);
      const view = diffs(page);
      await view.getByRole("button", { name: "Current changes", exact: true }).click();
      await view.getByRole("combobox", { name: "Git change group", exact: true }).selectOption(kind);
      await file(view);
      await expect(view.locator(".diff-line-add").filter({ hasText: kind === "staged" ? "STAGED_VALUE" : "WORKTREE_VALUE" })).toBeVisible();
      const normal = await content(wire, false);
      oracle(repo, kind, normal, false);
      const before = await summary(wire, false);
      for (const display of ["unified", "split"]) {
        await layout(view).selectOption(display);
        const boundary = wire.requests.length;
        await whitespace(view).check();
        const filtered = await content(wire, true);
        oracle(repo, kind, filtered, true);
        const after = await summary(wire, true);
        expect(after.comparison.comparisonKey).toBe(before.comparison.comparisonKey);
        expect(after.summary).toEqual(before.summary);
        expect(after).toMatchObject({ workingTreeDirty: true });
        expect(after.request).toMatchObject({ ignoreWhitespace: true, changeKind: kind });
        expect(after.comparison).toMatchObject({ ignoreWhitespace: true });
        expect(wire.requests.slice(boundary).filter(message => message.type === "git.history.request")).toEqual([]);
        const meaningful = view.locator(".diff-line-add").filter({ hasText: kind === "staged" ? "STAGED_VALUE" : "WORKTREE_VALUE" });
        await expect(meaningful).toBeVisible();
        await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" })).toHaveCount(0);
        // Native -w does not erase inserted/deleted empty lines.
        expect(filtered.rows.some(row => row.type === "line" && row.location.kind !== "context" && row.location.text === row.prefix)).toBe(true);
        await file(view, "spaces.txt");
        const empty = await content(wire, true, "spaces.txt");
        oracle(repo, kind, empty, true);
        expect(empty.patch).toBe("");
        await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
        await expect(view.locator(".diff-line-add, .diff-line-remove")).toHaveCount(0);
        await expect(view.locator('.diffs-file-jump[data-diff-file-path="spaces.txt"]')).toBeVisible();
        await expect(view.locator('.diffs-file-jump[data-diff-file-path="spaces.txt"]')).toContainText("+2 -2");
        await expect(view.getByRole("button", { name: "Current changes", exact: true })).toHaveAttribute("aria-pressed", "true");
        expect(git(repo.root, "status", "--porcelain")).toContain("spaces.txt");
        await screenshot(page, info, `${kind}-${display}-empty-docked`);
        await whitespace(view).uncheck();
        await expect(view.locator(".diff-line-add").first()).toBeVisible();
        oracle(repo, kind, await content(wire, false, "spaces.txt"), false);
        await file(view);
      }
      expect(readFileSync(path.join(repo.root, ".git", "index"))).toEqual(index);
      expect(readFileSync(path.join(repo.root, "mixed.ts"), "utf8")).toBe(repo.working);
      expect(git(repo.root, "rev-parse", "HEAD").trim()).toBe(repo.tip);
    } finally { repo.cleanup(); }
  });
}

test("pinned History preserves canonical anchors and original Copy through layout, refresh, popup and reload", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const repo = fixture(), wire = await transport(page);
  let child: Page | null = null;
  try {
    await authenticate(page); const name = await createSession(page, repo);
    const view = diffs(page);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await view.locator(`[data-commit-oid="${repo.head}"]`).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await file(view);
    await expect(view.locator(".diff-line-add").filter({ hasText: "COMMITTED_VALUE" })).toBeVisible();
    const before = await content(wire, false);
    const boundary = wire.requests.length;
    await whitespace(view).check();
    const filtered = await content(wire, true);
    oracle(repo, "history", filtered, true);
    expect(filtered.comparisonKey).toBe(before.comparisonKey);
    const state = await summary(wire, true);
    expect(state.comparison).toMatchObject({ leftTreeOrCommit: repo.base, rightTreeOrCommit: repo.head });
    expect(state.request).toMatchObject({ currentCommitOid: repo.head });
    expect(wire.requests.slice(boundary).filter(message => message.type === "git.history.request")).toEqual([]);
    for (const display of ["unified", "split"]) {
      await layout(view).selectOption(display);
      await file(view, "spaces.txt");
      const empty = await content(wire, true, "spaces.txt");
      oracle(repo, "history", empty, true);
      await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
      await expect(view.locator('.diffs-file-jump[data-diff-file-path="spaces.txt"]')).toContainText("+2 -2");
      await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
      await file(view);
      await expect(whitespace(view)).toBeChecked();
      for (const [kind, token, line] of [
        ["remove", "BASE_VALUE", 5], ["add", "COMMITTED_VALUE", 5], ["context", "context_4", 4],
      ] as const) {
        const original = filtered.rows.find(row => row.type === "line" && row.location.kind === kind && row.location.text.includes(token));
        if (!original || original.type !== "line") throw new Error(`Missing canonical ${kind} anchor`);
        expect(original.location).toMatchObject(kind === "remove" ? { side: "left", oldLine: line } : { side: "right", newLine: line });
        const cells = display === "split" ? view.locator(`.diff-split-cell[data-diff-side="${kind === "remove" ? "left" : "right"}"]`) : view;
        const row = cells.locator(`.diff-line-${kind}`).filter({ hasText: token });
        await expect(row.locator(".diff-gutter")).toContainText(String(line));
        await row.locator(".diff-comment-btn").click();
        const body = `${display}_${kind}_ORIGINAL_ANCHOR`;
        await view.locator(".review-comment-composer-input").fill(body);
        await view.getByRole("button", { name: "Comment", exact: true }).click();
        await expect(view).toContainText(body);
        const request = wire.requests.findLast(message => message.type === "review.comment.create" && message.body === body);
        expect(request).toMatchObject({ repoRoot: repo.root, comparisonKey: filtered.comparisonKey, anchor: original.location });
        if (request?.type !== "review.comment.create") throw new Error("Missing submitted anchor");
        expect(request.anchor).toEqual(original.location);
      }
      const restore = view.getByRole("button", { name: "Restore layout", exact: true });
      if (await restore.isVisible()) await restore.click();
      await screenshot(page, info, `history-${display}-docked`);
      await view.getByRole("button", { name: "Expand review", exact: true }).click();
      await screenshot(page, info, `history-${display}-expanded`);
      await view.getByRole("button", { name: "Restore layout", exact: true }).click();
    }
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(modal.locator(".git-file-content")).toHaveText(repo.committed);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await modal.getByRole("button", { name: "Copy file", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(repo.committed);
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await whitespace(view).uncheck();
    await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
    await expect(view).toContainText("split_remove_ORIGINAL_ANCHOR");
    await whitespace(view).check();
    await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" })).toHaveCount(0);
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await expect(whitespace(view)).toBeChecked();
    await expect(view.locator(".diff-refresh-status")).toHaveCount(0);
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("Whitespace review keeps my unsent draft");
    await page.locator("#promptInput").focus();
    const refreshBoundary = wire.requests.length;
    // Explicitly synthetic notification; this is not evidence of native OS focus.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => wire.requests.slice(refreshBoundary).some(message => message.type === "sessionChanges.request" && message.ignoreWhitespace)).toBe(true);
    await expect(view.locator(".diff-refresh-status")).toHaveCount(0);
    await expect(group(page, "Git changes")).toHaveClass(/dv-inactive-group/);
    await expect(page.locator("#promptInput")).toBeFocused();
    await expect(whitespace(view)).toBeChecked();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    const opened = page.waitForEvent("popup");
    await group(page, "Git changes").locator(".panel-popout-btn").click();
    child = await opened;
    child.on("pageerror", error => { throw error; });
    const popped = diffs(child);
    await expect(whitespace(popped)).toBeChecked();
    await expect(layout(popped)).toHaveValue("split");
    await expect(popped.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await child.bringToFront();
    await whitespace(popped).focus();
    await whitespace(popped).uncheck();
    await expect(popped.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
    await expect(whitespace(popped)).toBeFocused();
    await whitespace(popped).check();
    await expect(popped.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" })).toHaveCount(0);
    await expect(whitespace(popped)).toBeFocused();
    // Same lifecycle fence as diffs-focus.spec.ts: Dockview 5.2 does not cancel
    // its resize-end timer on close. Observe persisted completion, not a sleep.
    for (const [title, id] of [["Code", "code"], ["Transcript", "transcript"]]) {
      await tab(page, title).click();
      await expect.poll(() => page.evaluate(expected => {
        const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
        function selected(value: unknown): boolean {
          return Boolean(value && typeof value === "object"
            && (("activeView" in value && value.activeView === expected) || Object.values(value).some(selected)));
        }
        return selected(saved.layout);
      }, id)).toBe(true);
    }
    await child.setViewportSize({ width: 1400, height: 950 });
    const actual = await child.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await expect.poll(() => page.evaluate(expected => {
      const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
      return saved.layout?.popoutGroups?.some((group: { position?: { width: number; height: number } }) =>
        group.position?.width === expected.width && group.position?.height === expected.height) ?? false;
    }, actual)).toBe(true);
    await screenshot(child, info, "history-native-popup");
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").focus();
    // A real browser window.close, not a dispatched beforeunload or CDP close.
    await child.evaluate(() => {
      window.addEventListener("beforeunload", () => {
        window.opener.document.documentElement.dataset.whitespaceNativeRedock = "yes";
      }, { once: true });
    });
    const closed = child.waitForEvent("close");
    await child.evaluate(() => window.close());
    await closed; child = null;
    await expect(page.locator("html")).toHaveAttribute("data-whitespace-native-redock", "yes");
    await expect(whitespace(view)).toBeChecked();
    await expect(layout(view)).toHaveValue("split");
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="mixed.ts"]')).toBeVisible();
    await expect(page.locator("#promptInput")).toBeFocused();
    await expect(page.locator("#promptInput")).toHaveValue("Whitespace review keeps my unsent draft");
    await screenshot(page, info, "history-native-redocked");
    // Reload only after the existing debounced layout save acknowledges redock.
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
      return saved.layout?.popoutGroups?.length ?? 0;
    })).toBe(0);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
    await tab(page, "Git changes").click();
    // Reload is an ordinary entry: real staged/unstaged dirtiness still wins.
    await expect(view.getByRole("button", { name: "Current changes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(whitespace(view)).toBeChecked();
    await expect(layout(view)).toHaveValue("split");
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    expect(readFileSync(path.join(repo.root, "mixed.ts"), "utf8")).toBe(repo.working);
    expect(git(repo.root, "rev-parse", "HEAD").trim()).toBe(repo.tip);
    expect(wire.requests.filter(message => ["prompt.send", "review.agentReview.start", "diff.reviewWorktree.ensure", "diff.reviewWorktree.checkout"].includes(message.type))).toEqual([]);
  } finally {
    try { await child?.close(); } finally { repo.cleanup(); }
  }
});

test("ordinary Compare shares native filtering across layouts while Range-diff remains independent", async ({ page }, info) => {
  const repo = fixture(), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, repo);
    await diffs(page).getByRole("button", { name: "Current changes", exact: true }).click();
    await file(diffs(page));
    await whitespace(diffs(page)).check();
    await content(wire, true);
    await openCompare(page, repo);
    const view = compare(page);
    await expect(whitespace(view)).toBeChecked();
    for (const display of ["unified", "split"]) {
      await layout(view).selectOption(display);
      const filtered = await content(wire, true, "mixed.ts", "compareDiff");
      oracle(repo, "history", filtered, true);
      await expect(view.locator(".diff-line-add").filter({ hasText: "COMMITTED_VALUE" })).toBeVisible();
      await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" })).toHaveCount(0);
      const state = await summary(wire, true, "compareDiff");
      expect(state.comparison).toMatchObject({ leftTreeOrCommit: repo.base, rightTreeOrCommit: repo.head });
      await screenshot(page, info, `compare-${display}`);
      await file(view, "spaces.txt");
      expect((await content(wire, true, "spaces.txt", "compareDiff")).patch).toBe("");
      await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
      await whitespace(view).uncheck();
      await expect(view.locator(".diff-line-add").first()).toBeVisible();
      await file(view);
      oracle(repo, "history", await content(wire, false, "mixed.ts", "compareDiff"), false);
      await whitespace(view).check();
    }
    await view.getByRole("combobox", { name: "Compare mode", exact: true }).selectOption("rangeDiff");
    await view.getByRole("textbox", { name: "Repository", exact: true }).fill(repo.root);
    await view.getByRole("textbox", { name: "Base", exact: true }).fill(repo.base);
    await view.getByRole("textbox", { name: "Old", exact: true }).fill(repo.head);
    await view.getByRole("textbox", { name: "New", exact: true }).fill(repo.tip);
    await expect(whitespace(view)).not.toBeChecked();
    for (const enabled of [true, false]) {
      await whitespace(view).setChecked(enabled);
      const boundary = wire.requests.length;
      await view.getByRole("button", { name: "Compare", exact: true }).click();
      await expect.poll(() => wire.requests.slice(boundary).find(message => message.type === "git.rangeDiff.request")).toBeDefined();
      const request = wire.requests.slice(boundary).find(message => message.type === "git.rangeDiff.request");
      if (request?.type !== "git.rangeDiff.request") throw new Error("Missing native range-diff request");
      expect(request.ignoreWhitespace).toBe(enabled);
      await expect.poll(() => wire.responses.find(message => message.type === "git.rangeDiff" && message.requestId === request.requestId)).toBeDefined();
      const response = wire.responses.find(message => message.type === "git.rangeDiff" && message.requestId === request.requestId);
      if (response?.type !== "git.rangeDiff" || !response.result) throw new Error("No native range-diff output");
      expect(response.error).toBeNull();
      expect(response.result.ignoreWhitespace).toBe(enabled);
      expect(stripVTControlCharacters(response.result.output)).toBe(stripVTControlCharacters(git(repo.root,
        "range-diff", "--no-ext-diff", "--no-textconv", "--color=always", "--dual-color",
        ...(enabled ? ["--ignore-all-space"] : []), repo.base, repo.head, repo.tip, "--")));
      await expect.poll(async () => (await view.locator(".range-diff-output").textContent())?.replaceAll(" (no change)", ""))
        .toBe(stripVTControlCharacters(response.result.output));
      await expect(view.locator(".diff-lines-split, .diff-split-cell")).toHaveCount(0);
    }
    await screenshot(page, info, "range-independent-native");
    await view.getByRole("combobox", { name: "Compare mode", exact: true }).selectOption("files");
    await file(view);
    await expect(whitespace(view)).toBeChecked();
    await expect(layout(view)).toHaveValue("split");
    await whitespace(view).uncheck();
    await tab(page, "Git changes").click();
    await expect(whitespace(diffs(page))).not.toBeChecked();
    await expect(diffs(page).locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
    expect(git(repo.root, "rev-parse", "HEAD").trim()).toBe(repo.tip);
    expect(readFileSync(path.join(repo.root, "mixed.ts"), "utf8")).toBe(repo.working);
  } finally { repo.cleanup(); }
});

for (const scope of ["sessionChanges", "compareDiff"] as const) {
  for (const late of [true, false]) {
    for (const heldType of ["summary", "content"] as const) {
      test(`${scope} ignores late ${late ? "on" : "off"} ${heldType} after opposite mode settles`, async ({ page }) => {
        const repo = fixture(), wire = await transport(page);
        try {
          await authenticate(page); await createSession(page, repo);
          if (scope === "compareDiff") await openCompare(page, repo);
          else {
            await diffs(page).getByRole("button", { name: "Current changes", exact: true }).click();
            await file(diffs(page));
          }
          const view = scope === "compareDiff" ? compare(page) : diffs(page);
          await whitespace(view).setChecked(!late);
          await content(wire, !late, "mixed.ts", scope);
          // Off-mode spaces have not been fetched: the late content case must
          // exercise a real lazy request rather than an already-warm cache.
          const selected = late ? "mixed.ts" : "spaces.txt";
          await file(view, selected);
          await content(wire, !late, selected, scope);
          const identity = await summary(wire, !late, scope);
          wire.hold = message => heldType === "summary"
            ? ((message.type === "sessionChanges.summary" || message.type === "compareDiff.summary")
              && message.type === `${scope}.summary` && message.state.request.ignoreWhitespace === late)
            : (message.type === "diff.content" && message.content.scope === scope && message.content.ignoreWhitespace === late);
          const boundary = wire.requests.length;
          await whitespace(view).setChecked(late);
          await expect.poll(() => wire.held.length).toBeGreaterThan(0);
          const stale = wire.requests.slice(boundary).find(message => message.type === `${scope}.request`) as Request;
          expect(stale).toMatchObject({ ignoreWhitespace: late });
          // The stale native response already exists but has not reached the app.
          await wire.delivered();
          wire.hold = () => false;
          await whitespace(view).setChecked(!late);
          await expect.poll(() => wire.requests.slice(boundary).filter(message => message.type === `${scope}.request`).length).toBe(2);
          const current = wire.requests.slice(boundary).filter(message => message.type === `${scope}.request`).at(-1) as Request;
          expect(current.diffId).not.toBe(stale.diffId);
          expect(current).toMatchObject({ ignoreWhitespace: !late });
          await expect.poll(() => wire.responses.some(message =>
            (message.type === "sessionChanges.summary" || message.type === "compareDiff.summary")
            && message.type === `${scope}.summary` && message.state.diffId === current.diffId)).toBe(true);
          await wire.delivered();
          if (late) await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
          else await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
          // Opposite-mode response is delivered first; reverse-release old frames
          // only after the new DOM is settled. Task fence observes application delivery.
          await wire.release();
          if (late) await expect(whitespace(view)).not.toBeChecked();
          else await expect(whitespace(view)).toBeChecked();
          await expect(view.locator(`.diffs-file-jump.active[data-diff-file-path="${selected}"]`)).toBeVisible();
          if (late) await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
          else {
            await expect(view.locator(".diffs-main-body")).toContainText(/no patch changes.*ignore whitespace/i);
            await expect(view.locator(".diff-line-add, .diff-line-remove")).toHaveCount(0);
          }
          await expect(view.locator(".diffs-error, [role='alert']")).toHaveCount(0);
          const accepted = await summary(wire, !late, scope);
          expect(accepted.comparison.comparisonKey).toBe(identity.comparison.comparisonKey);
          expect(accepted.comparison.leftTreeOrCommit).toBe(identity.comparison.leftTreeOrCommit);
          expect(accepted.comparison.rightTreeOrCommit).toBe(identity.comparison.rightTreeOrCommit);
          expect(wire.requests.slice(boundary).filter(message => ["git.history.request", "session.create", "session.attach", "sessionRepos.update", "diff.reviewWorktree.checkout"].includes(message.type))).toEqual([]);
        } finally { wire.held.length = 0; repo.cleanup(); }
      });
    }
  }
}

test("late real Git error from on-mode cannot replace successful off-mode", async ({ page }) => {
  const repo = fixture(), wire = await transport(page);
  const indexPath = path.join(repo.root, ".git", "index"), originalIndex = readFileSync(indexPath);
  try {
    await authenticate(page); await createSession(page, repo);
    const view = diffs(page);
    await view.getByRole("button", { name: "Current changes", exact: true }).click();
    await file(view); await content(wire, false);
    // Only this owned fixture is damaged, and restored before the new request.
    writeFileSync(indexPath, "invalid private index for stale error regression");
    wire.hold = message => message.type === "diff.error";
    const boundary = wire.requests.length;
    await whitespace(view).check();
    await expect.poll(() => wire.held.some(frame => frame.message.type === "diff.error")).toBe(true);
    const failed = wire.requests.slice(boundary).find(message => message.type === "sessionChanges.request");
    if (failed?.type !== "sessionChanges.request") throw new Error("No failing request");
    expect(wire.held.some(frame => frame.message.type === "diff.error" && frame.message.diffId === failed.diffId)).toBe(true);
    writeFileSync(indexPath, originalIndex);
    wire.hold = () => false;
    await whitespace(view).uncheck();
    await expect.poll(() => wire.requests.slice(boundary).filter(message => message.type === "sessionChanges.request").length).toBe(2);
    const recovered = wire.requests.slice(boundary).filter(message => message.type === "sessionChanges.request").at(-1)!;
    await expect.poll(() => wire.responses.some(message => message.type === "sessionChanges.summary" && message.state.diffId === recovered.diffId)).toBe(true);
    await wire.delivered();
    await expect(view.locator(".diff-line-add").filter({ hasText: "WORKTREE_VALUE" })).toBeVisible();
    await wire.release();
    await expect(view.locator(".diffs-error, [role='alert']")).toHaveCount(0);
    await expect(whitespace(view)).not.toBeChecked();
    await expect(view.locator(".diff-line-add, .diff-line-remove").filter({ hasText: "whitespace_only" }).first()).toBeVisible();
  } finally {
    writeFileSync(indexPath, originalIndex);
    wire.held.length = 0; repo.cleanup();
  }
});

for (const replacement of ["session", "repository", "refs"] as const) {
  test(`filtered content cannot cross a ${replacement} replacement`, async ({ page }) => {
    const first = fixture(), second = fixture(), wire = await transport(page);
    try {
      second.put("mixed.ts", second.working.replace("WORKTREE_VALUE", "SECOND_WORKTREE_VALUE"));
      await authenticate(page);
      await createSession(page, first);
      if (replacement === "refs") {
        await openCompare(page, first);
      } else {
        await diffs(page).getByRole("button", { name: "Current changes", exact: true }).click();
        if (replacement === "repository") {
          await diffs(page).locator(".git-review-options > summary").click();
          page.once("dialog", dialog => dialog.accept(second.root));
          await diffs(page).getByRole("button", { name: "Add", exact: true }).click();
          await expect(diffs(page).getByRole("combobox", { name: "Repository", exact: true })
            .locator("option").filter({ hasText: path.basename(second.root) })).toHaveCount(1);
        }
        await file(diffs(page));
      }
      const scope = replacement === "refs" ? "compareDiff" : "sessionChanges";
      const view = replacement === "refs" ? compare(page) : diffs(page);
      await content(wire, false, "mixed.ts", scope);
      wire.hold = message => message.type === "diff.content"
        && message.content.scope === scope && message.content.ignoreWhitespace === true;
      await whitespace(view).check();
      await expect.poll(() => wire.held.some(frame => frame.message.type === "diff.content")).toBe(true);
      const held = wire.held.find(frame => frame.message.type === "diff.content")!.message;
      if (held.type !== "diff.content") throw new Error("Missing held native patch");
      wire.hold = () => false;
      let selected = "mixed.ts", expected = "SECOND_WORKTREE_VALUE";
      if (replacement === "session") {
        await createSession(page, second);
      } else if (replacement === "repository") {
        await view.getByRole("combobox", { name: "Repository", exact: true }).selectOption(second.root);
      } else {
        await view.getByRole("textbox", { name: "Base", exact: true }).fill(first.head);
        await view.getByRole("textbox", { name: "Head", exact: true }).fill(first.tip);
        await view.getByRole("button", { name: "Compare", exact: true }).click();
        selected = "later.txt";
        expected = "LATER_COMMIT";
      }
      await file(view, selected);
      const current = await content(wire, true, selected, scope);
      expect(current.diffId).not.toBe(held.content.diffId);
      expect(current.comparisonKey).not.toBe(held.content.comparisonKey);
      const state = await summary(wire, true, scope);
      expect(state.comparison.repoRoot).toBe(replacement === "refs" ? first.root : second.root);
      if (replacement === "refs") {
        expect(state.comparison).toMatchObject({ leftTreeOrCommit: first.head, rightTreeOrCommit: first.tip });
        oracle({ ...first, base: first.head, head: first.tip }, "history", current, true);
      } else {
        oracle(second, "unstaged", current, true);
      }
      await expect(view.locator(".diff-line-add").filter({ hasText: expected })).toBeVisible();
      await wire.release();
      await expect(whitespace(view)).toBeChecked();
      await expect(view.locator(`.diffs-file-jump.active[data-diff-file-path="${selected}"]`)).toBeVisible();
      await expect(view.locator(".diff-line-add").filter({ hasText: expected })).toBeVisible();
      await expect(view.locator(".diffs-error, [role='alert']")).toHaveCount(0);
      expect(git(first.root, "rev-parse", "HEAD").trim()).toBe(first.tip);
      expect(git(second.root, "rev-parse", "HEAD").trim()).toBe(second.tip);
    } finally {
      wire.held.length = 0;
      first.cleanup();
      second.cleanup();
    }
  });
}
