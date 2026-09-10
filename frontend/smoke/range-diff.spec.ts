import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
};
function git(root: string, args: string[], environment: Record<string, string> = {}): string {
  return execFileSync("git", ["--no-pager", "-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", root, ...args], {
    env: { ...gitEnvironment, ...environment }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
}

// Every write, ref, upstream, and rebase belongs to this disposable repository.
// No remote transport is used: branch.main.remote=. makes @{u} a local ref.
function fixture(options: { upstream?: boolean; oversized?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-range-diff-smoke-")));
  const run = (...args: string[]) => git(root, args).trim();
  try {
    run("init", "-q", "-b", "main");
    run("config", "user.name", "Range Reviewer");
    run("config", "user.email", "range@example.invalid");
    const put = (name: string, text: string) => writeFileSync(path.join(root, name), text);
    const commit = (message: string) => {
      run("add", ".");
      run("commit", "-qm", message);
      return run("rev-parse", "HEAD");
    };
    put("same.ts", Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};\n`).join(""));
    put("README.txt", "Isolated range-diff fixture.\n");
    const base = commit("Base");
    put("stable.txt", "Stable patch λ 日本語 <b>literal</b>\n");
    const singleOld = commit("Stable λ 日本語 <b>literal</b>");
    put("reorder.txt", "Independent reordered patch\n");
    commit("Reordered patch");
    put("same.ts", readFileSync(path.join(root, "same.ts"), "utf8").replace("value15 = 15", "value15 = 150"));
    commit("Changed patch");
    put("removed.txt", Array.from({ length: 40 }, (_, i) => `LEGACY_ONLY_${i}=obsolete\n`).join(""));
    const old = commit("Removed patch");
    run("branch", "old", old);

    // Force an actual rebase of one patch; only the committer date changes.
    run("checkout", "-qb", "single-new", singleOld);
    git(root, ["rebase", "--force-rebase", base], { GIT_COMMITTER_DATE: "2025-01-02T00:00:00Z" });
    const singleNew = run("rev-parse", "HEAD");

    // Rebase onto a changed base, reorder independent commits, and drop one.
    run("checkout", "-qb", "new-base", base);
    put("upstream.txt", "Local upstream advancement\n");
    const newBase = commit("Upstream advancement");
    run("checkout", "-q", "main");
    const editor = path.join(root, ".git", "range-sequence-editor.cjs");
    writeFileSync(editor, "const fs=require('node:fs');const p=process.argv[2];const lines=fs.readFileSync(p,'utf8').split('\\n').filter(l=>l.startsWith('pick '));if(lines.length!==4)throw Error('Expected four fixture commits');fs.writeFileSync(p,[lines[1],lines[0],lines[2]].join('\\n')+'\\n');\n");
    git(root, ["rebase", "-i", "--onto", newBase, base], { GIT_SEQUENCE_EDITOR: `node '${editor.replaceAll("'", "'\\''")}'`, GIT_COMMITTER_DATE: "2025-01-03T00:00:00Z" });
    rmSync(editor);
    put("same.ts", readFileSync(path.join(root, "same.ts"), "utf8").replace("value15 = 150", "value15 = 151"));
    run("add", ".");
    run("commit", "--amend", "--no-edit", "-q");
    put("added.txt", Array.from({ length: 70 }, (_, i) => `replacement-entry-${i}: fresh independent data\n`).join(""));
    const newer = commit("Added patch");
    run("update-ref", "refs/remotes/origin/v35", base);
    if (options.upstream !== false) {
      run("config", "branch.main.remote", ".");
      run("config", "branch.main.merge", "refs/heads/old");
    }

    run("checkout", "-qb", "hostile", base);
    const hostileSubject = "Hostile λ 日本語 <img src=x onerror=globalThis.rangeDiffInjected=1>";
    const hostileBody = Array.from({ length: 40 }, (_, i) => `Unchanged safe context ${i}\n`).join("");
    put("hostile.txt", hostileBody + "<script>globalThis.rangeDiffInjected=1</script>\n");
    const hostile = commit(`${hostileSubject}\n\nLiteral escapes: \u001b]8;;javascript:alert(1)\u0007link\u001b]8;;\u0007 \u001b[2J unsafe end`);
    put("hostile.txt", hostileBody + "<script>globalThis.rangeDiffInjected=2</script>\n");
    run("add", ".");
    run("commit", "--amend", "-qm", `${hostileSubject}\n\nLiteral escapes: \u001b]8;;javascript:alert(1)\u0007link\u001b]8;;\u0007 \u001b[2J unsafe new end`);
    const hostileNew = run("rev-parse", "HEAD");
    let oversized = "";
    if (options.oversized) {
      run("checkout", "-qb", "oversized", base);
      put("large.txt", "One patch with a deliberately oversized subject\n");
      run("add", ".");
      const messageFile = path.join(root, ".git", "range-large-message");
      writeFileSync(messageFile, `Oversized ${"x".repeat(320_000)}\n`);
      run("commit", "-q", "-F", messageFile);
      rmSync(messageFile);
      oversized = run("rev-parse", "HEAD");
    }
    run("checkout", "-q", "main");
    put("README.txt", "DIRTY_WORKTREE_SENTINEL\n");
    put("staged.txt", "STAGED_INDEX_SENTINEL\n");
    run("add", "staged.txt");
    put("untracked.txt", "UNTRACKED_SENTINEL\n");
    return { root, base, old, newer, singleOld, singleNew, hostile, hostileNew, hostileSubject, oversized, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function repositoryBytes(root: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result.push([path.relative(root, file), createHash("sha256").update(entry.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex")]);
    }
  }
  visit(root);
  return result;
}

type Ref = { input: string; oid: string };
type Result = { repoRoot: string; base: Ref; old: Ref; new: Ref; output: string; truncated: boolean };
type Response = { type: "git.rangeDiff"; requestId: string; result: Result | null; error: string | null };
type Request = { type: string; requestId: string; repoRoot?: string; base?: string; old?: string; new?: string };
type Capture = { responses: Response[]; requests: Request[]; held: Array<() => void>; hold: boolean; disconnect: () => Promise<void> };
async function captureTransport(page: Page) {
  const capture: Capture = {
    responses: [], requests: [], held: [],
    hold: false,
    disconnect: async () => { throw new Error("No WebSocket connection established"); },
  };
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    capture.disconnect = async () => {
      await Promise.all([route.close({ code: 1001, reason: "range-diff smoke disconnect" }), server.close({ code: 1001 })]);
    };
    route.onMessage(data => {
      const message = JSON.parse(data.toString());
      if (message.type === "git.rangeDiff.request" || message.type === "git.rangeDiff.cancel") capture.requests.push(message);
      server.send(data);
    });
    server.onMessage(data => {
      const message = JSON.parse(data.toString());
      if (message.type === "git.rangeDiff") {
        capture.responses.push(message);
        if (capture.hold) { capture.held.push(() => route.send(data)); return; }
      }
      route.send(data);
    });
  });
  return capture;
}
function compare(page: Page) { return page.locator(".compare-view:visible"); }
function output(page: Page) { return compare(page).locator(".range-diff-output"); }
async function authenticate(page: Page) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function openRange(page: Page, root: string, refs = { base: "origin/v35", old: "@{u}", new: "HEAD" }) {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerDiffTab").click();
  await page.locator("#cwdPickerDiffMode").selectOption("rangeDiff");
  await page.locator("#cwdPickerDiffRepo").fill(root);
  await page.locator("#cwdPickerDiffBase").fill(refs.base);
  await page.locator("#cwdPickerDiffOld").fill(refs.old);
  await page.locator("#cwdPickerDiffHead").fill(refs.new);
  await expect(page.locator("#cwdPickerDiffAgentSession")).toBeHidden();
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(compare(page).getByRole("combobox", { name: "Compare mode", exact: true })).toHaveValue("rangeDiff");
}
async function setRefs(page: Page, refs: { base: string; old: string; new: string; root?: string }) {
  const view = compare(page);
  if (refs.root !== undefined) await view.getByRole("textbox", { name: "Repository", exact: true }).fill(refs.root);
  await view.getByRole("textbox", { name: "Base", exact: true }).fill(refs.base);
  await view.getByRole("textbox", { name: "Old", exact: true }).fill(refs.old);
  await view.getByRole("textbox", { name: "New", exact: true }).fill(refs.new);
}
async function submit(page: Page, capture: Capture) {
  const count = capture.requests.length;
  await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
  await expect.poll(() => capture.requests.slice(count).find(request => request.type === "git.rangeDiff.request")).toBeDefined();
  const request = capture.requests.slice(count).find(request => request.type === "git.rangeDiff.request")!;
  await expect.poll(() => capture.responses.find(response => response.requestId === request.requestId)).toBeDefined();
  return capture.responses.find(response => response.requestId === request.requestId)!;
}
function native(result: Result) {
  return git(result.repoRoot, [
    "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs",
    "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "pager.log=false", "-c", "pager.range-diff=false",
    "-c", "log.showSignature=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
    "-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "diff.external=", "-c", "diff.submodule=short",
    "range-diff", "--no-ext-diff", "--no-textconv", "--color=always", "--dual-color",
    result.base.oid, result.old.oid, result.new.oid, "--",
  ], { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "" });
}
function plain(text: string) { return stripVTControlCharacters(text); }
async function expectNative(page: Page, response: Response) {
  expect(response.error).toBeNull();
  expect(response.result).not.toBeNull();
  const result = response.result!;
  expect(result.truncated).toBe(false);
  expect(result.output).toBe(native(result));
  await expect.poll(async () => (await output(page).textContent())?.replaceAll(" (no change)", "")).toBe(plain(result.output));
  const identity = compare(page).locator(".range-diff-identity");
  await expect(identity).toContainText(result.repoRoot);
  for (const ref of [result.base, result.old, result.new]) {
    await expect(identity).toContainText(ref.input);
    await expect(identity).toContainText(ref.oid);
  }
  return result;
}

test.beforeEach(({ page }) => page.on("pageerror", error => { throw error; }));

test("native mixed range-diff preserves pinned identity, patch order, dual colors and read-only state", async ({ page }, info) => {
  const repo = fixture(), before = repositoryBytes(repo.root), capture = await captureTransport(page);
  try {
    await authenticate(page);
    await openRange(page, repo.root);
    await expect.poll(() => capture.responses.length).toBe(1);
    const result = await expectNative(page, capture.responses[0]);
    expect(result.base).toEqual({ input: "origin/v35", oid: repo.base });
    expect(result.old).toEqual({ input: "@{u}", oid: repo.old });
    expect(result.new).toEqual({ input: "HEAD", oid: repo.newer });
    const summaries = plain(result.output).split("\n").filter(line => /^\s*(?:\d+|-)\s*:/.test(line));
    for (const status of ["=", "!", "<", ">"] ) expect(summaries.some(line => line.includes(` ${status} `))).toBe(true);
    const reordered = summaries.findIndex(line => line.includes("Reordered patch"));
    const stable = summaries.findIndex(line => line.includes("Stable λ"));
    expect(reordered).toBeGreaterThanOrEqual(0);
    expect(stable).toBeGreaterThan(reordered);
    await expect(output(page)).toContainText("(no change)");
    await expect(compare(page).locator(".range-diff-view a, .range-diff-view button, .range-diff-view input, .diff-comment-btn, .diff-question-btn, .diffs-file-jump")).toHaveCount(0);
    await expect(compare(page).getByRole("button", { name: /^(Code|View committed file|Comment|Older commit|Newer commit)$/ })).toHaveCount(0);
    // The outer removal marker and inner old addition need different meaning:
    // red outer background, green inner foreground; neither may overwrite the other.
    const colors = await output(page).locator("span").evaluateAll(spans => spans.map(span => ({
      text: span.textContent ?? "", color: getComputedStyle(span).color, background: getComputedStyle(span).backgroundColor,
    })));
    const oldAddition = colors.find(span => span.text.includes("+export const value15 = 150;"));
    expect(oldAddition).toBeDefined();
    const removedMarker = colors.find(span => span.text === "-" && span.background !== "rgba(0, 0, 0, 0)");
    expect(removedMarker).toBeDefined();
    const [redR, redG, redB] = removedMarker!.background.match(/\d+/g)!.map(Number);
    const [greenR, greenG, greenB] = oldAddition!.color.match(/\d+/g)!.map(Number);
    expect(redR).toBeGreaterThan(Math.max(redG, redB));
    expect(greenG).toBeGreaterThan(Math.max(greenR, greenB));
    await page.screenshot({ path: info.outputPath("range-diff-mixed-statuses-dual-colors.png"), fullPage: true });
    await output(page).locator(".range-diff-bold.range-diff-fg-32").filter({ hasText: "value15 = 151" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("range-diff-dual-color-lines.png"), fullPage: true });

    await setRefs(page, { base: repo.base, old: repo.singleOld, new: repo.singleNew });
    const unchanged = await expectNative(page, await submit(page, capture));
    expect(repo.singleOld).not.toBe(repo.singleNew);
    expect(plain(unchanged.output).trim().split("\n")).toHaveLength(1);
    expect(plain(unchanged.output)).toMatch(/ = /);
    expect(plain(unchanged.output)).not.toContain("@@");
    await expect(output(page)).toContainText("(no change)");
    await page.screenshot({ path: info.outputPath("range-diff-no-change.png"), fullPage: true });
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});

test("missing refs, absent upstream, empty ranges and hostile commit text remain explicit and safe", async ({ page }) => {
  const repo = fixture({ upstream: false }), before = repositoryBytes(repo.root), capture = await captureTransport(page);
  try {
    await authenticate(page);
    await openRange(page, repo.root);
    await expect.poll(() => capture.responses.length).toBe(1);
    expect(capture.responses[0].result).toBeNull();
    expect(capture.responses[0].error).toBeTruthy();
    await expect(compare(page).getByRole("alert")).toBeVisible();
    await expect(output(page)).toHaveCount(0);

    await setRefs(page, { base: "missing-range-base", old: repo.old, new: repo.newer });
    const missing = await submit(page, capture);
    expect(missing.result).toBeNull();
    expect(missing.error).toBeTruthy();
    await expect(compare(page).getByRole("alert")).toBeVisible();
    await expect(output(page)).toHaveCount(0);

    await setRefs(page, { base: repo.base, old: repo.base, new: repo.base });
    const empty = await expectNative(page, await submit(page, capture));
    expect(empty.output).toBe("");
    await expect(compare(page).locator(".range-diff-empty")).toBeVisible();

    await setRefs(page, { base: repo.base, old: repo.hostile, new: repo.hostileNew });
    const hostile = await submit(page, capture);
    expect(hostile.error).toBeNull();
    expect(hostile.result!.output).toBe(native(hostile.result!));
    expect(hostile.result!.output).toContain("\u001b]8;;javascript:alert(1)");
    expect(hostile.result!.output).toContain("\u001b[2J");
    await expect(output(page)).toContainText(repo.hostileSubject);
    await expect(output(page)).toContainText("<script>globalThis.rangeDiffInjected=");
    await expect(compare(page).locator(".range-diff-view img, .range-diff-view script, .range-diff-view a, .range-diff-view iframe")).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { rangeDiffInjected?: number }).rangeDiffInjected)).toBeUndefined();
    expect(await output(page).textContent()).not.toContain("\u001b");
    await expect(compare(page).getByRole("button", { name: "Compare", exact: true })).toBeEnabled();
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});

test("edited refs and replacement repositories reject delayed real range-diff responses", async ({ page }) => {
  const a = fixture(), b = fixture(), beforeA = repositoryBytes(a.root), beforeB = repositoryBytes(b.root), capture = await captureTransport(page);
  try {
    capture.hold = true;
    await authenticate(page);
    await openRange(page, a.root);
    await expect.poll(() => capture.held.length).toBe(1);
    const firstRequest = capture.requests.find(request => request.type === "git.rangeDiff.request")!;
    await compare(page).getByRole("textbox", { name: "New", exact: true }).fill(a.singleNew);
    await expect.poll(() => capture.requests.some(request => request.type === "git.rangeDiff.cancel" && request.requestId === firstRequest.requestId)).toBe(true);
    capture.held.splice(0).forEach(release => release());
    await expect(output(page)).toHaveCount(0);
    await expect(compare(page).locator(".range-diff-identity")).toHaveCount(0);

    await setRefs(page, { base: a.base, old: a.singleOld, new: a.singleNew });
    await submit(page, capture);
    await expect.poll(() => capture.held.length).toBe(1);
    await setRefs(page, { root: b.root, base: b.base, old: b.base, new: b.base });
    capture.hold = false;
    const replacement = await submit(page, capture);
    await expectNative(page, replacement);
    capture.held.splice(0).forEach(release => release());
    await expect(compare(page).locator(".range-diff-identity")).toContainText(b.root);
    await expect(output(page)).toHaveText("");
    await expect(compare(page).locator(".range-diff-identity")).not.toContainText(a.root);
    expect(repositoryBytes(a.root)).toEqual(beforeA);
    expect(repositoryBytes(b.root)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});

test("actual socket disconnect clears pending range-diff and allows a fresh comparison", async ({ page }) => {
  const repo = fixture(), before = repositoryBytes(repo.root), capture = await captureTransport(page);
  try {
    capture.hold = true;
    await authenticate(page);
    await openRange(page, repo.root);
    await expect.poll(() => capture.held.length).toBe(1);
    await capture.disconnect();
    await expect(compare(page).getByRole("alert")).toContainText(/connect/i);
    await expect(output(page)).toHaveCount(0);
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    capture.hold = false;
    await expectNative(page, await submit(page, capture));
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});

test("oversized native output is visibly bounded without blocking the Compare form", async ({ page }) => {
  const repo = fixture({ oversized: true }), before = repositoryBytes(repo.root), capture = await captureTransport(page);
  try {
    await authenticate(page);
    await openRange(page, repo.root, { base: repo.base, old: repo.oversized, new: repo.oversized });
    await expect.poll(() => capture.responses.length).toBe(1);
    const response = capture.responses[0];
    expect(response.error).toBeNull();
    const result = response.result!;
    expect(Buffer.byteLength(native(result))).toBeGreaterThan(256_000);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(256_000);
    await expect(compare(page).locator(".range-diff-view")).toContainText(/truncat|limit/i);
    expect((await output(page).textContent())!.length).toBeLessThanOrEqual(16_384);
    expect(await output(page).locator("*").count()).toBeLessThanOrEqual(2_048);
    await compare(page).getByRole("textbox", { name: "Base", exact: true }).fill(repo.base, { timeout: 2_000 });
    await setRefs(page, { base: repo.base, old: repo.singleOld, new: repo.singleNew });
    await expectNative(page, await submit(page, capture));
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});

test("Advanced Compare opens range-diff while ordinary Compare, History and Code remain usable", async ({ page }, info) => {
  const repo = fixture(), capture = await captureTransport(page);
  try {
    await authenticate(page);
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerNameInput").fill(`Range navigation ${Date.now()}`);
    await page.locator("#cwdPickerInput").fill(repo.root);
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    // Session creation may create its own metadata; snapshot the actual read boundary.
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    const before = repositoryBytes(repo.root);
    const history = page.locator(".session-changes-view:visible");
    await history.getByRole("button", { name: "History", exact: true }).click();
    await expect(history.locator(".git-history-commit").first()).toBeVisible();
    await history.locator(".git-review-options > summary").click();
    await history.getByRole("button", { name: "Advanced Compare", exact: true }).click();
    await page.locator("#cwdPickerDiffMode").selectOption("rangeDiff");
    await page.locator("#cwdPickerDiffBase").fill("origin/v35");
    await page.locator("#cwdPickerDiffOld").fill("@{u}");
    await page.locator("#cwdPickerDiffHead").fill("HEAD");
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    await expect.poll(() => capture.responses.length).toBe(1);
    await expectNative(page, capture.responses[0]);
    await compare(page).getByRole("combobox", { name: "Compare mode", exact: true }).selectOption("files");
    await compare(page).getByRole("textbox", { name: "Base", exact: true }).fill(repo.base);
    await compare(page).getByRole("textbox", { name: "Head", exact: true }).fill(repo.newer);
    await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
    const same = compare(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]');
    await expect(same).toBeVisible();
    await same.click({ button: "right" });
    await page.locator(".diffs-file-menu:visible").getByRole("button", { name: "View this revision in Code", exact: true }).click();
    await expect(page.locator(".code-revision-view:visible .code-review-lines")).toContainText("value15 = 151");
    await page.screenshot({ path: info.outputPath("range-diff-ordinary-compare-code.png") });
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});

test("range-diff opened from an active agent review reaches the normal Compare workspace", async ({ page }) => {
  const repo = fixture(), capture = await captureTransport(page);
  try {
    await authenticate(page);
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffMode").selectOption("full");
    await page.locator("#cwdPickerDiffRepo").fill(repo.root);
    await page.locator("#cwdPickerDiffBase").fill(repo.base);
    await page.locator("#cwdPickerDiffHead").fill(repo.newer);
    await page.locator("#cwdPickerDiffAgentSession").check();
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    await expect(page.locator("#diffReviewWorkspacePanelHost")).toBeVisible();
    const before = repositoryBytes(repo.root);
    await openRange(page, repo.root);
    await expect(page.locator("#normalWorkspacePanelHost")).toBeVisible();
    await expect.poll(() => capture.responses.length).toBe(1);
    await expectNative(page, capture.responses[0]);
    expect(repositoryBytes(repo.root)).toEqual(before);
  } finally { repo.cleanup(); }
});
