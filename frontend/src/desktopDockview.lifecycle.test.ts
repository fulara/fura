import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewComponent } from "dockview-core";
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
  const desktop = initDesktopDockview({
    host, layoutMode, storageKey: `lifecycle.${layoutMode}`,
    onPanelReady: ready, onPanelClosed: closed,
    onPanelActivated() {}, onPopoutBlocked() {},
  });
  const api = captured.instances.at(-1)!;
  api.layout(1200, 800);
  return { host, api, desktop, closed, ready };
}

// Only the browser-window boundary is emulated. Dockview performs the actual
// popout transfer, beforeunload return, group disposal and panel rendering.
async function popout(api: DockviewComponent, item: Parameters<DockviewComponent["api"]["addPopoutGroup"]>[0]) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const popup = frame.contentWindow!;
  vi.spyOn(popup, "focus").mockImplementation(() => {});
  let closing = false;
  vi.spyOn(popup, "close").mockImplementation(() => {
    if (closing) return;
    closing = true;
    popup.dispatchEvent(new Event("beforeunload"));
  });
  vi.spyOn(window, "open").mockReturnValue(popup);
  const opened = api.api.addPopoutGroup(item);
  popup.dispatchEvent(new Event("load"));
  expect(await opened).toBe(true);
  return popup;
}

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

  it.each(["goal", "transcript"] as const)("returns a native %s popup to its original tab index without remounting", async panelId => {
    const { api, desktop, closed, ready } = setup();
    const goal = api.getGroupPanel(panelId)!;
    const group = goal.group;
    const order = group.panels.map(panel => panel.id);
    let content: HTMLElement | undefined;
    desktop.withPanel(panelId, element => { content = element; });
    const mounts = ready.mock.calls.length;
    const popup = await popout(api, goal);
    popup.close();
    await Promise.resolve();
    expect(goal.group).toBe(group);
    expect(group.panels.map(panel => panel.id)).toEqual(order);
    expect(goal.api.isVisible).toBe(true);
    desktop.withPanel(panelId, element => { expect(element).toBe(content); });
    expect(ready).toHaveBeenCalledTimes(mounts);
    expect(closed).not.toHaveBeenCalled();
  });

  it("returns popup close actions instead of destroying panel content", async () => {
    const { api, desktop, closed } = setup();
    const goal = api.getGroupPanel("goal")!;
    const popup = await popout(api, goal);
    expect(popup.document.querySelector<HTMLButtonElement>(".panel-return-btn")?.textContent).toBe("Return to main");
    goal.api.close();
    await Promise.resolve();
    expect(api.getGroupPanel("goal")).toBe(goal);
    expect(goal.api.location.type).toBe("grid");
    expect(desktop.panelMounted("goal")).toBe(true);
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
    const goal = api.getGroupPanel("goal")!;
    const original = goal.group;
    const first = await popout(api, goal);
    await popout(api, original);
    first.close();
    await Promise.resolve();
    expect(api.getGroupPanel("goal")).toBe(goal);
    expect(goal.api.getWindow()).toBe(window);
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

  it("closes individual pinned tabs while retaining other pins and static workspaces", () => {
    const normal = setup();
    const { api, desktop, closed, ready, host } = setup("pinned");
    expect(api.panels).toEqual([]);
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A · Current");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B · History");
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const second = api.getGroupPanel("pinnedDiff:b")!;
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
    expect(api.panels).toEqual([]);
    expect(closed.mock.calls).toEqual([["pinnedDiff:a"], ["pinnedDiff:b"]]);
    expect(host.querySelector(".panel-close-btn")).toBeNull();
    expect(normal.desktop.panelMounted("diffs")).toBe(true);
    expect(normal.closed).not.toHaveBeenCalled();
  });

  it.each(["window", "group", "toolbar"] as const)("redocks pinned %s returns after workspace switches without remounting or losing local state", async action => {
    const normal = setup();
    const review = setup("diffReview");
    const { api, desktop, closed, ready } = setup("pinned");
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A · Current");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B · History");
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const original = first.group;
    const order = original.panels.map(panel => panel.id);
    let content: HTMLElement | undefined;
    let draft: HTMLTextAreaElement | undefined;
    desktop.withPanel("pinnedDiff:a", element => {
      content = element;
      draft = element.ownerDocument.createElement("textarea");
      draft.value = "Send only to A";
      element.append(draft);
      element.scrollTop = 143;
      element.scrollLeft = 29;
    });
    const popup = await popout(api, original);
    for (let index = 0; index < 3; index++) {
      normal.host.classList.toggle("workspace-panel-host-active", index % 2 === 0);
      review.host.classList.toggle("workspace-panel-host-active", index % 2 !== 0);
      popup.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    }
    desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.ownerDocument).toBe(popup.document);
      expect(element.style.visibility).toBe("");
    });
    if (action === "window") popup.close();
    else if (action === "group") first.group.api.close();
    else popup.document.querySelector<HTMLButtonElement>(".panel-return-btn")!.click();
    await Promise.resolve();
    expect(first.group).toBe(original);
    expect(original.panels.map(panel => panel.id)).toEqual(order);
    desktop.withPanel("pinnedDiff:a", element => {
      expect(element).toBe(content);
      expect(element.ownerDocument).toBe(document);
      expect(element.querySelector("textarea")).toBe(draft);
      expect(draft!.value).toBe("Send only to A");
      expect(element.scrollTop).toBe(143);
      expect(element.scrollLeft).toBe(29);
    });
    expect(ready).toHaveBeenCalledTimes(2);
    expect(closed).not.toHaveBeenCalled();
  });

  it("cancels pending popup resize work when the native window closes", async () => {
    vi.useFakeTimers();
    const { api, desktop, closed } = setup("pinned");
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

  it("deletes only the explicitly closed popup tab, then returns its surviving pin", async () => {
    const { api, desktop, closed, ready } = setup("pinned");
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B");
    const first = api.getGroupPanel("pinnedDiff:a")!;
    const second = api.getGroupPanel("pinnedDiff:b")!;
    const popup = await popout(api, first.group);
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
    expect(ready).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
  });

  it("does not resurrect the last pin when closing its popup tab also closes the window", async () => {
    const { api, desktop, closed } = setup("pinned");
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    const popup = await popout(api, api.getGroupPanel("pinnedDiff:a")!);
    popup.document.querySelector<HTMLButtonElement>(".panel-close-btn")!.click();
    await Promise.resolve();
    expect(api.panels).toEqual([]);
    expect(api.groups).toEqual([]);
    expect(desktop.panelMounted("pinnedDiff:a")).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith("pinnedDiff:a");
  });

  it("saves no pin descriptors and starts empty on reload even with an old saved layout", async () => {
    vi.useFakeTimers();
    const { api, desktop } = setup("pinned");
    desktop.addPinnedPanel("pinnedDiff:a", "Repo A");
    desktop.addPinnedPanel("pinnedDiff:b", "Repo B");
    const raw = api.toJSON();
    await vi.advanceTimersByTimeAsync(500);
    const saved = JSON.parse(localStorage.getItem("lifecycle.pinned")!);
    expect(saved.layout.panels).toEqual({});
    expect(saved.layout.grid.root.data).toEqual([]);
    expect(saved.layout.activeGroup).toBeUndefined();
    localStorage.setItem("lifecycle.pinned", JSON.stringify({ version: 1, layout: raw }));
    const restored = setup("pinned");
    expect(restored.api.panels).toEqual([]);
    expect(restored.api.groups).toEqual([]);
    expect(restored.ready).not.toHaveBeenCalled();
    expect(restored.desktop.addPinnedPanel("pinnedDiff:a", "New review")).toBe(true);
    expect(restored.api.panels.map(panel => panel.title)).toEqual(["New review"]);
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
      ? ["code", "diffs", "goal", "tools", "transcript"]
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
    await popout(api, api.getGroupPanel("goal")!);
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
    expect(restored.api.getGroupPanel("code")!.group.panels.map(panel => panel.id)).toEqual(["transcript", "goal", "code"]);
  });
});
