import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ServerMessage, SessionSummary, SessionProjection, SessionStatus } from "../src/protocol";

const binary = process.env.FURA_RECENCY_BINARY;
const staticDir = process.env.FURA_RECENCY_STATIC_DIR;
const evidence = process.env.FURA_RECENCY_EVIDENCE_DIR;
const phase = process.env.FURA_RECENCY_PHASE ?? "after";
const day = 86_400_000;
const created = Date.UTC(2026, 0, 1);
const repo = fileURLToPath(new URL("../..", import.meta.url));

type Fixture = { name: string; mtimeMs: number; records: Array<Record<string, unknown>> };
type RunnerEvent = { event: string; baseURL?: string; root?: string; generation?: number; ownedProcessesCleaned?: boolean };
type TileFixtureState = {
  sockets: WebSocket[];
  summaries: Map<string, SessionSummary>;
  projections: Map<string, SessionProjection>;
};
declare global {
  interface Window { recencyTileFixture?: TileFixtureState }
}

function session(name: string, title: string, messageAt: number, mtimeMs: number): Fixture {
  return { name, mtimeMs, records: [
    { type: "session", version: 3, id: name, title, timestamp: new Date(created).toISOString() },
    { type: "message", id: `${name}-user`, parentId: null, timestamp: new Date(messageAt).toISOString(), message: { role: "user", content: "Synthetic conversation fixture", timestamp: messageAt } },
  ] };
}

async function startFixture(testInfo: TestInfo, sessions: Fixture[]) {
  const outputParent = evidence ?? await mkdtemp(path.join(tmpdir(), "fura-recency-evidence-"));
  const fixtures = path.join(outputParent, `${phase}-${testInfo.workerIndex}-${Date.now()}-fixtures.json`);
  await writeFile(fixtures, JSON.stringify(sessions));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("PI_") && !key.startsWith("FURA_")));
  environment.PYTHONDONTWRITEBYTECODE = "1";
  const child = spawn(process.env.PYTHON ?? "python3", [path.join(repo, "scripts/session_recency_smoke.py"),
    "--binary", binary!, "--static-dir", staticDir!, "--fixtures", fixtures, "--output-parent", outputParent,
    "--rpc-script", path.join(repo, "fixtures/recency-omp-rpc.mjs")], { cwd: outputParent, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors += String(chunk); });
  child.stdin.on("error", () => {});
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<RunnerEvent> => {
    const line = await lines.next();
    if (line.done) throw new Error(`fixture supervisor ended: ${errors}`);
    const value: unknown = JSON.parse(line.value);
    if (!value || typeof value !== "object" || !("event" in value) || typeof value.event !== "string") {
      throw new Error("invalid fixture supervisor event");
    }
    return {
      event: value.event,
      baseURL: "baseURL" in value && typeof value.baseURL === "string" ? value.baseURL : undefined,
      root: "root" in value && typeof value.root === "string" ? value.root : undefined,
      generation: "generation" in value && typeof value.generation === "number" ? value.generation : undefined,
      ownedProcessesCleaned: "ownedProcessesCleaned" in value && typeof value.ownedProcessesCleaned === "boolean" ? value.ownedProcessesCleaned : undefined,
    };
  };
  const command = async (value: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify(value) + "\n");
    const response = await next();
    if (response.event !== "complete") throw new Error(`unexpected fixture event ${response.event}: ${errors}`);
    return response;
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write('{"op":"stop"}\n');
    const stopped = await next();
    expect(stopped.ownedProcessesCleaned).toBe(true);
    await exited;
  };
  try {
    const ready = await next();
    if (ready.event !== "ready" || !ready.baseURL) throw new Error(`fixture startup failed: ${errors}`);
    const address = new URL(ready.baseURL);
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1") throw new Error("fixture listener must be loopback");
    return { baseURL: ready.baseURL, root: ready.root!, command, close };
  } catch (error) {
    child.kill("SIGTERM");
    await exited;
    throw error;
  }
}

