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
function branch(page: Page) { return view(page).getByRole("button", { name: "History branch", exact: true }); }
async function pickBranch(page: Page, ref: string) {
  if (!await branch(page).isVisible()) await history(page);
  await branch(page).click();
  await view(page).getByRole("combobox", { name: "Filter History branches", exact: true }).fill(ref || "HEAD");
  await view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option").and(view(page).getByTitle(ref || "HEAD", { exact: true })).click();
}
async function branchValues(page: Page) {
  await branch(page).click();
  const values = await view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option").evaluateAll(elements => elements.map(element => element.getAttribute("title")));
  await view(page).getByRole("combobox", { name: "Filter History branches", exact: true }).press("Escape");
  return values;
}
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
  await history(page);
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
  await pickBranch(page, ref);
  await expect(branch(page)).toHaveAttribute("title", ref || "HEAD");
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
  await history(page);
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
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await selected(page, a.main);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", a.main);
    const values = await branchValues(page);
    expect(values.slice().sort()).toEqual(["HEAD", "refs/heads/main", "refs/heads/topic", "refs/remotes/origin/shared", "refs/remotes/origin/topic"].sort());
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
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
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
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
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
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await expect(view(page).locator(".git-head-label")).toContainText("new-branch");
    await expect(view(page).locator(".git-history-list")).toContainText("No commits yet");
    await expect(rows(page)).toHaveCount(0);
    expect(await branchValues(page)).toEqual(["HEAD"]);
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
    await pickBranch(page, "refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    // The selector must stay operable while an earlier branch is loading.
    await choose(page, "refs/remotes/origin/topic", a.remote);
    wire.hold = () => false;
    await wire.release();
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/topic");
    await selected(page, a.remote);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", a.remote);

    wire.hold = message => message.type === "git.history" && message.page?.repoRoot === a.root && message.page.historyRef === "refs/heads/topic";
    await pickBranch(page, "refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await addRepo(page, b.root);
    await choose(page, "refs/remotes/origin/topic", b.remote);
    wire.hold = () => false;
    await wire.release();
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/topic");
    await selected(page, b.remote);
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", b.remote);

    await repo(page, a.root);
    await choose(page, "refs/remotes/origin/topic", a.remote);
    wire.hold = message => message.type === "git.history" && message.page?.repoRoot === a.root && message.page.historyRef === "refs/heads/topic";
    await pickBranch(page, "refs/heads/topic");
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await session(page, nameB);
    await choose(page, "refs/heads/topic", b.topic[34]);
    wire.hold = () => false;
    await wire.release();
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
    await selected(page, b.topic[34]);
    await session(page, nameA);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
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
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await choose(page, "refs/remotes/origin/topic", a.remote);
    const beforeA = fingerprint(a.root), beforeB = fingerprint(b.root);
    await session(page, nameA);
    await expect(view(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/topic");
    await selected(page, b.remote);
    await repo(page, a.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
    await selected(page, a.topic[33]);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await session(page, nameA);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
    await selected(page, a.topic[33]);
    await repo(page, b.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/topic");
    await selected(page, b.remote);
    await session(page, nameB);
    await expect(view(page).locator(".git-root-path")).toHaveText(a.root);
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/topic");
    await selected(page, a.remote);
    await choose(page, "", a.main);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await session(page, nameB);
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await selected(page, a.main);
    expect(fingerprint(a.root)).toEqual(beforeA);
    expect(fingerprint(b.root)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});

test("History loading controls retain readable commits through a real failure and retry", async ({ page }, info) => {
  const a = fixture("loading-controls"), wire = await transport(page);
  try {
    await authenticate(page);
    await createSession(page, a.root, `History loading controls ${Date.now()}`);
    await history(page);
    await choose(page, "refs/heads/topic", a.topic[34]);
    const latest = view(page).getByRole("button", { name: "Latest", exact: true });
    const older = view(page).locator(".git-history-footer button");
    const retained = await rows(page).allTextContents();
    wire.hold = message => message.type === "git.history";
    await older.click();
    await expect.poll(() => wire.held.length).toBe(1);
    await expect(latest).toBeDisabled();
    await expect(older).toBeDisabled();
    await expect(branch(page)).toBeEnabled();
    expect(await rows(page).allTextContents()).toEqual(retained);
    wire.hold = () => false;
    await wire.release();
    await expect(latest).toBeEnabled();
    await expect(older).toBeDisabled();

    // Only the disposable fixture changes. Browser reads must leave it untouched.
    git(a.root, "update-ref", "-d", "refs/heads/topic");
    const before = fingerprint(a.root);
    const readable = await rows(page).allTextContents();
    await latest.click();
    await expect(view(page).locator(".git-history-error")).toBeVisible();
    await expect(latest).toBeEnabled();
    await expect(branch(page)).toBeEnabled();
    expect(await rows(page).allTextContents()).toEqual(readable);
    await page.screenshot({ path: info.outputPath("history-failure-readable.png") });

    wire.hold = message => message.type === "git.history";
    await pickBranch(page, "");
    await expect.poll(() => wire.held.length).toBe(1);
    await expect(latest).toBeDisabled();
    await expect(older).toBeDisabled();
    await expect(view(page).locator(".git-history-error")).toHaveCount(0);
    wire.hold = () => false;
    await wire.release();
    await expect(latest).toBeEnabled();
    await expect(rows(page).first()).toHaveAttribute("data-commit-oid", a.main);
    await selected(page, a.main);
    await expect(view(page).locator(".diffs-main-body")).toContainText("loading-controls_MAIN");
    expect(fingerprint(a.root)).toEqual(before);
    await page.screenshot({ path: info.outputPath("history-recovered.png") });
  } finally { a.cleanup(); }
});

test("History branch picker searches transiently and orders real tips by committer date", async ({ page }, info) => {
  const a = fixture("search-order"), wire = await transport(page);
  try {
    const tree = git(a.root, "rev-parse", `${a.initial}^{tree}`);
    const dated = (message: string, author: string, committer: string) => execFileSync("git",
      ["-C", a.root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", a.main, "-m", message],
      { encoding: "utf8", env: { ...gitEnvironment, GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer } }).trim();
    const newest = dated("Newest committer, old author", "2001-01-01T00:00:00Z", "2040-01-01T00:00:00Z");
    const older = dated("Older committer, future author", "2090-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    const recent = ["refs/heads/origin/twin", "refs/heads/za/Żółć", "refs/heads/zz/newest", "refs/remotes/origin/twin"];
    for (const ref of recent) git(a.root, "update-ref", ref, newest);
    git(a.root, "update-ref", "refs/heads/aaa/oldest", older);
    git(a.root, "tag", "zz/newest", older);
    const before = fingerprint(a.root);
    await authenticate(page); await createSession(page, a.root, `Search order ${Date.now()}`);
    await history(page); await selected(page, a.main);
    expect((await branchValues(page)).slice(0, 6)).toEqual(["HEAD", ...recent, "refs/heads/aaa/oldest"]);
    const requestCount = () => wire.requests.filter(message => message.type === "git.history.request" || message.type === "sessionChanges.request").length;
    const boundary = requestCount();
    await branch(page).click();
    const search = view(page).getByRole("combobox", { name: "Filter History branches", exact: true });
    await search.fill("TWIN");
    await expect(view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option")).toHaveText(["Local: origin/twin", "Remote: origin/twin"]);
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await selected(page, a.main);
    expect(requestCount()).toBe(boundary);
    await page.screenshot({ path: info.outputPath("branch-search-desktop.png") });
    await search.press("Escape");
    await expect(search).toBeHidden();
    await expect(branch(page)).toBeFocused();
    await branch(page).click();
    await expect(search).toHaveValue("");
    await search.fill("no-such-branch");
    await expect(view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option")).toHaveCount(0);
    await view(page).getByRole("button", { name: /Clear/ }).click();
    await expect(search).toHaveValue("");
    await search.fill("ZA/ŻÓŁĆ");
    await expect(view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option")).toHaveText(["Local: za/Żółć"]);
    await search.press("Enter");
    await selected(page, newest);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/za/Żółć");
    await branch(page).click();
    await search.fill("twin");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(branch(page)).toHaveAttribute("title", "refs/remotes/origin/twin");
    await selected(page, newest);
    await choose(page, "refs/heads/aaa/oldest", older);
    await expect(view(page).locator(".git-head-label")).toContainText(/Checkout.*main/);
    await page.setViewportSize({ width: 760, height: 850 });
    await branch(page).scrollIntoViewIfNeeded();
    await expect(branch(page)).toBeInViewport();
    await branch(page).click();
    await search.fill("twin");
    await expect(search).toBeInViewport();
    await expect(view(page).getByRole("listbox", { name: "History branches", exact: true }).getByRole("option").last()).toBeInViewport();
    await page.screenshot({ path: info.outputPath("branch-search-narrow.png") });
    await search.press("Tab");
    await expect(search).toBeHidden();
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/aaa/oldest");
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); }
});

test("ordinary entry Compare cancellation rejects a delayed real working-tree probe", async ({ page }) => {
  const a = fixture("compare-interruption"), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, a.root, `Compare interruption ${Date.now()}`);
    await history(page); await choose(page, "refs/heads/topic", a.topic[34]);
    const restore = view(page).getByRole("button", { name: "Restore layout", exact: true });
    if (await restore.count()) await restore.click();
    await page.locator(".dv-tab:visible").filter({ hasText: "Code" }).click();
    wire.hold = message => message.type === "sessionChanges.summary" && message.state.status === "ready"
      && message.state.review.currentCommitOid === null;
    await gitPanel(page);
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    const before = fingerprint(a.root);
    await advanced(page, a.root, a.topic[33], a.topic[34]);
    await page.locator("#cwdPickerCancel").click();
    wire.hold = () => false;
    await wire.release();
    await selected(page, a.topic[34]);
    await expect(view(page).locator(".git-review-navigation [aria-pressed=true]")).toHaveText("History");
    await expect(view(page).locator(".diffs-main-body")).toContainText("compare-interruption_TOPIC_35");
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); }
});

test("ordinary entry preserves the selected History file through a clean status probe", async ({ page }) => {
  const a = fixture("file-entry");
  try {
    git(a.root, "restore", "--staged", "--worktree", ".");
    rmSync(path.join(a.root, "untracked.txt"));
    const before = fingerprint(a.root);
    await authenticate(page); await createSession(page, a.root, `File entry ${Date.now()}`);
    await selected(page, a.main);
    const file = view(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]');
    await file.click();
    await expect(file).toHaveClass(/active/);
    const restore = view(page).getByRole("button", { name: "Restore layout", exact: true });
    if (await restore.count()) await restore.click();
    await page.locator(".dv-tab:visible").filter({ hasText: "Code" }).click();
    await gitPanel(page);
    await selected(page, a.main);
    await expect(file).toHaveClass(/active/);
    await expect(view(page).locator(".diffs-all-files-jump")).not.toHaveClass(/active/);
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); }
});

test("History branch picker survives a delayed real review response without committing its query", async ({ page }) => {
  const a = fixture("picker-refresh"), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, a.root, `Picker refresh ${Date.now()}`);
    wire.hold = message => message.type === "sessionChanges.summary" && message.state.status === "ready"
      && message.state.review.currentCommitOid === a.main;
    await history(page);
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await branch(page).click();
    const search = view(page).getByRole("combobox", { name: "Filter History branches", exact: true });
    await search.fill("refs/heads/topic");
    const before = fingerprint(a.root);
    wire.hold = () => false;
    await wire.release();
    await selected(page, a.main);
    await expect(search).toHaveValue("refs/heads/topic");
    await expect(search).toBeFocused();
    await expect(branch(page)).toHaveAttribute("title", "HEAD");
    await search.press("Enter");
    await selected(page, a.topic[34]);
    await expect(branch(page)).toHaveAttribute("title", "refs/heads/topic");
    expect(fingerprint(a.root)).toEqual(before);
  } finally { a.cleanup(); }
});

test("History branch picker selects full refs in a popped-out review", async ({ page }, info) => {
  const a = fixture("picker-popout");
  let popout: Page | null = null;
  try {
    await authenticate(page); await createSession(page, a.root, `Picker popout ${Date.now()}`);
    await history(page); await selected(page, a.main);
    const before = fingerprint(a.root);
    const opened = page.waitForEvent("popup");
    await page.locator(".dv-groupview").filter({ has: page.locator(".dv-tab").filter({ hasText: "Git changes" }) }).locator(".panel-popout-btn").click();
    popout = await opened;
    await choose(popout, "refs/remotes/origin/topic", a.remote);
    await branch(popout).click();
    const search = view(popout).getByRole("combobox", { name: "Filter History branches", exact: true });
    await search.fill("refs/heads/topic");
    await expect(search).toBeInViewport();
    await popout.screenshot({ path: info.outputPath("branch-search-popout.png") });
    await search.press("Enter");
    await selected(popout, a.topic[34]);
    expect(fingerprint(a.root)).toEqual(before);
  } finally { await popout?.close(); a.cleanup(); }
});

test("History commit description keeps explicit expansion across commits loading and isolated views", async ({ page }, info) => {
  const a = fixture("description"), b = fixture("description-other"), wire = await transport(page);
  const name = `Sticky description ${Date.now()}`, otherName = `Other description ${Date.now()}`;
  try {
    const tree = git(a.root, "rev-parse", `${a.initial}^{tree}`);
    const commitA = git(a.root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", a.main, "-m", "Description A\n\nACTUAL_BODY_A");
    const empty = git(a.root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", commitA, "-m", "Subject without body");
    const commitB = git(a.root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", empty, "-m", "Description B\n\nACTUAL_BODY_B");
    git(a.root, "update-ref", "refs/heads/main", commitB);
    const beforeA = fingerprint(a.root), beforeB = fingerprint(b.root);
    await authenticate(page); await createSession(page, a.root, name); await history(page);
    const disclosure = () => view(page).locator(".diff-commit-message");
    const check = async (oid: string, title: string, message: string, open: boolean) => {
      await selected(page, oid);
      await expect(disclosure().locator("summary strong")).toHaveText(title);
      await expect(disclosure().locator("pre")).toHaveText(message);
      await expect(disclosure()).toHaveJSProperty("open", open);
      if (open) await expect(disclosure().locator("pre")).toBeVisible();
    };
    const select = async (oid: string) => view(page).locator(`[data-commit-oid="${oid}"]`).click();
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", false);
    await disclosure().locator("summary").click();
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    await select(commitA);
    await check(commitA, "Description A", "Description A\n\nACTUAL_BODY_A", true);
    await select(commitB);
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    await select(commitA);
    await check(commitA, "Description A", "Description A\n\nACTUAL_BODY_A", true);
    await select(empty);
    await check(empty, "Subject without body", "Subject without body", true);
    await select(commitB);
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    await disclosure().locator("summary").press("Space");
    await select(commitA);
    await check(commitA, "Description A", "Description A\n\nACTUAL_BODY_A", false);
    await select(empty);
    await check(empty, "Subject without body", "Subject without body", false);
    await select(commitB);
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", false);
    await disclosure().locator("summary").press("Enter");
    await select(commitA);
    await disclosure().locator("summary").focus();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(view(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await check(commitA, "Description A", "Description A\n\nACTUAL_BODY_A", true);
    await expect(view(page).locator(".diff-line-add")).toContainText("description_BASE");
    await expect(disclosure().locator("summary")).toBeFocused();
    await select(commitB);
    wire.hold = message => message.type === "sessionChanges.summary" && message.state.status === "ready"
      && message.state.review.currentCommitOid === commitA;
    await select(commitA);
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await select(commitB);
    wire.hold = () => false;
    await wire.release();
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    await page.screenshot({ path: info.outputPath("sticky-description-current-content.png") });
    await addRepo(page, b.root); await history(page); await selected(page, b.main);
    await expect(disclosure()).toHaveJSProperty("open", false);
    await repo(page, a.root);
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    await createSession(page, a.root, otherName); await history(page); await selected(page, commitB);
    await expect(disclosure()).toHaveJSProperty("open", false);
    await session(page, name);
    await check(commitB, "Description B", "Description B\n\nACTUAL_BODY_B", true);
    expect(fingerprint(a.root)).toEqual(beforeA);
    expect(fingerprint(b.root)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});
