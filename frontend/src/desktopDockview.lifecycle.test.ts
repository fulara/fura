import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewComponent, SerializedDockview } from "dockview-core";
import type * as DockviewCore from "dockview-core";

const captured = vi.hoisted(() => ({ instances: [] as DockviewComponent[] }));
vi.mock("dockview-core", async importOriginal => {
  const actual = await importOriginal<typeof DockviewCore>();
  return {
    ...actual,
    DockviewComponent: class extends actual.DockviewComponent {
      constructor(...args: ConstructorParameters<typeof actual.DockviewComponent>) {
        super(...args);
        captured.instances.push(this);
      }
    },
  };
});
import { initDesktopDockview } from "./desktopDockview";
import type { DesktopDockviewLayoutMode, PinnedDiffPanelId } from "./desktopDockview";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "focus").mockImplementation(() => {});
});
afterEach(() => {
  for (const api of captured.instances.splice(0)) api.dispose();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(layoutMode: DesktopDockviewLayoutMode = "normal") {
  const host = document.createElement("div");
  host.className = "workspace-panel-host workspace-panel-host-active";
  document.body.append(host);
  const closed = vi.fn();
  const ready = vi.fn();
  const returned = vi.fn();
  const blocked = vi.fn();
  const desktop = initDesktopDockview({
    host, layoutMode, storageKey: `lifecycle.${layoutMode}`,
    onPanelReady: ready, onPanelClosed: closed, onPinnedPanelReturned: returned,
    onPanelActivated() {}, onPopoutBlocked: blocked,
  });
  const api = captured.instances.at(-1)!;
  api.layout(1200, 800);
  return { host, api, desktop, closed, ready, returned, blocked };
}

// Only the browser-window boundary is emulated. Dockview performs the actual
// popout transfer, beforeunload return, group disposal and panel rendering.
function popupWindow(closeEvent: "beforeunload" | "pagehide" = "beforeunload") {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const popup = frame.contentWindow!;
  Object.defineProperty(popup, "ResizeObserver", { value: window.ResizeObserver, configurable: true });
  vi.spyOn(popup, "focus").mockImplementation(() => {});
  let closing = false;
  Object.defineProperty(popup, "closed", { configurable: true, get: () => closing });
  // Unlike an iframe, a closed browser window cannot deliver a queued load.
  popup.addEventListener("load", event => { if (closing) event.stopImmediatePropagation(); }, { capture: true });
  vi.spyOn(popup, "close").mockImplementation(() => {
    if (closing) return;
    closing = true;
    popup.dispatchEvent(new Event(closeEvent));
  });
  vi.spyOn(window, "open").mockReturnValue(popup);
  return popup;
}

async function popout(api: DockviewComponent, item: Parameters<DockviewComponent["api"]["addPopoutGroup"]>[0]) {
  const popup = popupWindow();
  const opened = api.api.addPopoutGroup(item);
  popup.dispatchEvent(new Event("load"));
  expect(await opened).toBe(true);
  return popup;
}

function gridGroup(api: DockviewComponent, id: string) {
  type Node = SerializedDockview["grid"]["root"];
  function visit(node: Node): Node | undefined {
    return Array.isArray(node.data) ? node.data.map(visit).find(Boolean) : node.data.id === id ? node : undefined;
  }
  return visit(api.toJSON().grid.root);
}

describe("Goal removal and legacy layouts", () => {
  it.each(["normal", "diffReview"] as const)("has no Goal entry in a fresh %s workspace", layoutMode => {
    const { api, host } = setup(layoutMode);
    expect(api.panels.map(panel => panel.id)).not.toContain("goal");
    expect([...host.querySelectorAll(".dv-default-tab")].map(tab => tab.textContent)).not.toContain("Goal");
    expect(api.groups.every(group => group.size > 0)).toBe(true);
  });

  it.each([
    ["normal", "tab"], ["normal", "split"], ["normal", "floating"], ["normal", "popout"],
    ["diffReview", "tab"], ["diffReview", "split"], ["diffReview", "floating"], ["diffReview", "popout"],
  ] as const)("removes legacy Goal %s/%s without resetting surviving groups or panel state", async (layoutMode, location) => {
    const { api } = setup(layoutMode);
    const existing = api.getGroupPanel("goal");
    if (existing) api.removePanel(existing);
    const code = api.getGroupPanel("code")!;
    const custom = api.addGroup({ referencePanel: "transcript", direction: "below" });
    code.api.moveTo({ group: custom });
    code.api.updateParameters({ retainedSelection: "src/main.rs:42" });
    code.api.setActive();
    const survivors = api.groups.map(group => ({
      id: group.id,
      panels: group.panels.map(panel => panel.id),
      active: group.activePanel?.id,
    })).sort((a, b) => a.id.localeCompare(b.id));
    api.addPanel({
      id: "goal", component: "goal", title: "Goal",
      ...(location === "floating" ? { floating: true } : {
        position: { referencePanel: "transcript", direction: location === "split" ? "left" : "within" },
      }),
    });
    if (location === "popout") await popout(api, api.getGroupPanel("goal")!);
    const raw = api.toJSON();
    function groupOrder(node: SerializedDockview["grid"]["root"]): string[] {
      return Array.isArray(node.data) ? node.data.flatMap(groupOrder)
        : node.data.views.some(id => id !== "goal") ? [node.data.id] : [];
    }
    const expectedOrder = groupOrder(raw.grid.root);
    const expectedPanels = structuredClone(raw.panels);
    delete expectedPanels.goal;
    localStorage.setItem(`lifecycle.${layoutMode}`, JSON.stringify({ version: 1, layout: raw }));
    const open = vi.spyOn(window, "open");
    open.mockClear();
    const restored = setup(layoutMode);
    expect(restored.api.getGroupPanel("goal")).toBeUndefined();
    expect(restored.ready.mock.calls.map(([id]) => id)).not.toContain("goal");
    expect(restored.api.toJSON().panels).toEqual(expectedPanels);
    expect(groupOrder(restored.api.toJSON().grid.root)).toEqual(expectedOrder);
    expect(restored.api.groups.map(group => ({
      id: group.id, panels: group.panels.map(panel => panel.id),
      active: group.activePanel?.id,
    })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(survivors);
    expect(restored.api.getGroupPanel("code")!.params).toEqual({ retainedSelection: "src/main.rs:42" });
    expect(restored.api.groups.every(group => group.size > 0)).toBe(true);
    expect(open).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("beforeunload"));
    const reloaded = setup(layoutMode);
    expect(reloaded.api.toJSON().grid).toEqual(restored.api.toJSON().grid);
    expect(reloaded.api.toJSON().panels).toEqual(expectedPanels);
  });
});

describe("desktop Dockview close lifecycle", () => {
  it.each(["normal", "diffReview"] as const)("blocks panel and group user-close paths in %s without losing content", layoutMode => {
    const { api, desktop, closed, host } = setup(layoutMode);
    const panel = api.getGroupPanel("transcript")!;
    let content: HTMLElement | undefined;
    desktop.withPanel("transcript", element => { content = element; element.textContent = "unsent draft"; });
    panel.api.close();
    expect(api.getGroupPanel("transcript")).toBe(panel);
    panel.group.api.close();
    panel.group.model.closePanel(panel);
    panel.group.model.closeAllPanels();
    expect(api.getGroupPanel("transcript")).toBe(panel);
    desktop.withPanel("transcript", element => { expect(element).toBe(content); expect(element.textContent).toBe("unsent draft"); });
    expect(closed).not.toHaveBeenCalled();
    expect(host.querySelector(".dv-default-tab-action")).toBeNull();
    expect(host.querySelector(".panel-popout-btn")).not.toBeNull();
  });

  it("keeps intentional panel teardown and ordinary transfers functional", () => {
    const { api, desktop, closed } = setup();
    desktop.ensureComparePanel();
    const compare = api.getGroupPanel("compare")!;
    compare.api.moveTo({ group: api.getGroupPanel("transcript")!.group });
    expect(desktop.panelMounted("compare")).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(desktop.closePanel("compare")).toBe(true);
    expect(desktop.panelMounted("compare")).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith("compare");
    api.removeGroup(api.getGroupPanel("tools")!.group);
    expect(api.getGroupPanel("tools")).toBeUndefined();
  });

  it("keeps native window-close transfer alive without disposing panels", async () => {
    const { api, desktop, closed, ready } = setup();
    const tools = api.getGroupPanel("tools")!;
    const mounts = ready.mock.calls.length;
    const popup = await popout(api, tools);
    popup.close();
    await Promise.resolve();
    expect(api.getGroupPanel("tools")).toBe(tools);
    expect(tools.api.location.type).toBe("grid");
    expect(desktop.panelMounted("tools")).toBe(true);
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).not.toHaveBeenCalled();
  });

  it.each(["beforeunload-checkpoint", "pagehide"] as const)("returns the same popup review across a native %s close boundary", async boundary => {
    vi.useFakeTimers();
    const { api, desktop, ready, closed, returned } = setup();
    desktop.addPinnedPanel("pinnedDiff:native", "Native review");
    const panel = api.getGroupPanel("pinnedDiff:native")!;
    const origin = panel.group;
    let content!: HTMLElement;
    desktop.withPanel("pinnedDiff:native", element => { content = element; });
    content.textContent = "Unsent review";
    const mounts = ready.mock.calls.length;
    const popup = popupWindow(boundary === "pagehide" ? "pagehide" : "beforeunload");
    const listeners = vi.spyOn(popup, "addEventListener");
    const opening = vi.spyOn(api.api, "addPopoutGroup");
    origin.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    popup.dispatchEvent(new Event("load"));
    expect(await opening.mock.results[0].value).toBe(true);

    if (boundary === "beforeunload-checkpoint") {
      const capture = listeners.mock.calls.find(([type, , options]) =>
        type === "beforeunload" && typeof options === "object" && options?.capture)?.[1];
      expect(typeof capture).toBe("function");
      // Browser-native dispatch checkpoints microtasks between listeners.
      // The adapter's capture listener must not start a transfer before the
      // library's later native-redock listener has run.
      (capture as EventListener).call(popup, new Event("beforeunload"));
      await Promise.resolve();
      expect(panel.api.getWindow()).toBe(popup);
      expect(popup.close).not.toHaveBeenCalled();
    }

    popup.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getGroupPanel(panel.id)).toBe(panel);
    expect(panel.group).toBe(origin);
    expect(content.ownerDocument).toBe(document);
    expect(content.isConnected).toBe(true);
    expect(content.textContent).toBe("Unsent review");
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).not.toHaveBeenCalled();
    expect(returned).toHaveBeenCalledExactlyOnceWith(panel.id);
  });

  it.each(["return", "native"] as const)("releases source input overlays for individual popup transfers and %s close", async closeAction => {
    vi.useFakeTimers();
    const { api, desktop, host, ready, closed } = setup();
    desktop.ensureComparePanel();
    desktop.activatePanel("diffs");
    const diffs = api.getGroupPanel("diffs")!;
    const code = api.getGroupPanel("code")!;
    const originalGroup = diffs.group;
    let content!: HTMLElement;
    desktop.withPanel("diffs", element => { content = element; });
    content.textContent = "Retained review";
    content.scrollTop = 125;
    const sourceOverlay = content.closest<HTMLElement>(".dv-render-overlay")!;
    const codeSourceOverlay = code.view.content.element.closest<HTMLElement>(".dv-render-overlay")!;
    const mounts = ready.mock.calls.length;
    const popup = popupWindow();
    const opening = vi.spyOn(api.api, "addPopoutGroup");
    originalGroup.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    popup.dispatchEvent(new Event("load"));
    expect(await opening.mock.results[0].value).toBe(true);
    api.layout(900, 700);
    popup.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(50);

    // A tabbed source takes Dockview's single-panel path. Its otherwise empty,
    // still-visible overlay can cover the remaining main transcript.
    expect(sourceOverlay.isConnected).toBe(false);
    expect(content.ownerDocument).toBe(popup.document);
    expect(host.querySelector(".panel-content-transcript")?.isConnected).toBe(true);
    expect([...host.querySelectorAll(".dv-render-overlay")].every(overlay => overlay.childElementCount > 0)).toBe(true);

    // Transfers into an existing popup and individual returns use the same
    // ownership boundary, without closing the popup's remaining review.
    code.api.moveTo({ group: diffs.group });
    expect(codeSourceOverlay.isConnected).toBe(false);
    const codePopupOverlay = code.view.content.element.closest<HTMLElement>(".dv-render-overlay")!;
    expect(codePopupOverlay.ownerDocument).toBe(popup.document);
    code.api.close();
    await Promise.resolve();
    expect(codePopupOverlay.isConnected).toBe(false);
    expect(code.api.getWindow()).toBe(window);
    expect(popup.close).not.toHaveBeenCalled();

    if (closeAction === "return") popup.document.querySelector<HTMLButtonElement>(".panel-return-btn")!.click();
    else popup.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.getGroupPanel("diffs")).toBe(diffs);
    expect(diffs.group).toBe(originalGroup);
    desktop.withPanel("diffs", element => { expect(element).toBe(content); });
    expect(content.ownerDocument).toBe(document);
    expect(content.scrollTop).toBe(125);
    expect(content.textContent).toBe("Retained review");
    expect([...host.querySelectorAll(".dv-render-overlay")].every(overlay => overlay.childElementCount > 0)).toBe(true);
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).not.toHaveBeenCalled();
  });

  it.each(["code", "transcript"] as const)("returns a native %s popup to its original tab index without remounting", async panelId => {
    const { api, desktop, closed, ready } = setup();
    const panel = api.getGroupPanel(panelId)!;
    const group = panel.group;
    const order = group.panels.map(panel => panel.id);
    let content: HTMLElement | undefined;
    desktop.withPanel(panelId, element => { content = element; });
    const mounts = ready.mock.calls.length;
    const popup = await popout(api, panel);
    popup.close();
    await Promise.resolve();
    expect(panel.group).toBe(group);
    expect(group.panels.map(panel => panel.id)).toEqual(order);
    expect(panel.api.isVisible).toBe(true);
    desktop.withPanel(panelId, element => { expect(element).toBe(content); });
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).not.toHaveBeenCalled();
  });

  it("returns popup close actions instead of destroying panel content", async () => {
    const { api, desktop, closed } = setup();
    const code = api.getGroupPanel("code")!;
    const popup = await popout(api, code);
    expect(popup.document.querySelector<HTMLButtonElement>(".panel-return-btn")?.textContent).toBe("Return to main");
    code.api.close();
    await Promise.resolve();
    expect(api.getGroupPanel("code")).toBe(code);
    expect(code.api.location.type).toBe("grid");
    expect(desktop.panelMounted("code")).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it("returns a whole popup group and keeps hidden workspaces hidden", async () => {
    const { api, host, desktop, closed } = setup();
    const original = api.getGroupPanel("transcript")!.group;
    const panels = [...original.panels];
    await popout(api, original);
    host.classList.remove("workspace-panel-host-active");
    panels[0].group.api.close();
    await Promise.resolve();
    expect(original.panels).toEqual(panels);
    expect(desktop.isPanelVisible("transcript")).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });

  it("returns to the main document when the original group itself became a popup", async () => {
    const { api, closed } = setup();
    const code = api.getGroupPanel("code")!;
    const original = code.group;
    const first = await popout(api, code);
    await popout(api, original);
    first.close();
    await Promise.resolve();
    expect(api.getGroupPanel("code")).toBe(code);
    expect(code.api.getWindow()).toBe(window);
    expect(closed).not.toHaveBeenCalled();
  });

  it("does not recreate a deliberately removed popup panel on deferred return", async () => {
    const { api, desktop, closed } = setup();
    const diffs = api.getGroupPanel("diffs")!;
    const popup = await popout(api, diffs);
    popup.close();
    desktop.closePanel("diffs");
    await Promise.resolve();
    expect(api.getGroupPanel("diffs")).toBeUndefined();
    expect(desktop.panelMounted("diffs")).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith("diffs");
  });

  it("closes individual pinned tabs while retaining other pins and permanent panels", () => {
    const { api, desktop, closed, ready, host } = setup();
    const permanent = [...api.panels];
    ready.mockClear();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A · Current");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B · History");
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const second = api.getGroupPanel("pinnedDiff:b")!;
    expect(first.group).toBe(api.getGroupPanel("diffs")!.group);
    expect(first.group).toBe(second.group);
    second.api.moveTo({ group: api.addGroup() });
    second.api.moveTo({ group: first.group });
    expect(closed).not.toHaveBeenCalled();
    expect(desktop.addPinnedPanel("pinnedDiff:a", "Duplicate")).toBe(false);
    expect(ready).toHaveBeenCalledTimes(2);
    desktop.setPanelTitle("pinnedDiff:a", "Repo A · abc1234");
    const tab = [...host.querySelectorAll<HTMLElement>(".dv-default-tab")]
      .find(element => element.textContent?.includes("Repo A · abc1234"))!;
    tab.querySelector<HTMLButtonElement>(".panel-close-btn")!.click();
    expect(api.getGroupPanel("pinnedDiff:a")).toBeUndefined();
    expect(api.getGroupPanel("pinnedDiff:b")).toBe(second);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    second.api.close();
    expect(api.panels).toEqual(permanent);
    expect(closed.mock.calls).toEqual([["pinnedDiff:a"], ["pinnedDiff:b"]]);
    expect(host.querySelector(".panel-close-btn")).toBeNull();
  });

  it("transfers one content DOM and selected-tab intent without closing drafts or reordering returning pins", async () => {
    const normal = setup();
    const review = setup("diffReview");
    const ids = ["pinnedDiff:a", "pinnedDiff:b", "pinnedDiff:c"] as const;
    for (const id of ids) normal.desktop.addPinnedPanel(id, id);
    normal.desktop.activatePanel(ids[0]);
    const original = normal.api.getGroupPanel(ids[0])!.group;
    const order = original.panels.map(panel => panel.id);
    const content = new Map<PinnedDiffPanelId, HTMLElement>();
    for (const id of ids) normal.desktop.withPanel(id, element => {
      content.set(id, element);
      const draft = document.createElement("textarea");
      draft.value = `Unsent ${id}`;
      element.append(draft);
      element.scrollTop = 143;
    });
    for (const [from, to] of [[normal, review], [review, normal]]) {
      for (const id of ids) {
        const presentation = from.desktop.detachPinnedPanel(id)!;
        expect(presentation.content).toBe(content.get(id));
        expect(from.desktop.panelMounted(id)).toBe(false);
        expect(from.api.getGroupPanel(id)).toBeUndefined();
        expect(to.desktop.addPinnedPanel(id, presentation.title, presentation)).toBe(true);
      }
      await Promise.resolve();
      expect(to.api.getGroupPanel(ids[0])!.group.activePanel?.id).toBe(ids[0]);
      for (const id of ids) to.desktop.withPanel(id, element => {
        expect(element).toBe(content.get(id));
        expect(element.querySelector("textarea")!.value).toBe(`Unsent ${id}`);
        expect(element.scrollTop).toBe(143);
        expect(element.isConnected).toBe(true);
      });
      expect(from.closed).not.toHaveBeenCalled();
      expect(to.closed).not.toHaveBeenCalled();
    }
    expect(normal.api.getGroupPanel(ids[0])!.group).toBe(original);
    expect(original.panels.map(panel => panel.id)).toEqual(order);
  });

  it("retains pre-hide scroll through inactive transfers whose hidden scrollers report zero", async () => {
    vi.useFakeTimers();
    const normal = setup();
    const review = setup("diffReview");
    const id = "pinnedDiff:scroll" as const;
    normal.desktop.addPinnedPanel(id, "Repo A");
    const root = document.createElement("div");
    root.className = "diffs-view";
    root.dataset.reviewTarget = "immutable:A";
    const body = document.createElement("div");
    body.className = "diffs-main-body";
    root.append(body);
    normal.desktop.withPanel(id, element => { element.append(root); });
    const displayed = () => root.isConnected
      && root.closest<HTMLElement>(".dv-render-overlay")?.style.display !== "none";
    // JSDOM has no layout: emulate browser reads/clamping under display:none,
    // while real Dockview drives visibility, wrapper disposal and activation.
    let top = 0;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => displayed() ? top : 0,
      set: (value: number) => { top = displayed() ? value : 0; },
    });
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => displayed()
      ? new DOMRect(0, 0, 560, 400) : new DOMRect());
    await vi.advanceTimersByTimeAsync(50);
    body.scrollTop = 247;
    normal.desktop.activatePanel("diffs");
    expect(body.scrollTop).toBe(0);
    for (const [from, to] of [[normal, review], [review, normal], [normal, review], [review, normal]]) {
      const presentation = from.desktop.detachPinnedPanel(id)!;
      to.desktop.addPinnedPanel(id, presentation.title, presentation);
      await vi.advanceTimersByTimeAsync(50);
      expect(body.scrollTop).toBe(0);
      to.desktop.withPanel(id, element => { expect(element.querySelector(".diffs-view")).toBe(root); });
    }
    normal.desktop.activatePanel(id);
    await vi.advanceTimersByTimeAsync(50);
    expect(body.scrollTop).toBe(247);
    // A fresh visible scroll after the next paint wins over the retained snapshot.
    body.scrollTop = 0;
    normal.desktop.activatePanel("diffs");
    normal.desktop.activatePanel(id);
    await vi.advanceTimersByTimeAsync(16);
    body.scrollTop = 330;
    await vi.advanceTimersByTimeAsync(50);
    expect(body.scrollTop).toBe(330);
    body.scrollTop = 0;
    normal.desktop.activatePanel("diffs");
    const presentation = normal.desktop.detachPinnedPanel(id)!;
    review.desktop.addPinnedPanel(id, presentation.title, presentation);
    review.desktop.activatePanel(id);
    await vi.advanceTimersByTimeAsync(50);
    expect(body.scrollTop).toBe(0);
    expect(normal.closed).not.toHaveBeenCalled();
    expect(review.closed).not.toHaveBeenCalled();
  });

  it("selects an inactive returning pin locally in its empty manual group without stealing workspace focus", () => {
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const group = normal.api.addGroup({ referencePanel: "diffs", direction: "right" });
    normal.api.getGroupPanel("pinnedDiff:a")!.api.moveTo({ group });
    const outgoing = normal.desktop.detachPinnedPanel("pinnedDiff:a")!;
    review.desktop.addPinnedPanel(outgoing.id, outgoing.title, outgoing);
    review.desktop.activatePanel("sessionChanges");
    const returning = review.desktop.detachPinnedPanel(outgoing.id)!;
    expect(returning.active).toBe(false);
    normal.desktop.activatePanel("transcript");
    normal.desktop.addPinnedPanel(returning.id, returning.title, returning);
    expect(normal.api.getGroupPanel(returning.id)!.group).toBe(group);
    expect(group.activePanel?.id).toBe(returning.id);
    expect(normal.desktop.isPanelVisible(returning.id)).toBe(true);
    expect(normal.api.activePanel?.id).toBe("transcript");
  });

  it("evacuates a manual pin-only split at zero space and restores its cached size", async () => {
    const normal = setup();
    const review = setup("diffReview");
    normal.api.layout(1920, 1080);
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const panel = normal.api.getGroupPanel("pinnedDiff:a")!;
    const group = normal.api.addGroup({ referencePanel: "diffs", direction: "right" });
    panel.api.moveTo({ group });
    group.api.setSize({ width: 340 });
    const before = gridGroup(normal.api, group.id)!;
    const diffs = normal.api.getGroupPanel("diffs")!.group;
    const width = diffs.width;
    const outgoing = normal.desktop.detachPinnedPanel("pinnedDiff:a")!;
    review.desktop.addPinnedPanel(outgoing.id, outgoing.title, outgoing);
    expect(group.size).toBe(0);
    expect(group.api.isVisible).toBe(false);
    expect(gridGroup(normal.api, group.id)).toMatchObject({ visible: false, size: before.size });
    expect(diffs.width).toBeGreaterThan(width);
    const returning = review.desktop.detachPinnedPanel("pinnedDiff:a")!;
    normal.desktop.addPinnedPanel(returning.id, returning.title, returning);
    expect(normal.api.getGroupPanel(returning.id)!.group).toBe(group);
    expect(group.api.isVisible).toBe(true);
    expect(gridGroup(normal.api, group.id)!.size).toBe(before.size);
    const closingAway = normal.desktop.detachPinnedPanel(returning.id)!;
    review.desktop.addPinnedPanel(closingAway.id, closingAway.title, closingAway);
    review.closed.mockImplementation((id: PinnedDiffPanelId) => {
      normal.desktop.forgetPinnedPanel(id);
      review.desktop.forgetPinnedPanel(id);
    });
    review.desktop.closePanel(closingAway.id);
    await Promise.resolve();
    expect(normal.api.groups).not.toContain(group);
    expect(normal.closed).not.toHaveBeenCalled();
    expect(review.closed).toHaveBeenCalledExactlyOnceWith(returning.id);
  });

  it.each(["window", "group", "toolbar"] as const)("keeps an inactive workspace popup visible and transfers its %s return only after native correction", async action => {
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A · Current");
    const first = normal.api.getGroupPanel("pinnedDiff:a")!;
    const original = first.group;
    const order = original.panels.map(panel => panel.id);
    let content: HTMLElement | undefined;
    let draft: HTMLTextAreaElement | undefined;
    normal.desktop.withPanel("pinnedDiff:a", element => {
      content = element;
      draft = document.createElement("textarea");
      draft.value = "Send only to A";
      element.append(draft);
      element.scrollTop = 143;
      element.scrollLeft = 29;
    });
    const popup = await popout(normal.api, first);
    expect(normal.desktop.detachPinnedPanel("pinnedDiff:a")).toBeNull();
    normal.host.classList.remove("workspace-panel-host-active");
    popup.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    normal.desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.ownerDocument).toBe(popup.document);
      expect(element.style.visibility).toBe("");
    });
    expect(normal.desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(true);
    expect(normal.desktop.isPanelVisible("pinnedDiff:a")).toBe(true);
    normal.returned.mockImplementation((id: PinnedDiffPanelId) => {
      expect(first.group).toBe(original);
      expect(original.panels.map(panel => panel.id)).toEqual(order);
      expect(normal.desktop.isPanelPoppedOut(id)).toBe(false);
      const presentation = normal.desktop.detachPinnedPanel(id)!;
      review.desktop.addPinnedPanel(id, presentation.title, presentation);
    });
    if (action === "window") popup.close();
    else if (action === "group") first.group.api.close();
    else popup.document.querySelector<HTMLButtonElement>(".panel-return-btn")!.click();
    await Promise.resolve();
    expect(normal.returned).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(normal.desktop.panelMounted("pinnedDiff:a")).toBe(false);
    expect(review.api.getGroupPanel("pinnedDiff:a")!.group).toBe(review.api.getGroupPanel("sessionChanges")!.group);
    review.desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.ownerDocument).toBe(document);
      expect(element.querySelector("textarea")).toBe(draft);
      expect(draft!.value).toBe("Send only to A");
      expect(element.scrollTop).toBe(143);
      expect(element.scrollLeft).toBe(29);
    });
    expect(normal.closed).not.toHaveBeenCalled();
    expect(review.closed).not.toHaveBeenCalled();
  });

  it("keeps a pin-only popup return group hidden when its last docked sibling closes, then removes it on final close", async () => {
    const { api, desktop, closed } = setup();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B");
    const group = api.addGroup({ referencePanel: "diffs", direction: "right" });
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const second = api.getGroupPanel("pinnedDiff:b")!;
    first.api.moveTo({ group });
    second.api.moveTo({ group });
    const popup = await popout(api, first);
    second.api.close();
    await Promise.resolve();
    expect(group.size).toBe(0);
    expect(group.api.isVisible).toBe(false);
    expect(gridGroup(api, group.id)?.visible).toBe(false);
    expect(first.api.getWindow()).toBe(popup);
    popup.document.querySelector<HTMLButtonElement>(".panel-close-btn")!.click();
    await Promise.resolve();
    expect(api.groups).not.toContain(group);
    expect(closed.mock.calls).toEqual([["pinnedDiff:b"], ["pinnedDiff:a"]]);
    expect(desktop.panelMounted("diffs")).toBe(true);
  });

  it("returns multiple separately opened pins in their remembered order", async () => {
    const { api, desktop, closed } = setup();
    const ids = ["pinnedDiff:a", "pinnedDiff:b", "pinnedDiff:c"] as const;
    for (const id of ids) desktop.addPinnedPanel(id, id);
    const group = api.getGroupPanel(ids[0])!.group;
    const order = group.panels.map(panel => panel.id);
    const first = await popout(api, api.getGroupPanel(ids[0])!);
    const second = await popout(api, api.getGroupPanel(ids[1])!);
    second.close();
    await Promise.resolve();
    first.close();
    await Promise.resolve();
    expect(group.panels.map(panel => panel.id)).toEqual(order);
    expect(closed).not.toHaveBeenCalled();
  });

  it("falls back to docked Diffs when a pin's saved group has disappeared", async () => {
    const { api, desktop, returned, closed } = setup();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const panel = api.getGroupPanel("pinnedDiff:a")!;
    const original = api.addGroup({ referencePanel: "diffs", direction: "right" });
    panel.api.moveTo({ group: original });
    const popup = await popout(api, panel);
    api.removeGroup(original);
    popup.close();
    await Promise.resolve();
    expect(api.getGroupPanel(panel.id)).toBe(panel);
    expect(panel.group).toBe(api.getGroupPanel("diffs")!.group);
    expect(returned).toHaveBeenCalledExactlyOnceWith(panel.id);
    expect(closed).not.toHaveBeenCalled();
  });

  it("falls back to the main grid when both the remembered group and Diffs are unavailable", async () => {
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const original = normal.api.addGroup({ referencePanel: "diffs", direction: "right" });
    normal.api.getGroupPanel("pinnedDiff:a")!.api.moveTo({ group: original });
    const presentation = normal.desktop.detachPinnedPanel("pinnedDiff:a")!;
    review.desktop.addPinnedPanel(presentation.id, presentation.title, presentation);
    normal.api.removeGroup(original);
    await popout(normal.api, normal.api.getGroupPanel("diffs")!);
    const returning = review.desktop.detachPinnedPanel(presentation.id)!;
    normal.desktop.addPinnedPanel(returning.id, returning.title, returning);
    expect(normal.api.getGroupPanel(returning.id)!.api.location.type).toBe("grid");
    expect(normal.api.getGroupPanel(returning.id)!.group).toBe(normal.api.getGroupPanel("transcript")!.group);
  });

  it("retains pin ownership and content while its popup loads across a workspace switch", async () => {
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const panel = normal.api.getGroupPanel("pinnedDiff:a")!;
    let content: HTMLElement | undefined;
    normal.desktop.withPanel("pinnedDiff:a", element => { content = element; element.textContent = "Unsent A review"; });
    const popup = popupWindow();
    const opening = vi.spyOn(normal.api.api, "addPopoutGroup");
    const button = panel.group.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!;
    button.click();
    button.click();
    expect(window.open).toHaveBeenCalledOnce();
    normal.host.classList.remove("workspace-panel-host-active");
    expect(normal.desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(true);
    expect(normal.desktop.detachPinnedPanel("pinnedDiff:a")).toBeNull();
    expect(normal.api.getGroupPanel("pinnedDiff:a")).toBe(panel);
    expect(review.desktop.panelMounted("pinnedDiff:a")).toBe(false);
    popup.dispatchEvent(new Event("load"));
    expect(await opening.mock.results[0].value).toBe(true);
    normal.desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.ownerDocument).toBe(popup.document);
      expect(element.textContent).toBe("Unsent A review");
      expect(element.style.visibility).toBe("");
    });
    expect(panel.api.location.type).toBe("popout");
    expect(normal.desktop.isPanelVisible("pinnedDiff:a")).toBe(true);
    expect(normal.closed).not.toHaveBeenCalled();
    expect(normal.returned).not.toHaveBeenCalled();
  });

  it("returns a pin after pre-load native window close without mistaking initial navigation for closure", async () => {
    vi.useFakeTimers();
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    let content: HTMLElement | undefined;
    normal.desktop.withPanel("pinnedDiff:a", element => { content = element; element.textContent = "Unsent A review"; });
    normal.returned.mockImplementation((id: PinnedDiffPanelId) => {
      const presentation = normal.desktop.detachPinnedPanel(id)!;
      review.desktop.addPinnedPanel(id, presentation.title, presentation);
    });
    const popup = popupWindow();
    // Hold the window boundary at its initial document, like a delayed HTTP response.
    popup.addEventListener("load", event => { event.stopImmediatePropagation(); }, { capture: true });
    normal.api.getGroupPanel("pinnedDiff:a")!.group.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    normal.host.classList.remove("workspace-panel-host-active");
    popup.dispatchEvent(new Event("beforeunload"));
    await vi.advanceTimersByTimeAsync(100);
    expect(normal.returned).not.toHaveBeenCalled();
    expect(normal.desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(true);
    expect(normal.desktop.detachPinnedPanel("pinnedDiff:a")).toBeNull();
    popup.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(normal.returned).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(normal.desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(false);
    expect(normal.desktop.panelMounted("pinnedDiff:a")).toBe(false);
    expect(review.desktop.panelMounted("pinnedDiff:a")).toBe(true);
    review.desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.textContent).toBe("Unsent A review");
    });
    expect(normal.closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(normal.returned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a blocked pending pin to the newly active workspace", async () => {
    const normal = setup();
    const review = setup("diffReview");
    normal.desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    let content: HTMLElement | undefined;
    normal.desktop.withPanel("pinnedDiff:a", element => { content = element; });
    normal.returned.mockImplementation((id: PinnedDiffPanelId) => {
      const presentation = normal.desktop.detachPinnedPanel(id)!;
      review.desktop.addPinnedPanel(id, presentation.title, presentation);
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const opening = vi.spyOn(normal.api.api, "addPopoutGroup");
    normal.api.getGroupPanel("pinnedDiff:a")!.group.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    normal.host.classList.remove("workspace-panel-host-active");
    expect(normal.desktop.detachPinnedPanel("pinnedDiff:a")).toBeNull();
    expect(await opening.mock.results[0].value).toBe(false);
    expect(normal.returned).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(normal.desktop.panelMounted("pinnedDiff:a")).toBe(false);
    review.desktop.withPanel("pinnedDiff:a", element => { expect(element).toBe(content); });
    expect(review.api.getGroupPanel("pinnedDiff:a")!.group).toBe(review.api.getGroupPanel("sessionChanges")!.group);
    expect(normal.closed).not.toHaveBeenCalled();
  });

  it.each(["loading", "loaded"] as const)("closes a pending %s popup window when its pin is explicitly deleted", async phase => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error");
    const { api, desktop, closed, returned } = setup();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const panel = api.getGroupPanel("pinnedDiff:a")!;
    const popup = popupWindow();
    const opening = vi.spyOn(api.api, "addPopoutGroup");
    panel.group.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    if (phase === "loaded") popup.dispatchEvent(new Event("load"));
    desktop.closePanel("pinnedDiff:a");
    if (phase === "loaded") expect(await opening.mock.results[0].value).toBe(false);
    if (phase === "loading") {
      popup.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(popup.close).toHaveBeenCalled();
    expect(api.getGroupPanel("pinnedDiff:a")).toBeUndefined();
    expect(desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(returned).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("leaves the same usable pin in place when the browser blocks its popup", async () => {
    const { api, desktop, host, blocked, returned, closed } = setup();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const panel = api.getGroupPanel("pinnedDiff:a")!;
    const group = panel.group;
    const layout = api.toJSON().grid;
    let content: HTMLElement | undefined;
    desktop.withPanel("pinnedDiff:a", element => { content = element; element.textContent = "Local review"; });
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const opening = vi.spyOn(api.api, "addPopoutGroup");
    const button = group.element.querySelector<HTMLButtonElement>(".panel-popout-btn")!;
    expect(host.contains(button)).toBe(true);
    button.click();
    await opening.mock.results[0].value;
    expect(blocked).toHaveBeenCalledOnce();
    expect(api.getGroupPanel(panel.id)).toBe(panel);
    expect(panel.group).toBe(group);
    expect(api.toJSON().grid).toEqual(layout);
    expect(desktop.isPanelPoppedOut("pinnedDiff:a")).toBe(false);
    desktop.withPanel("pinnedDiff:a", element => { expect(element).toBe(content); expect(element.textContent).toBe("Local review"); });
    expect(returned).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(closed).not.toHaveBeenCalled();
  });

  it("cancels pending popup resize work when the native window closes", async () => {
    vi.useFakeTimers();
    const { api, desktop, closed } = setup();
    desktop.addPinnedPanel("pinnedDiff:resize", "Resize review");
    const panel = api.getGroupPanel("pinnedDiff:resize")!;
    desktop.withPanel("pinnedDiff:resize", element => { element.textContent = "Retained review"; });
    const popup = await popout(api, panel);
    popup.dispatchEvent(new Event("resize"));
    popup.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.getGroupPanel("pinnedDiff:resize")).toBe(panel);
    expect(panel.api.getWindow()).toBe(window);
    desktop.withPanel("pinnedDiff:resize", element => { expect(element.textContent).toBe("Retained review"); });
    expect(closed).not.toHaveBeenCalled();
  });

  it("deletes only an explicitly closed popup tab and returns its surviving pin without remounting", async () => {
    const { api, desktop, closed, ready } = setup();
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B");
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const second = api.getGroupPanel("pinnedDiff:b")!;
    const group = api.addGroup({ referencePanel: "diffs", direction: "right" });
    first.api.moveTo({ group });
    second.api.moveTo({ group });
    const mounts = ready.mock.calls.length;
    const popup = await popout(api, group);
    const firstTab = [...popup.document.querySelectorAll<HTMLElement>(".dv-default-tab")]
      .find(element => element.textContent?.includes("Repo A"))!;
    firstTab.querySelector<HTMLButtonElement>(".panel-close-btn")!.click();
    await Promise.resolve();
    expect(api.getGroupPanel("pinnedDiff:a")).toBeUndefined();
    expect(second.api.getWindow()).toBe(popup);
    expect(popup.close).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    popup.close();
    await Promise.resolve();
    expect(api.getGroupPanel("pinnedDiff:b")).toBe(second);
    expect(second.api.getWindow()).toBe(window);
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
  });

  it("does not resurrect the last popup pin when closing its tab also closes the window", async () => {
    const { api, desktop, closed, returned } = setup();
    const permanent = [...api.panels];
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const popup = await popout(api, api.getGroupPanel("pinnedDiff:a")!);
    popup.document.querySelector<HTMLButtonElement>(".panel-close-btn")!.click();
    await Promise.resolve();
    expect(api.panels).toEqual(permanent);
    expect(api.groups.every(group => group.size > 0)).toBe(true);
    expect(desktop.panelMounted("pinnedDiff:a")).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
    expect(returned).not.toHaveBeenCalled();
  });

  it.each(["normal", "diffReview"] as const)("prunes transient and unknown saved tabs, empty groups and active references in %s", async layoutMode => {
    const { api } = setup(layoutMode);
    const docked: PinnedDiffPanelId = "pinnedDiff:docked";
    const floating: PinnedDiffPanelId = "pinnedDiff:floating";
    const detached: PinnedDiffPanelId = "pinnedDiff:popup";
    api.addPanel({ id: docked, component: docked, position: { referencePanel: "transcript", direction: "within" } });
    api.addPanel({ id: floating, component: floating, floating: true });
    api.addPanel({ id: "unknown", component: "missing" });
    api.addPanel({ id: detached, component: detached });
    await popout(api, api.getGroupPanel(detached)!);
    const raw = api.toJSON();
    raw.panels.code.contentComponent = "missing";
    raw.panels.code.title = "Broken saved component";
    window.dispatchEvent(new Event("beforeunload"));
    const saved = JSON.parse(localStorage.getItem(`lifecycle.${layoutMode}`)!);
    expect(Object.keys(saved.layout.panels).sort()).toEqual(layoutMode === "normal"
      ? ["code", "diffs", "tools", "transcript"]
      : ["code", "sessionChanges", "tools", "transcript"]);
    expect(saved.layout.floatingGroups ?? []).toEqual([]);
    expect(saved.layout.popoutGroups).toBeUndefined();
    localStorage.setItem(`lifecycle.${layoutMode}`, JSON.stringify({ version: 1, layout: raw }));
    const open = vi.spyOn(window, "open");
    open.mockClear();
    const restored = setup(layoutMode);
    expect(restored.api.panels.map(panel => panel.id).sort()).toEqual(Object.keys(saved.layout.panels).sort());
    expect(restored.api.getGroupPanel("code")!.title).toBe("Code");
    expect(restored.api.groups.every(group => group.size > 0)).toBe(true);
    expect(restored.api.groups.every(group => group.panels.includes(group.activePanel!))).toBe(true);
    expect(restored.ready.mock.calls.some(([id]) => id === "unknown" || id.startsWith("pinnedDiff:"))).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("restores saved popup panels in their owning workspace without reopening windows", async () => {
    const { api, desktop } = setup();
    desktop.ensureComparePanel();
    const compare = api.getGroupPanel("compare")!;
    await popout(api, compare);
    vi.useFakeTimers();
    localStorage.setItem("lifecycle.normal", JSON.stringify({ version: 1, layout: api.toJSON() }));
    const open = vi.spyOn(window, "open");
    open.mockClear();
    const restored = setup();
    expect(restored.api.getGroupPanel("compare")?.api.getWindow()).toBe(window);
    expect(restored.api.panels.filter(panel => panel.id === "compare")).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the fullest original order when shutting down multiple popouts", async () => {
    const { api } = setup();
    const original = api.getGroupPanel("transcript")!.group;
    const order = original.panels.map(panel => panel.id);
    await popout(api, api.getGroupPanel("transcript")!);
    await popout(api, api.getGroupPanel("code")!);
    window.dispatchEvent(new Event("beforeunload"));
    const restored = setup();
    expect(restored.api.getGroupPanel("transcript")!.group.panels.map(panel => panel.id)).toEqual(order);
  });

  it("restores mixed-origin popup tabs to their own surviving groups on shutdown", async () => {
    const { api } = setup();
    const code = api.getGroupPanel("code")!;
    const codeGroup = code.group.id;
    const toolsGroup = api.getGroupPanel("tools")!.group.id;
    await popout(api, api.getGroupPanel("tools")!);
    code.api.moveTo({ group: api.getGroupPanel("tools")!.group });
    window.dispatchEvent(new Event("beforeunload"));
    const restored = setup();
    expect(restored.api.getGroupPanel("code")!.group.id).toBe(codeGroup);
    expect(restored.api.getGroupPanel("tools")!.group.id).toBe(toolsGroup);
    expect(restored.api.getGroupPanel("code")!.group.panels.map(panel => panel.id)).toEqual(["transcript", "code"]);
  });
});
