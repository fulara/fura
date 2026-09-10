import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import type { ClientMessage, ServerMessage } from "../src/protocol";

declare global {
  interface Window {
    __historyBranchReceived: Record<string, number>;
  }
}

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ALLOW_PROTOCOL: "",
};
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", root, ...args], {
    env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function source(value: string) {
  return Array.from({ length: 15 }, (_, index) => index === 7
    ? `export const value = '${value}';`
    : `export const context_${index + 1} = ${index + 1};`).join("\n") + "\n";
}
function fixture(label: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fura-history-branch-${label}-`)));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "History Branch Reviewer");
  git(root, "config", "user.email", "history-branch@example.invalid");
  const commit = (subject: string) => {
    git(root, "add", ".");
    git(root, "-c", "commit.gpgsign=false", "commit", "-qm", subject);
    return git(root, "rev-parse", "HEAD");
  };
  writeFileSync(path.join(root, "same.ts"), source(`${label}_BASE`));
  writeFileSync(path.join(root, "staged.ts"), "export const staged = 'BASE';\n");
  const initial = commit(`${label} initial`);
  git(root, "checkout", "-qb", "topic");
  const topic: string[] = [];
  for (let index = 1; index <= 35; index += 1) {
    writeFileSync(path.join(root, "same.ts"), source(`${label}_TOPIC_${index}`));
    topic.push(commit(`${label} topic ${index}`));
  }
  git(root, "update-ref", "refs/remotes/origin/shared", topic[34]);
  git(root, "checkout", "-qb", "remote-seed", initial);
  writeFileSync(path.join(root, "same.ts"), source(`${label}_REMOTE`));
  const remote = commit(`${label} remote only`);
  git(root, "update-ref", "refs/remotes/origin/topic", remote);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/topic");
  git(root, "checkout", "-q", "main");
  git(root, "branch", "-D", "remote-seed");
  writeFileSync(path.join(root, "same.ts"), source(`${label}_MAIN`));
  const main = commit(`${label} main only`);
  git(root, "tag", "topic", main); // Deliberate short-name collision; branch selection must use the full ref.
  writeFileSync(path.join(root, "same.ts"), source(`${label}_DIRTY_SENTINEL`));
  writeFileSync(path.join(root, "staged.ts"), "export const staged = 'STAGED_SENTINEL';\n");
  git(root, "add", "staged.ts");
  writeFileSync(path.join(root, "untracked.txt"), `${label}_UNTRACKED_SENTINEL\n`);
  return { root, label, initial, topic, remote, main, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
// Includes HEAD, refs, index, object store, tracked files and untracked sentinels.
// Take a fresh fingerprint after each explicit fixture ref mutation, never across it.
function fingerprint(root: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result.push([path.relative(root, file), createHash("sha256")
        .update(entry.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex")]);
    }
  }
  visit(root);
  return result;
}
function view(page: Page) { return page.locator(".session-changes-view:visible"); }
function branch(page: Page) { return view(page).getByRole("combobox", { name: "History branch", exact: true }); }
function rows(page: Page) { return view(page).locator(".git-history-commit"); }
async function gitPanel(page: Page) { await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click(); }
async function authenticate(page: Page) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, root: string, name: string) {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill(root);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await gitPanel(page);
}
async function session(page: Page, name: string) {
  await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await gitPanel(page);
}
async function history(page: Page) {
  await view(page).getByRole("button", { name: "History", exact: true }).click();
  // Every case fails on the pre-feature UI, before any unsupported interaction.
  await expect(branch(page)).toBeVisible();
}
async function selected(page: Page, oid: string) {
  await expect(view(page).locator(".diff-commit-message")).toContainText(oid);
}
async function choose(page: Page, ref: string, oid: string) {
  await branch(page).selectOption(ref);
  await expect(branch(page)).toHaveValue(ref);
  await expect(rows(page).first()).toHaveAttribute("data-commit-oid", oid);
  await selected(page, oid);
}
async function options(page: Page) {
  const details = view(page).locator(".git-review-options");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}
async function addRepo(page: Page, root: string) {
  await options(page);
  page.once("dialog", dialog => dialog.accept(root));
  await view(page).getByRole("button", { name: "Add", exact: true }).click();
  const selector = view(page).getByRole("combobox", { name: "Repository", exact: true });
  await expect(selector.locator("option").filter({ hasText: path.basename(root) })).toHaveCount(1);
  await selector.selectOption(root);
  await expect(view(page).locator(".git-root-path")).toHaveText(root);
}
async function repo(page: Page, root: string) {
  await view(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(root);
  await expect(view(page).locator(".git-root-path")).toHaveText(root);
}
async function advanced(page: Page, root: string, base: string, head: string) {
  await options(page);
  await view(page).getByRole("button", { name: "Advanced Compare", exact: true }).click();
  await expect(page.locator("#cwdPickerDiffRepo")).toHaveValue(root);
  await expect(page.locator("#cwdPickerDiffBase")).toHaveValue(base);
  await expect(page.locator("#cwdPickerDiffHead")).toHaveValue(head);
}

type HistoryMessage = Extract<ServerMessage, { type: "git.history" }>;
async function transport(page: Page) {
  // Observe delivery in the actual browser, so stale-reply assertions cannot pass
  // before the released WebSocket event has reached the application.
  const wire: Wire = {
    requests: [], responses: [],
    hold: () => false,
    held: [],
    async release() {
      const held = wire.held.splice(0);
      const counts = await page.evaluate(() => window.__historyBranchReceived);
      for (const frame of held) { counts[frame.key] = (counts[frame.key] ?? 0) + 1; frame.send(); }
      await expect.poll(() => page.evaluate(expected => {
        const actual = window.__historyBranchReceived;
        return Object.entries(expected).filter(([key, count]) => (actual[key] ?? 0) < count)
          .map(([key, count]) => ({ key, expected: count, actual: actual[key] ?? 0 }));
      }, counts)).toEqual([]);
    },
  };
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(data => { wire.requests.push(JSON.parse(data.toString())); server.send(data); });
    server.onMessage(data => {
      const message: ServerMessage = JSON.parse(data.toString());
      wire.responses.push(message);
      if (wire.hold(message)) {
        const key = message.type === "git.history" ? `history:${message.requestId}`
          : message.type === "sessionChanges.summary" ? `summary:${message.state.diffId}` : "";
        wire.held.push({ key, send: () => route.send(data) });
      } else route.send(data);
    });
  });
  await page.addInitScript(() => {
    const received: Record<string, number> = {};
    Object.assign(window, { __historyBranchReceived: received });
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", event => {
          const message = JSON.parse(String(event.data));
          const key = message.type === "git.history" ? `history:${message.requestId}`
            : message.type === "sessionChanges.summary" ? `summary:${message.state.diffId}` : "";
          if (key) received[key] = (received[key] ?? 0) + 1;
        });
      }
    };
  });
  return wire;
}
type Wire = {
  requests: ClientMessage[];
  responses: ServerMessage[];
  hold(message: ServerMessage): boolean;
  held: Array<{ key: string; send: () => void }>;
  release(): Promise<void>;
};
function pages(wire: Wire): HistoryMessage[] { return wire.responses.filter(message => message.type === "git.history"); }
function ready(wire: Wire, oid: string) {
  const message = wire.responses.filter(message => message.type === "sessionChanges.summary"
    && message.state.status === "ready" && message.state.review.currentCommitOid === oid).at(-1);
  if (!message || message.type !== "sessionChanges.summary" || message.state.status !== "ready") {
    throw new Error(`No real commit review received for ${oid}`);
  }
  return message.state;
}

test.beforeEach(({ page }) => page.on("pageerror", error => { throw error; }));

test("History branch selector reads HEAD, local and remote commits without changing checkout, comments or immutable files", async ({ page }, info) => {
  test.setTimeout(120_000);
  const a = fixture("choices"), wire = await transport(page);
  try {
    await authenticate(page);
    await createSession(page, a.root, `History choices ${Date.now()}`);
    const before = fingerprint(a.root), requestBoundary = wire.requests.length;
    await history(page);
    await expect(branch(page)).toHaveValue("");
    await selected(page, a.main);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", a.main);
    const values = await branch(page).locator("option").evaluateAll(elements => elements.map(element => element.getAttribute("value")));
    expect(values.slice().sort()).toEqual(["", "refs/heads/main", "refs/heads/topic", "refs/remotes/origin/shared", "refs/remotes/origin/topic"].sort());
    await choose(page, "refs/heads/topic", a.topic[34]);
    await expect(rows(page)).toHaveCount(30);
    await expect(view(page).locator(".git-head-label")).toContainText(/Checkout.*main/);
    await expect(view(page).locator(".git-head-label")).toContainText(a.main.slice(0, 12));
    await expect(view(page).locator(".git-history-browser")).toContainText(a.topic[34].slice(0, 12));
    await expect(view(page).locator(".diff-line-remove")).toContainText("choices_TOPIC_34");
    await expect(view(page).locator(".diff-line-add")).toContainText("choices_TOPIC_35");
    const identity = ready(wire, a.topic[34]).comparison;
    expect(identity.leftTreeOrCommit).toBe(a.topic[33]);
    expect(identity.rightTreeOrCommit).toBe(a.topic[34]);
    await page.screenshot({ path: info.outputPath("history-checkout-main-viewed-topic.png"), fullPage: true });
    expect(fingerprint(a.root)).toEqual(before);

    await view(page).locator(".diff-line-add .diff-comment-btn").first().click();
    await view(page).locator(".review-comment-composer-input").fill("TOPIC_COMMIT_ONLY_NOTE");
    await view(page).getByRole("button", { name: "Comment", exact: true }).click();
    await expect(view(page)).toContainText("TOPIC_COMMIT_ONLY_NOTE");
    await choose(page, "refs/remotes/origin/topic", a.remote);
    await expect(rows(page)).toHaveCount(2);
    await expect(view(page)).not.toContainText("TOPIC_COMMIT_ONLY_NOTE");
    await expect(view(page).locator(".diff-line-remove")).toContainText("choices_BASE");
    await expect(view(page).locator(".diff-line-add")).toContainText("choices_REMOTE");
    expect(ready(wire, a.remote).comparison.leftTreeOrCommit).toBe(a.initial);
    await choose(page, "refs/remotes/origin/shared", a.topic[34]);
    await expect(view(page)).toContainText("TOPIC_COMMIT_ONLY_NOTE");
    expect(ready(wire, a.topic[34]).comparison.comparisonKey).toBe(identity.comparisonKey);
    await view(page).locator(`[data-commit-oid="${a.topic[33]}"]`).click();
    await selected(page, a.topic[33]);
    await expect(view(page)).not.toContainText("TOPIC_COMMIT_ONLY_NOTE");
    await choose(page, "refs/heads/topic", a.topic[34]);
    await expect(view(page)).toContainText("TOPIC_COMMIT_ONLY_NOTE");

    const file = view(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]');
    await file.click({ button: "right" });
    await page.locator(".diffs-file-menu:visible").getByRole("button", { name: "View committed file", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(modal.locator(".git-file-content")).toHaveText(source("choices_TOPIC_35"));
    await expect(modal).toContainText(a.topic[34]);
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await file.click({ button: "right" });
    await page.locator(".diffs-file-menu:visible").getByRole("button", { name: "View this revision in Code", exact: true }).click();
    const code = page.locator(".code-revision-view:visible");
    await expect(code).toContainText(a.topic[34].slice(0, 12));
    await expect(code).toContainText(/read-only/i);
    expect(await code.locator(".code-line-content").allTextContents()).toEqual(source("choices_TOPIC_35").trimEnd().split("\n"));
    await expect(code).not.toContainText("DIRTY_SENTINEL");
    await gitPanel(page);
    await view(page).getByRole("button", { name: "Current changes", exact: true }).click();
    const group = view(page).getByRole("combobox", { name: "Git change group", exact: true });
    await group.selectOption("unstaged");
    await expect(view(page).locator(".diffs-main-body")).toContainText("choices_DIRTY_SENTINEL");
    await expect(view(page).locator(".diffs-main-body")).not.toContainText("choices_TOPIC_35");
    await group.selectOption("staged");
    await expect(view(page).locator(".diffs-main-body")).toContainText("STAGED_SENTINEL");
    await group.selectOption("untracked");
    await expect(view(page).locator(".diffs-main-body")).toContainText("choices_UNTRACKED_SENTINEL");
    await history(page);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, a.topic[34]);
    expect(git(a.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(a.root, "rev-parse", "HEAD")).toBe(a.main);
    expect(fingerprint(a.root)).toEqual(before);
    expect(wire.requests.slice(requestBoundary).filter(message => ["diff.reviewWorktree.ensure", "diff.reviewWorktree.checkout", "review.agentReview.start", "prompt.send", "session.create"].includes(message.type))).toEqual([]);
  } finally { a.cleanup(); }
});

test("History branch selector pins older pages and Latest keeps off-page review and Advanced Compare endpoints", async ({ page }) => {
  const a = fixture("pinned"), wire = await transport(page);
  try {
    await authenticate(page);
    await createSession(page, a.root, `History pinned ${Date.now()}`);
    let before = fingerprint(a.root);
    await history(page);
    await choose(page, "refs/heads/topic", a.topic[34]);
    await expect(rows(page)).toHaveCount(30);
    expect(fingerprint(a.root)).toEqual(before);
    // Explicit fixture mutation: append a commit without touching checkout or index.
    const tree = git(a.root, "rev-parse", `${a.topic[34]}^{tree}`);
    const advancedTip = git(a.root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", a.topic[34], "-m", "pinned topic advanced externally");
    git(a.root, "update-ref", "refs/heads/topic", advancedTip, a.topic[34]);
    before = fingerprint(a.root);
    await view(page).getByRole("button", { name: "Load older commits", exact: true }).click();
    await expect(rows(page)).toHaveCount(36);
    expect(await rows(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-commit-oid")))).toEqual([...a.topic].reverse().concat(a.initial));
    const older = pages(wire).at(-1)!.page!;
    expect(older.historyHeadOid).toBe(a.topic[34]);
    expect(older.historyTipOid).toBe(advancedTip);
    expect(older.branches).toBeNull();
    await view(page).locator(`[data-commit-oid="${a.topic[0]}"]`).click();
    await selected(page, a.topic[0]);
    await view(page).getByRole("button", { name: "Latest", exact: true }).click();
    await expect(rows(page)).toHaveCount(30);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", advancedTip);
    await expect(view(page).locator(`[data-commit-oid="${a.topic[0]}"]`)).toHaveCount(0);
    await selected(page, a.topic[0]);
    await expect(view(page).locator(".diff-line-add")).toContainText("pinned_TOPIC_1");
    expect(pages(wire).at(-1)!.page!.historyHeadOid).toBe(advancedTip);
    await advanced(page, a.root, a.initial, a.topic[0]);
    await page.locator("#cwdPickerCancel").click();
    await selected(page, a.topic[0]);
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); }
});

test("History branch selector keeps deleted-ref cursors usable and handles missing, detached, unborn and root reviews", async ({ page }) => {
  test.setTimeout(120_000);
  const a = fixture("deleted"), wire = await transport(page);
  const unborn = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-history-branch-unborn-")));
  git(unborn, "init", "-q", "-b", "new-branch");
  writeFileSync(path.join(unborn, "untracked.txt"), "UNBORN_UNTRACKED_SENTINEL\n");
  try {
    await authenticate(page);
    await createSession(page, a.root, `History deleted ${Date.now()}`);
    let before = fingerprint(a.root);
    await history(page);
    await choose(page, "refs/heads/topic", a.topic[34]);
    expect(fingerprint(a.root)).toEqual(before);
    git(a.root, "update-ref", "-d", "refs/heads/topic", a.topic[34]);
    before = fingerprint(a.root);
    await view(page).getByRole("button", { name: "Load older commits", exact: true }).click();
    await expect(rows(page)).toHaveCount(36);
    expect(pages(wire).at(-1)!.page!.historyTipOid).toBeNull();
    await view(page).locator(`[data-commit-oid="${a.topic[0]}"]`).click();
    await selected(page, a.topic[0]);
    await view(page).getByRole("button", { name: "Latest", exact: true }).click();
    await expect(view(page).locator(".git-history-browser").getByRole("alert")).toContainText(/missing|not found|no longer|does not exist|cannot resolve/i);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, a.topic[0]);
    await choose(page, "", a.main);
    await view(page).locator(`[data-commit-oid="${a.initial}"]`).click();
    await selected(page, a.initial);
    await advanced(page, a.root, "", a.initial);
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeVisible();
    await expect(page.locator("#cwdPickerStatus")).toContainText(/explicit Base/i);
    await page.locator("#cwdPickerCancel").click();
    expect(fingerprint(a.root)).toEqual(before);

    // Detach the fixture by updating HEAD only; keep dirty/staged/untracked bytes intact.
    git(a.root, "update-ref", "--no-deref", "HEAD", a.main);
    before = fingerprint(a.root);
    await view(page).getByRole("button", { name: "Latest", exact: true }).click();
    await expect(view(page).locator(".git-head-label")).toContainText("Detached HEAD");
    await choose(page, "refs/remotes/origin/topic", a.remote);
    await expect(view(page).locator(".git-head-label")).toContainText(a.main.slice(0, 12));
    expect(fingerprint(a.root)).toEqual(before);
    await addRepo(page, unborn);
    const unbornBefore = fingerprint(unborn);
    await history(page);
    await expect(branch(page)).toHaveValue("");
    await expect(view(page).locator(".git-head-label")).toContainText("new-branch");
    await expect(view(page).locator(".git-history-list")).toContainText("No commits yet");
    await expect(rows(page)).toHaveCount(0);
    expect(await branch(page).locator("option").evaluateAll(elements => elements.map(element => element.getAttribute("value")))).toEqual([""]);
    await view(page).getByRole("button", { name: "Current changes", exact: true }).click();
    await view(page).getByRole("combobox", { name: "Git change group", exact: true }).selectOption("untracked");
    await expect(view(page).locator(".diffs-main-body")).toContainText("UNBORN_UNTRACKED_SENTINEL");
    expect(fingerprint(unborn)).toEqual(unbornBefore);
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); rmSync(unborn, { recursive: true, force: true }); }
});

test("History branch selector rejects delayed real replies across fast branch, repository and session switches", async ({ page }) => {
  test.setTimeout(120_000);
  const a = fixture("race-A"), b = fixture("race-B"), wire = await transport(page);
  const nameA = `History race A ${Date.now()}`, nameB = `History race B ${Date.now()}`;
  try {
    await authenticate(page);
    await createSession(page, a.root, nameA);
    await history(page);
    await createSession(page, b.root, nameB);
    await history(page);
    await session(page, nameA);
    const beforeA = fingerprint(a.root), beforeB = fingerprint(b.root);
    wire.hold = message => message.type === "git.history" && message.page?.repoRoot === a.root && message.page.historyRef === "refs/heads/topic";
    await branch(page).selectOption("refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    // The selector must stay operable while an earlier branch is loading.
    await choose(page, "refs/remotes/origin/topic", a.remote);
    wire.hold = () => false;
    await wire.release();
    await expect(branch(page)).toHaveValue("refs/remotes/origin/topic");
    await selected(page, a.remote);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", a.remote);

    wire.hold = message => message.type === "git.history" && message.page?.repoRoot === a.root && message.page.historyRef === "refs/heads/topic";
    await branch(page).selectOption("refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await addRepo(page, b.root);
    await choose(page, "refs/remotes/origin/topic", b.remote);
    wire.hold = () => false;
    await wire.release();
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveValue("refs/remotes/origin/topic");
    await selected(page, b.remote);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", b.remote);

    await repo(page, a.root);
    await choose(page, "refs/remotes/origin/topic", a.remote);
    wire.hold = message => message.type === "git.history" && message.page?.repoRoot === a.root && message.page.historyRef === "refs/heads/topic";
    await branch(page).selectOption("refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await session(page, nameB);
    await choose(page, "refs/heads/topic", b.topic[34]);
    wire.hold = () => false;
    await wire.release();
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, b.topic[34]);
    await session(page, nameA);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, a.topic[34]);

    // A late real parent-review summary must not resurrect the old branch's patch.
    wire.hold = message => message.type === "sessionChanges.summary" && message.state.status === "ready"
      && message.state.review.currentCommitOid === a.topic[33];
    await view(page).locator(`[data-commit-oid="${a.topic[33]}"]`).click();
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await choose(page, "refs/remotes/origin/topic", a.remote);
    wire.hold = () => false;
    await wire.release();
    await selected(page, a.remote);
    await expect(view(page).locator(".diffs-main-body")).toContainText("race-A_REMOTE");
    await expect(view(page).locator(".diffs-main-body")).not.toContainText("race-A_TOPIC_34");
    expect(fingerprint(a.root)).toEqual(beforeA);
    expect(fingerprint(b.root)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});

test("History branch selector persists independent choices across reloads, repositories and sessions", async ({ page }) => {
  test.setTimeout(120_000);
  const a = fixture("persist-A"), b = fixture("persist-B");
  const nameA = `History persistence A ${Date.now()}`, nameB = `History persistence B ${Date.now()}`;
  try {
    await authenticate(page);
    await createSession(page, a.root, nameA);
    await history(page);
    await choose(page, "refs/heads/topic", a.topic[34]);
    await view(page).locator(`[data-commit-oid="${a.topic[33]}"]`).click();
    await selected(page, a.topic[33]);
    await addRepo(page, b.root);
    await choose(page, "refs/remotes/origin/topic", b.remote);
    await createSession(page, a.root, nameB);
    await history(page);
    await expect(branch(page)).toHaveValue("");
    await choose(page, "refs/remotes/origin/topic", a.remote);
    const beforeA = fingerprint(a.root), beforeB = fingerprint(b.root);
    await session(page, nameA);
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveValue("refs/remotes/origin/topic");
    await selected(page, b.remote);
    await repo(page, a.root);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, a.topic[33]);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await session(page, nameA);
    await expect(branch(page)).toHaveValue("refs/heads/topic");
    await selected(page, a.topic[33]);
    await repo(page, b.root);
    await expect(branch(page)).toHaveValue("refs/remotes/origin/topic");
    await selected(page, b.remote);
    await session(page, nameB);
    await expect(view(page).locator(".git-root-path")).toHaveText(a.root);
    await expect(branch(page)).toHaveValue("refs/remotes/origin/topic");
    await selected(page, a.remote);
    await choose(page, "", a.main);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await session(page, nameB);
    await expect(branch(page)).toHaveValue("");
    await selected(page, a.main);
    expect(fingerprint(a.root)).toEqual(beforeA);
    expect(fingerprint(b.root)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});
