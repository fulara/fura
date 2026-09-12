import { beforeEach, describe, expect, it, vi } from "vitest";

type MockPanel = {
  id: string;
  group: MockGroup;
  title: string;
  api: { setTitle(title: string): void; setActive(): void; getWindow(): { focus(): void }; readonly isVisible: boolean; onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void): { dispose(): void } };
  setActiveCalls: number;
  windowFocusCalls: number;
  setActive(): void;
  readonly isVisible: boolean;
  onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void): { dispose(): void };
  onDidLocationChange(listener: () => void): { dispose(): void };
  emitVisibility(): void;
  getWindow(): { focus(): void };
};
type MockGroup = {
  id: string;
  panels: MockPanel[];
  size: number;
  activePanel?: MockPanel;
  headerActions?: HTMLElement;
  api: { setConstraints(value: { minimumWidth: number }): void };
};

type MockDockviewInstance = {
  panels: MockPanel[];
  activePanel: MockPanel | undefined;
  popoutCalls: Array<{ item: MockPanel | MockGroup; options: unknown }>;
  removePanel(panel: MockPanel): void;
};

const dockviewMock = vi.hoisted(() => {
  const instances: MockDockviewInstance[] = [];

  class MockDockviewComponent {
    readonly panels: MockPanel[] = [];
    activePanel: MockPanel | undefined;
    get api(): MockDockviewComponent { return this; }
    private readonly removeListeners: Array<(panel: MockPanel) => void> = [];
    private readonly activeListeners: Array<(panel: MockPanel) => void> = [];
    readonly popoutCalls: Array<{ item: MockPanel | MockGroup; options: unknown }> = [];
    private readonly createComponent: (options: { name: string }) => {
      element: HTMLElement;
      init(params: { api: MockPanel; containerApi: MockDockviewComponent }): void;
    };
    private readonly createRightHeaderActionComponent: (group: MockGroup) => { element: HTMLElement };

    constructor(private readonly host: HTMLElement, options: {
      createComponent: MockDockviewComponent["createComponent"];
      createRightHeaderActionComponent: MockDockviewComponent["createRightHeaderActionComponent"];
    }) {
      this.createComponent = options.createComponent;
      this.createRightHeaderActionComponent = options.createRightHeaderActionComponent;
      instances.push(this);
    }

    addPanel(options: { id: string; component: string; title?: string; position?: { referencePanel: string; direction: string; index?: number } }): MockPanel {
      const reference = options.position?.referencePanel ? this.getGroupPanel(options.position.referencePanel) : undefined;
      const group: MockGroup = options.position?.direction === "within" && reference
        ? reference.group
        : { id: `${options.id}-group`, panels: [], size: 0, api: { setConstraints: vi.fn() } };
      const visibilityListeners = new Set<(event: { isVisible: boolean }) => void>();
      const onDidVisibilityChange = (listener: (event: { isVisible: boolean }) => void) => {
        visibilityListeners.add(listener);
        return { dispose: () => { visibilityListeners.delete(listener); } };
      };
      const panel: MockPanel = {
        id: options.id,
        title: options.title ?? options.id,
        api: {
          setTitle: title => { panel.title = title; },
          setActive: () => panel.setActive(),
          getWindow: () => panel.getWindow(),
          get isVisible() { return panel.isVisible; },
          onDidVisibilityChange,
        },
        group,
        setActiveCalls: 0,
        windowFocusCalls: 0,
        setActive: () => { panel.setActiveCalls += 1; this.setActivePanel(panel); },
        getWindow: () => ({ focus: () => { panel.windowFocusCalls += 1; } }),
        get isVisible() { return panel.group.activePanel === panel; },
        onDidVisibilityChange,
        onDidLocationChange: () => ({ dispose() {} }),
        emitVisibility: () => { for (const listener of visibilityListeners) listener({ isVisible: panel.isVisible }); },
      };
      const insertAt = options.position?.direction === "within" && typeof options.position.index === "number"
        ? Math.max(0, Math.min(options.position.index, group.panels.length))
        : group.panels.length;
      group.panels.splice(insertAt, 0, panel);
      group.size = group.panels.length;
      group.activePanel ??= panel;
      group.headerActions ??= this.createRightHeaderActionComponent(group).element;
      this.panels.push(panel);
      const component = this.createComponent({ name: options.component });
      this.host.append(component.element);
      component.init({ api: panel, containerApi: this });
      this.activePanel ??= panel;
      return panel;
    }

    getGroupPanel(id: string): MockPanel | undefined {
      return this.panels.find(panel => panel.id === id);
    }

    getPanel(id: string): MockPanel | undefined {
      return this.getGroupPanel(id);
    }

    setActivePanel(panel: MockPanel): void {
      const previous = panel.group.activePanel;
      this.activePanel = panel;
      panel.group.activePanel = panel;
      if (previous !== panel) {
        previous?.emitVisibility();
        panel.emitVisibility();
      }
      for (const listener of this.activeListeners) listener(panel);
    }

    removePanel(panel: MockPanel): void {
      this.panels.splice(this.panels.indexOf(panel), 1);
      panel.group.panels.splice(panel.group.panels.indexOf(panel), 1);
      panel.group.size = panel.group.panels.length;
      if (panel.group.activePanel === panel) panel.group.activePanel = panel.group.panels[0];
      if (this.activePanel === panel) this.activePanel = this.panels[0];
      for (const listener of this.removeListeners) listener(panel);
    }

    focus(): void {}

    addPopoutGroup(item: MockPanel | MockGroup, options: unknown): Promise<boolean> {
      this.popoutCalls.push({ item, options });
      return Promise.resolve(true);
    }

    onDidRemovePanel(listener: (panel: MockPanel) => void): void { this.removeListeners.push(listener); }
    onDidActivePanelChange(listener: (panel: MockPanel) => void): void { this.activeListeners.push(listener); }
    onDidOpenPopoutWindowFail(): void {}
    onDidLayoutChange(): void {}
    onWillDrop(): void {}
    onDidDrop(): void {}

    toJSON(): object {
      return {};
    }

    fromJSON(): void {}
  }

  return { instances, MockDockviewComponent };
});