async function login(page: Page, baseURL: string) {
  await page.goto(baseURL);
  await page.locator("#authTokenInput").fill("recency-fixture-only");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#authGate")).toBeHidden();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}

const order = (page: Page) => page.locator("#sessionsList button.session .session-id").allTextContents();
async function saveEvidence(testInfo: TestInfo, name: string, value: unknown) {
  const file = evidence ? path.join(evidence, `${phase}-${name}.json`) : testInfo.outputPath(name + ".json");
  await writeFile(file, JSON.stringify(value, null, 2));
}

test.describe("isolated conversation recency and desktop tiles", () => {
  test.skip(!binary || !staticDir, "requires separately built isolated FURA_RECENCY_BINARY and FURA_RECENCY_STATIC_DIR");

  test("message order survives actual bridge restart despite contrary file mtimes", async ({ page }, testInfo) => {
    const fixture = await startFixture(testInfo, [session("newer", "Newer conversation", created + 3 * day, created + 8 * day), session("older", "Older conversation", created + 2 * day, created + 9 * day)]);
    try {
      await login(page, fixture.baseURL);
      await expect(page.locator("#sessionsList button.session")).toHaveCount(2);
      const before = await order(page);
      await fixture.command({ op: "restart" });
      await expect(page.locator("#connectionStatus")).toHaveText("connected", { timeout: 20_000 });
      await expect(page.locator("#sessionsList button.session")).toHaveCount(2);
      await page.reload();
      await expect(page.locator("#sessionsList button.session")).toHaveCount(2);
      const after = await order(page);
      const expected = ["Newer conversation", "Older conversation"];
      await saveEvidence(testInfo, "restart-order", { expected, before, after, actualBridgeGenerations: 2, provider: "not invoked; real temporary journals" });
      expect(before).toEqual(expected);
      expect(after).toEqual(expected);
    } finally { await fixture.close(); }
  });

  test("metadata changes still refresh goals without becoming conversation activity", async ({ page }, testInfo) => {
    const fixture = await startFixture(testInfo, [session("newer", "Newer conversation", created + 3 * day, created + 8 * day), session("older", "Older conversation", created + 2 * day, created + 9 * day)]);
    try {
      await login(page, fixture.baseURL);
      await expect.poll(() => order(page)).toEqual(["Newer conversation", "Older conversation"]);
      await fixture.command({ op: "append", name: "older", mtimeMs: Date.now(), entry: { type: "mode_change", id: "goal-change", parentId: "older-user", timestamp: new Date().toISOString(), mode: "goal", data: { goal: { id: "fixture-goal", objective: "Metadata goal refresh", status: "active", tokenBudget: 1000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: created, updatedAt: Date.now() } } } });
      const older = page.locator(".session-item").filter({ has: page.locator(".session-id", { hasText: "Older conversation" }) });
      await expect(older.locator(".session-goal-badge")).toBeVisible();
      await expect.poll(() => order(page)).toEqual(["Newer conversation", "Older conversation"]);
      await fixture.command({ op: "touch", name: "newer", mtimeMs: created });
      await fixture.command({ op: "restart" });
      await page.reload();
      await expect.poll(() => order(page)).toEqual(["Newer conversation", "Older conversation"]);
      await saveEvidence(testInfo, "metadata-order", { order: await order(page), goalRefreshObserved: true, touchAndRestartPreservedOrder: true });
    } finally { await fixture.close(); }
  });

  test("a real browser send and assistant receipt reorder both open and saved sessions durably", async ({ page }, testInfo) => {
    const fixture = await startFixture(testInfo, [session("newer", "Newer conversation", created + 3 * day, created + 8 * day), session("older", "Older conversation", created + 2 * day, created + 9 * day)]);
    try {
      await login(page, fixture.baseURL);
      await expect.poll(() => order(page)).toEqual(["Newer conversation", "Older conversation"]);
      await page.locator("#sessionsList button.session").filter({ has: page.locator(".session-id", { hasText: "Older conversation" }) }).click();
      await expect(page.locator("#sessionsList button.session.active .session-status")).toHaveText("Ready");
      await expect(page.locator("#promptInput")).toBeEnabled();
      await expect.poll(() => order(page)).toEqual(["Newer conversation", "Older conversation"]);
      await page.locator("#promptInput").fill("Synthetic recency send");
      await page.locator("#sendButton").click();
      await expect.poll(() => order(page)).toEqual(["Older conversation", "Newer conversation"]);
      await expect(page.locator(".message.assistant").filter({ hasText: "Mock assistant received" })).toBeVisible();
      await fixture.command({ op: "restart" });
      await page.reload();
      await expect.poll(() => order(page)).toEqual(["Older conversation", "Newer conversation"]);
      await saveEvidence(testInfo, "live-order", { order: await order(page), attachDidNotReorder: true, userAndAssistantReceived: true, provider: "synthetic RPC producer with fixture-only journal persistence" });
    } finally { await fixture.close(); }
  });

  test("desktop tile widths, statuses, Unicode, active and unread remain readable", async ({ page }, testInfo) => {
    const titles = ["Żółw — 日本語 — bardzo długi tytuł sesji bez miejsca na dodatkowy badge", "Pracująca sesja — zachowane nieprzeczytane wiadomości", "Otwieranie sesji", "Błąd wymagający uwagi", "Zakończona rozmowa", "Pytanie oczekuje odpowiedzi", "Zapisana sesja"];
    const names = ["ready", "working", "opening", "failed", "ended", "answer", "saved"];
    const sessions = names.map((name, index) => session(name, titles[index], created + (names.length - index) * day, created + (names.length - index) * day));
    const fixture = await startFixture(testInfo, sessions);
    try {
      await page.addInitScript(() => {
        const Original = window.WebSocket;
        const data: TileFixtureState = { sockets: [], summaries: new Map(), projections: new Map() };
        Object.assign(window, { recencyTileFixture: data });
        const states: Record<string, SessionStatus> = { ready: "idle", working: "busy", opening: "starting", failed: "error", ended: "exited", answer: "busy", saved: "available" };
        const project = (summary: SessionSummary) => {
          const id = summary.sessionId;
          if (!(id in states)) return summary;
          const next: SessionSummary = { ...summary, kind: id === "saved" ? "available" : "managed", status: states[id], awaitingAsk: id === "answer" };
          data.summaries.set(id, next);
          return next;
        };
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); data.sockets.push(this); }
          override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
            if (type !== "message" || typeof listener !== "function") return super.addEventListener(type, listener, options);
            return super.addEventListener(type, event => {
              if (!("data" in event) || typeof event.data !== "string") throw new Error("non-text fixture frame");
              // Frames come from the owned Fura fixture, whose wire contract this test exercises.
              const message = JSON.parse(event.data) as ServerMessage;
              if (message.type === "sessions.snapshot") {
                message.sessions = message.sessions.map(project);
              }
              if (message.type === "session.snapshot") {
                message.state.summary = project(message.state.summary);
                data.projections.set(message.sessionId, message.state);
              }
              listener.call(this, new MessageEvent("message", { data: JSON.stringify(message) }));
            }, options);
          }
        };
      });
      await login(page, fixture.baseURL);
      await expect(page.locator("#sessionsList button.session")).toHaveCount(names.length);
      await page.locator("#sessionsList button.session").first().click();
      await expect(page.locator("#sessionsList button.session.active")).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => window.recencyTileFixture?.projections.size ?? 0)).toBeGreaterThan(0);
      await page.evaluate(() => {
        const data = window.recencyTileFixture;
        if (!data) throw new Error("fixture observer missing");
        const source = structuredClone([...data.projections.values()][0]);
        if (!source || !Array.isArray(source.transcript)) throw new Error("fixture transcript missing");
        const summary = data.summaries.get("working");
        if (!summary) throw new Error("fixture summary missing");
        source.summary = summary;
        const first = source.transcript[0];
        if (!first || first.kind !== "message") throw new Error("fixture message missing");
        source.transcript.push({ ...first, id: "synthetic-unread", isNew: true });
        data.sockets[0].dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.snapshot", sessionId: "working", state: source }) }));
      });
      await expect(page.locator("#sessionsList button.session.has-updates")).toHaveCount(1);
      const measurements = [];
      for (const width of [208, 160]) {
        await page.locator(".shell").evaluate((element, pixels) => { element.style.gridTemplateColumns = `${pixels}px minmax(420px, 1fr)`; }, width);
        const sidebar = page.locator(".sidebar");
        const file = evidence ? path.join(evidence, `${phase}-tiles-${width}.png`) : testInfo.outputPath(`tiles-${width}.png`);
        await sidebar.screenshot({ path: file });
        measurements.push(await page.locator("#sessionsList button.session").evaluateAll(buttons => buttons.map(button => {
          const title = button.querySelector(".session-id")!;
          const status = button.querySelector(".session-status")!;
          const action = button.parentElement!.querySelector(".session-delete")!;
          const titleBox = title.getBoundingClientRect(), actionBox = action.getBoundingClientRect();
          return { titleWidth: titleBox.width, titleRight: titleBox.right, actionLeft: actionBox.left, statusFontSize: getComputedStyle(status).fontSize, accessibleName: button.getAttribute("aria-label"), fullTitle: button.getAttribute("title") ?? "" };
        })));
      }
      if (phase !== "before") {
        for (const layout of measurements) for (const row of layout) {
          expect(row.titleWidth).toBeGreaterThan(35);
          expect(row.titleRight).toBeLessThanOrEqual(row.actionLeft);
          expect(row.statusFontSize).toBe("0px");
          expect(row.accessibleName).toContain(row.fullTitle);
        }
        const button = page.locator("#sessionsList button.session").first();
        await button.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(button).toBeFocused();
        const label = await button.locator(".session-status").evaluate(element => getComputedStyle(element, "::after").content);
        expect(label).not.toBe("none");
        await page.locator(".sidebar").screenshot({ path: evidence ? path.join(evidence, "after-tiles-keyboard-status.png") : testInfo.outputPath("keyboard-status.png") });
      }
      await saveEvidence(testInfo, "tile-layout", { widths: [208, 160], measurements, statusData: "synthetic browser-frame variations; actual app renderer/CSS and real fixture backend", activeAndUnreadObserved: true });
    } finally { await fixture.close(); }
  });
});
