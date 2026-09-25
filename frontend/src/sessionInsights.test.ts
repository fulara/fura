import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionInsights, type SessionInsights } from "./sessionInsights";
import type { ActivityItem, ClientMessage, SessionActivitySnapshot, SessionRecapSnapshot } from "./protocol";

type ReadRequest = Extract<ClientMessage, { type: "session.activity.get" | "session.activity.detail" | "session.recap.get" }>;
const controllers: SessionInsights[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function item(id: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  return { id, kind: "job", label: id, status: "running", startedAt: Date.now() - 1_000, detailAvailable: true, ...overrides };
}
function snapshot(sessionId: string, items: ActivityItem[], generation = "g1"): SessionActivitySnapshot {
  return { sessionId, generation, observedAt: Date.now(), items, sources: { jobs: { available: true }, agents: { available: true }, services: { available: true } } };
}
function harness(initial: { sessionId: string | null; ready: boolean; visible: boolean } = { sessionId: "one", ready: true, visible: true }) {
  const context = { ...initial };
  const summary = document.createElement("button");
  summary.textContent = "Summary";
  const host = document.createElement("div");
  document.body.append(summary, host);
  const sent: ReadRequest[] = [];
  const showTool = vi.fn();
  let nextId = 0;
  let accepted = true;
  const controller = createSessionInsights(summary, {
    context: () => context,
    send: message => { sent.push(message as ReadRequest); return accepted; },
    requestId: () => `insight-${++nextId}`,
    showTool,
  });
  controllers.push(controller);
  controller.mountActivity(host);
  function latest<T extends ReadRequest["type"]>(type: T): Extract<ReadRequest, { type: T }> {
    const request = sent.filter(request => request.type === type).at(-1);
    if (!request) throw new Error(`No ${type} request`);
    return request as Extract<ReadRequest, { type: T }>;
  }
  function activity(items: ActivityItem[], generation = "g1", request = latest("session.activity.get")): void {
    controller.receive({ type: "session.activity.result", requestId: request.requestId, sessionId: request.sessionId, activity: snapshot(request.sessionId, items, generation) });
  }
  function recap(state: Partial<SessionRecapSnapshot> = {}, request = latest("session.recap.get")): void {
    controller.receive({ type: "session.recap.result", requestId: request.requestId, sessionId: request.sessionId,
      state: { sessionId: request.sessionId, enabled: true, idleSeconds: 240, generating: false, recap: { id: 1, text: "Saved recap", createdAt: 900_000, sourceLeafId: "leaf", stale: false }, ...state } });
  }
  function detail(value: string, request = latest("session.activity.detail")): void {
    controller.receive({ type: "session.activity.detail.result", requestId: request.requestId, sessionId: request.sessionId,
      detail: { sessionId: request.sessionId, generation: request.generation, kind: request.kind, activityId: request.activityId, text: value, truncated: false, observedAt: Date.now() } });
  }
  function openActivity(id: string): HTMLDetailsElement {
    const root = host.querySelector<HTMLDetailsElement>(".session-activity")!;
    root.open = true;
    root.dispatchEvent(new Event("toggle"));
    const row = [...host.querySelectorAll<HTMLDetailsElement>(".session-activity-item")].find(row => row.dataset.activityId === id)!;
    row.open = true;
    row.dispatchEvent(new Event("toggle"));
    return row;
  }
  return { context, summary, host, sent, showTool, controller, latest, activity, recap, detail, openActivity, rejectSends: () => { accepted = false; } };
}

function query<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

describe("session insights", () => {
  it("reads sequentially only for a ready visible selected session, including collapsed activity", () => {
    const h = harness({ sessionId: "one", ready: false, visible: true });
    vi.advanceTimersByTime(20_000);
    expect(h.sent).toEqual([]);
    h.context.ready = true;
    h.controller.sync();
    expect(h.sent.map(request => request.type)).toEqual(["session.activity.get"]);
    for (let i = 0; i < 5; i++) h.controller.sync();
    vi.advanceTimersByTime(2_001);
    expect(h.sent).toHaveLength(1);
    h.activity([]);
    expect(query<HTMLDetailsElement>(h.host, ".session-activity").open).toBe(false);
    vi.advanceTimersByTime(1_999);
    expect(h.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sent.map(request => request.type)).toEqual(["session.activity.get", "session.activity.get"]);
    h.context.visible = false;
    h.controller.sync();
    vi.advanceTimersByTime(30_000);
    expect(h.sent).toHaveLength(2);
    expect(h.host.hidden).toBe(true);
    expect(h.summary.hidden).toBe(true);
    h.controller.dispose();
    h.context.visible = true;
    h.controller.sync();
    vi.advanceTimersByTime(30_000);
    expect(h.sent).toHaveLength(2);
  });

  it("preserves stale cache and rejects pre-disconnect and prior-session replies", () => {
    const h = harness();
    h.activity([item("old")]);
    vi.advanceTimersByTime(2_000);
    const oldRequest = h.latest("session.activity.get");
    h.context.ready = false;
    h.controller.disconnect();
    expect(query(h.host, ".session-activity").dataset.state).toBe("stale");
    expect(query(h.host, '[data-activity-id="old"]').isConnected).toBe(true);
    h.activity([item("late")], "g1", oldRequest);
    expect(h.host.querySelector('[data-activity-id="late"]')).toBeNull();
    h.context.ready = true;
    h.controller.sync();
    const reconnectRequest = h.latest("session.activity.get");
    expect(reconnectRequest.requestId).not.toBe(oldRequest.requestId);
    h.activity([item("reconnected")]);
    h.activity([item("late")], "g1", oldRequest);
    expect(query(h.host, ".session-activity").dataset.state).toBe("current");
    expect(h.host.querySelector('[data-activity-id="late"]')).toBeNull();
    h.summary.click();
    const oldRecap = h.latest("session.recap.get");
    h.context.sessionId = "two";
    h.controller.sync();
    expect(h.summary.getAttribute("aria-expanded")).toBe("false");
    expect(query(document, ".session-summary").hidden).toBe(true);
    expect(h.host.querySelector('[data-activity-id="reconnected"]')).toBeNull();
    h.recap({}, oldRecap);
    h.activity([item("foreign")], "g1", reconnectRequest);
    h.summary.click();
    expect(query(document, ".session-summary-text").textContent).toBe("");
    expect(h.latest("session.recap.get").sessionId).toBe("two");
    expect(h.host.querySelector('[data-activity-id="foreign"]')).toBeNull();
  });

  it("counts ready services without relying on foreground Busy and bounds terminal history", () => {
    const h = harness();
    const recent = Array.from({ length: 25 }, (_, i) => item(`done-${i}`, { status: "completed", endedAt: Date.now() - i * 1_000 }));
    h.activity([item("server", { kind: "service", status: "ready" }), ...recent, item("expired", { status: "failed", endedAt: Date.now() - 300_001 })]);
    expect(query(h.host, ".session-activity-heading").textContent).toContain("1 service");
    expect([...h.host.querySelectorAll(".session-activity-active .session-activity-item")].map(row => (row as HTMLElement).dataset.activityId)).toEqual(["server"]);
    expect([...h.host.querySelectorAll(".session-activity-recent .session-activity-item")].map(row => (row as HTMLElement).dataset.activityId)).toEqual(recent.slice(0, 20).map(item => item.id));
    expect(h.host.querySelector('[data-activity-id="expired"]')).toBeNull();
  });

  it("keeps focus, disclosure and selected inert output across polls and terminal transitions", () => {
    const h = harness();
    const running = item("build", { toolCallId: "tool-proven" });
    h.activity([running, item("unlinked", { detailAvailable: false })]);
    const row = h.openActivity("build");
    const output = '<img src=x onerror="alert(1)">\nlog line';
    h.detail(output);
    const pre = query(row, ".session-activity-output");
    const tool = query<HTMLButtonElement>(row, ".session-activity-tool");
    tool.focus();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(pre.firstChild!, 1, pre.firstChild!, 9);
    const selected = selection.toString();
    vi.advanceTimersByTime(2_000);
    h.activity([running, item("unlinked", { detailAvailable: false })]);
    h.detail(`${output}\nnew line`);
    expect(query(h.host, '[data-activity-id="build"]')).toBe(row);
    expect(row.open).toBe(true);
    expect(document.activeElement).toBe(tool);
    expect(selection.toString()).toBe(selected);
    expect(pre.querySelector("img")).toBeNull();
    expect(pre.textContent).toBe(`${output}\nnew line`);
    tool.click();
    expect(h.showTool.mock.calls).toEqual([["tool-proven"]]);
    expect(query<HTMLButtonElement>(h.host, '[data-activity-id="unlinked"] .session-activity-tool').hidden).toBe(true);
    vi.advanceTimersByTime(2_000);
    h.activity([{ ...running, status: "completed", endedAt: Date.now() }]);
    h.detail("complete");
    expect(query(h.host, ".session-activity-recent .session-activity-item")).toBe(row);
    expect(row.open).toBe(true);
    expect(document.activeElement).toBe(tool);
  });

  it("rejects detail responses from an earlier registry generation, even when IDs are reused", () => {
    const h = harness();
    h.activity([item("same")]);
    h.openActivity("same");
    const oldDetail = h.latest("session.activity.detail");
    vi.advanceTimersByTime(2_000);
    h.activity([item("same")], "g2");
    const row = h.openActivity("same");
    h.detail("old secret output", oldDetail);
    expect(query(row, ".session-activity-output").textContent).toBe("");
    expect(h.latest("session.activity.detail").generation).toBe("g2");
    h.detail("new output");
    expect(query(row, ".session-activity-output").textContent).toBe("new output");
  });

  it("bounds output by UTF-8 bytes and lines without splitting a Unicode character", () => {
    const h = harness();
    h.activity([item("output")]);
    const row = h.openActivity("output");
    const pre = query(row, ".session-activity-output");
    h.detail("\u4e00".repeat(30_000));
    expect(new TextEncoder().encode(pre.textContent!).length).toBe(65_535);
    expect(pre.textContent).toBe("\u4e00".repeat(21_845));
    vi.advanceTimersByTime(2_000);
    h.activity([item("output")]);
    h.detail(Array.from({ length: 220 }, (_, index) => `line ${index}`).join("\n"));
    expect(pre.textContent?.split("\n")).toEqual(Array.from({ length: 200 }, (_, index) => `line ${index}`));
  });

  it("opens only persisted reads, retains saved recap when generation is disabled and stops polling when closed", () => {
    const h = harness();
    h.activity([]);
    expect(h.sent.some(request => request.type === "session.recap.get")).toBe(false);
    h.summary.focus();
    h.summary.click();
    h.recap({ enabled: false, recap: { id: 2, text: "<script>not executed</script>", createdAt: 800_000, sourceLeafId: null, stale: null } });
    const popup = query(document, ".session-summary");
    expect(query(popup, ".session-summary-text").textContent).toBe("<script>not executed</script>");
    expect(popup.querySelector("script")).toBeNull();
    expect(query(popup, ".session-summary-text").hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popup.hidden).toBe(true);
    expect(document.activeElement).toBe(h.summary);
    const recapCount = h.sent.filter(request => request.type === "session.recap.get").length;
    vi.advanceTimersByTime(10_000);
    expect(h.sent.filter(request => request.type === "session.recap.get")).toHaveLength(recapCount);
    h.summary.click();
    expect(query(popup, ".session-summary-text").textContent).toBe("<script>not executed</script>");
    const pendingRecap = h.latest("session.recap.get");
    h.summary.click();
    h.summary.click();
    expect(h.latest("session.recap.get").requestId).toBe(pendingRecap.requestId);
    expect(h.sent.every(request => request.type === "session.activity.get" || request.type === "session.recap.get")).toBe(true);
    h.recap({ recap: null, enabled: false });
    expect(query(popup, ".session-summary-text").hidden).toBe(true);
  });

  it("distinguishes unavailable and partial sources from authoritative emptiness and recovers on retry", () => {
    const h = harness();
    const request = h.latest("session.activity.get");
    h.controller.receive({ type: "session.insights.error", sessionId: "one", requestId: request.requestId, operation: "activity", message: "Registry unavailable" });
    expect(query(h.host, ".session-activity").dataset.state).toBe("unavailable");
    const retry = query<HTMLButtonElement>(h.host, ".session-activity-body > .session-insights-retry");
    expect(retry.hidden).toBe(false);
    retry.click();
    const next = h.latest("session.activity.get");
    const partial = snapshot("one", []);
    partial.sources.services = { available: false, error: "Broker unavailable" };
    h.controller.receive({ type: "session.activity.result", sessionId: "one", requestId: next.requestId, activity: partial });
    expect(query(h.host, ".session-activity").dataset.state).toBe("partial");
    expect(query(h.host, ".session-activity-heading").textContent).not.toContain("none");
    retry.click();
    h.activity([]);
    expect(query(h.host, ".session-activity").dataset.state).toBe("current");
    expect(retry.hidden).toBe(true);
    expect(h.host.querySelectorAll(".session-activity-item")).toHaveLength(0);
  });

  it("recovers from missing replies without overlap and cancels timers and handlers on dispose", () => {
    const h = harness();
    const original = h.latest("session.activity.get");
    vi.advanceTimersByTime(15_000);
    expect(h.sent).toHaveLength(1);
    expect(query(h.host, ".session-activity").dataset.state).toBe("unavailable");
    vi.advanceTimersByTime(2_000);
    expect(h.sent).toHaveLength(2);
    h.activity([item("late")], "g1", original);
    expect(h.host.querySelector('[data-activity-id="late"]')).toBeNull();
    h.activity([]);
    h.summary.click();
    h.recap();
    h.controller.dispose();
    const count = h.sent.length;
    h.summary.click();
    vi.advanceTimersByTime(60_000);
    expect(h.sent).toHaveLength(count);
    expect(document.querySelector(".session-summary")).toBeNull();
    expect(h.host.querySelector(".session-activity")).toBeNull();
  });

  it("mounts in separate owner documents and follows an adopted Summary button", () => {
    const h = harness();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const popout = frame.contentDocument!;
    const host = popout.createElement("div");
    popout.body.append(host);
    h.controller.mountActivity(host);
    h.activity([item("server", { kind: "service", status: "ready" })]);
    expect(query(host, ".session-activity-item").ownerDocument).toBe(popout);
    expect(query(h.host, ".session-activity-item").ownerDocument).toBe(document);
    h.summary.click();
    h.recap();
    popout.body.append(h.summary);
    h.controller.sync();
    expect(document.querySelector(".session-summary")).toBeNull();
    h.summary.click();
    expect(query(popout, ".session-summary").hidden).toBe(false);
    expect(query(popout, ".session-summary-text").textContent).toBe("Saved recap");
    popout.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(query(popout, ".session-summary").hidden).toBe(true);
    expect(popout.activeElement).toBe(h.summary);
  });
});