vi.mock("dockview-core", () => ({
  DockviewComponent: dockviewMock.MockDockviewComponent,
  themeDark: {},
}));

import { initDesktopDockview } from "./desktopDockview";


describe("initDesktopDockview", () => {
  beforeEach(() => {
    dockviewMock.instances.length = 0;
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  function initTestDockview(options: Partial<Parameters<typeof initDesktopDockview>[0]> & {
    onPanelVisibilityChanged?: (id: string, visible: boolean) => void;
    onWindowFocus?: (owner: Document) => void;
  } = {}) {
    const host = document.createElement("div");
    document.body.append(host);
    return initDesktopDockview({
      host,
      layoutMode: "normal",
      storageKey: "test.dockview.layout",
      onPanelReady: vi.fn(),
      onPanelActivated: vi.fn(),
      onPopoutBlocked: vi.fn(),
      ...options,
    });
  }

  it("pops out the active panel rather than its whole Dockview group", () => {
    const desktopDockview = initTestDockview();
    const dockview = dockviewMock.instances[0];
    const codePanel = dockview.panels.find(panel => panel.id === "code");
    const codeGroup = codePanel?.group;

    desktopDockview.activatePanel("code");
    codeGroup?.headerActions?.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    expect(dockview.popoutCalls).toHaveLength(1);
    expect(dockview.popoutCalls[0].item).toBe(codePanel);
    expect(dockview.popoutCalls[0].item).not.toBe(codeGroup);
  });

  it("activates and focuses a popped-out panel through its panel API", () => {
    const desktopDockview = initTestDockview();
    const dockview = dockviewMock.instances[0];
    const codePanel = dockview.panels.find(panel => panel.id === "code");
    expect(codePanel).toBeDefined();
    desktopDockview.activatePanel("code");
    codePanel?.group.headerActions?.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    const activated = desktopDockview.activatePanel("code");

    expect(activated).toBe(true);
    expect(codePanel?.setActiveCalls).toBe(2);
    expect(codePanel?.windowFocusCalls).toBe(2);
    expect(dockview.activePanel).toBe(codePanel);
  });

  it("adds Goal as a normal workspace panel without replacing Transcript", () => {
    initTestDockview();

    const dockview = dockviewMock.instances[0];
    const ids = dockview.panels.map(panel => panel.id);
    const transcript = dockview.panels.find(panel => panel.id === "transcript");
    const goal = dockview.panels.find(panel => panel.id === "goal");
    expect(ids).toContain("goal");
    expect(ids).toContain("diffs");
    expect(ids).not.toContain("sessionChanges");
    expect(ids).not.toContain("compare");
    expect(goal?.group).toBe(transcript?.group);
    expect(dockview.activePanel?.id).toBe("transcript");
  });

  it("uses a separate diff-review layout with a dedicated Diff panel", () => {
    initTestDockview({
      layoutMode: "diffReview",
      storageKey: "test.dockview.diffReview.layout",
    });

    const ids = dockviewMock.instances[0].panels.map(panel => panel.id);
    expect(ids).toContain("sessionChanges");
    expect(ids).toContain("transcript");
    expect(ids).toContain("code");
    expect(ids).toContain("tools");
    expect(ids).not.toContain("goal");
    expect(ids).not.toContain("diffs");
    expect(ids).not.toContain("compare");
  });

  it("opens and closes the lazy compare panel", () => {
    const desktopDockview = initTestDockview();

    expect(desktopDockview.ensureComparePanel()).toBe(true);
    expect(dockviewMock.instances[0].panels.some(panel => panel.id === "compare")).toBe(true);
    expect(desktopDockview.closePanel("compare")).toBe(true);
    expect(dockviewMock.instances[0].panels.some(panel => panel.id === "compare")).toBe(false);
  });

  it("distinguishes a visible inactive split from a mounted hidden tab", () => {
    const desktop = initTestDockview();
    // Optional access lets the regression compile before the adapter contract lands.
    const visible = desktop as typeof desktop & { isPanelVisible?: (id: "diffs" | "code") => boolean };
    desktop.activatePanel("diffs");
    desktop.activatePanel("transcript");
    expect(desktop.panelMounted("diffs")).toBe(true);
    expect(desktop.isPanelActive("diffs")).toBe(false);
    expect(visible.isPanelVisible?.("diffs")).toBe(true);
    expect(desktop.panelMounted("code")).toBe(true);
    expect(visible.isPanelVisible?.("code")).toBe(false);
    desktop.activatePanel("code");
    expect(visible.isPanelVisible?.("diffs")).toBe(true);
    expect(visible.isPanelVisible?.("code")).toBe(true);
    expect(desktop.isPanelActive("code")).toBe(true);
  });

  it("reports group-tab visibility changes without treating split refocus as hiding Diffs", async () => {
    const changes: Array<[string, boolean]> = [];
    const options = { onPanelVisibilityChanged: (id: string, visible: boolean) => { changes.push([id, visible]); } };
    const desktop = initTestDockview(options);
    await Promise.resolve();
    changes.length = 0;
    desktop.activatePanel("code");
    await Promise.resolve();
    expect(changes).toContainEqual(["transcript", false]);
    expect(changes).toContainEqual(["code", true]);
    changes.length = 0;
    desktop.activatePanel("diffs");
    await Promise.resolve();
    expect(changes).not.toContainEqual(["code", false]);
    desktop.activatePanel("code");
    await Promise.resolve();
    expect(changes).not.toContainEqual(["diffs", false]);
  });

  it("keeps the mounted Diffs consumer through popout transfer but removes it on close", () => {
    const closed = vi.fn();
    const desktop = initTestDockview({ onPanelClosed: closed });
    const dockview = dockviewMock.instances[0];
    const diffs = dockview.panels.find(panel => panel.id === "diffs")!;
    let before: HTMLElement | undefined;
    desktop.withPanel("diffs", element => { before = element; });
    desktop.activatePanel("diffs");
    diffs.group.headerActions!.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    expect(dockview.popoutCalls[0].item).toBe(diffs);
    desktop.withPanel("diffs", element => { expect(element).toBe(before); });
    expect(closed).not.toHaveBeenCalled();
    expect(desktop.closePanel("diffs")).toBe(true);
    expect(closed).toHaveBeenCalledWith("diffs");
    expect(desktop.panelMounted("diffs")).toBe(false);
    expect(desktop.withPanel("diffs", vi.fn())).toBe(false);
  });

  it("routes popout document focus to its owning workspace without an explicit second activation", () => {
    const activated = vi.fn();
    const focused = vi.fn();
    const options = { onPanelActivated: activated, onWindowFocus: focused };
    const desktop = initTestDockview(options);
    initTestDockview({ layoutMode: "diffReview", storageKey: "test.review", onPanelActivated: vi.fn() });
    desktop.activatePanel("diffs");
    const dockview = dockviewMock.instances[0];
    const diffs = dockview.panels.find(panel => panel.id === "diffs")!;
    diffs.group.headerActions!.querySelector<HTMLButtonElement>(".panel-popout-btn")!.click();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const popout = iframe.contentWindow!;
    const callbacks = dockview.popoutCalls[0].options as { onDidOpen(event: { window: Window }): void };
    callbacks.onDidOpen({ window: popout });
    activated.mockClear();
    focused.mockClear();
    popout.dispatchEvent(new Event("focus"));
    expect(focused).toHaveBeenCalledWith(popout.document);
    expect(activated.mock.calls.length).toBeLessThanOrEqual(1);
    iframe.remove();
  });
});
