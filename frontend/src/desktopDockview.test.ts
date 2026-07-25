import { beforeEach, describe, expect, it, vi } from "vitest";

type MockPanel = {
  id: string;
  group: MockGroup;
  title: string;
  api: { setTitle(title: string): void };
  setActiveCalls: number;
  windowFocusCalls: number;
  setActive(): void;
  getWindow(): { focus(): void };
};
type MockGroup = { id: string; panels: MockPanel[]; size: number };

type MockDockviewInstance = {
  panels: MockPanel[];
  activePanel: MockPanel | undefined;
  popoutCalls: Array<{ item: MockPanel | MockGroup; options: unknown }>;
};

const dockviewMock = vi.hoisted(() => {
  const instances: MockDockviewInstance[] = [];

  class MockDockviewComponent {
    readonly panels: MockPanel[] = [];
    activePanel: MockPanel | undefined;
    private readonly removeListeners: Array<(panel: MockPanel) => void> = [];
    readonly popoutCalls: Array<{ item: MockPanel | MockGroup; options: unknown }> = [];
    private readonly createComponent: (options: { name: string }) => {
      element: HTMLElement;
      init(params: { api: MockPanel; containerApi: MockDockviewComponent }): void;
    };

    constructor(_host: HTMLElement, options: { createComponent: MockDockviewComponent["createComponent"] }) {
      this.createComponent = options.createComponent;
      instances.push(this);
    }

    addPanel(options: { id: string; component: string; title?: string; position?: { referencePanel: string; direction: string; index?: number } }): MockPanel {
      const reference = options.position?.referencePanel ? this.getGroupPanel(options.position.referencePanel) : undefined;
      const group: MockGroup = options.position?.direction === "within" && reference
        ? reference.group
        : { id: `${options.id}-group`, panels: [], size: 0 };
      const panel: MockPanel = {
        id: options.id,
        title: options.title ?? options.id,
        api: { setTitle: title => { panel.title = title; } },
        group,
        setActiveCalls: 0,
        windowFocusCalls: 0,
        setActive: () => { panel.setActiveCalls += 1; this.activePanel = panel; },
        getWindow: () => ({ focus: () => { panel.windowFocusCalls += 1; } }),
      };
      const insertAt = options.position?.direction === "within" && typeof options.position.index === "number"
        ? Math.max(0, Math.min(options.position.index, group.panels.length))
        : group.panels.length;
      group.panels.splice(insertAt, 0, panel);
      group.size = group.panels.length;
      this.panels.push(panel);
      this.createComponent({ name: options.component }).init({ api: panel, containerApi: this });
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
      this.activePanel = panel;
    }

    removePanel(panel: MockPanel): void {
      this.panels.splice(this.panels.indexOf(panel), 1);
      panel.group.panels.splice(panel.group.panels.indexOf(panel), 1);
      panel.group.size = panel.group.panels.length;
      if (this.activePanel === panel) this.activePanel = this.panels[0];
      for (const listener of this.removeListeners) listener(panel);
    }

    focus(): void {}

    addPopoutGroup(item: MockPanel | MockGroup, options: unknown): Promise<boolean> {
      this.popoutCalls.push({ item, options });
      return Promise.resolve(true);
    }

    onDidRemovePanel(listener: (panel: MockPanel) => void): void { this.removeListeners.push(listener); }
    onDidActivePanelChange(): void {}
    onDidOpenPopoutWindowFail(): void {}
    onDidLayoutChange(): void {}

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

import { createDesktopPanelShell, initDesktopDockview } from "./desktopDockview";

describe("createDesktopPanelShell", () => {
  it("creates a desktop panel content shell with toolbar and scroll container", () => {
    const onPopout = vi.fn();

    const shell = createDesktopPanelShell(document, "transcript", onPopout);

    expect(shell.element.className).toBe("panel-content panel-content-transcript");
    expect(shell.scroll.className).toBe("panel-scroll");
    expect(shell.element.firstElementChild?.className).toBe("panel-toolbar");
    expect(shell.element.lastElementChild).toBe(shell.scroll);
  });

  it("wires the popout button to the provided callback", () => {
    const onPopout = vi.fn();
    const shell = createDesktopPanelShell(document, "tools", onPopout);

    shell.element.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    expect(onPopout).toHaveBeenCalledOnce();
    expect(shell.element.querySelector(".panel-popout-btn")?.textContent).toBe("Pop out");
  });
});

describe("initDesktopDockview", () => {
  beforeEach(() => {
    dockviewMock.instances.length = 0;
    window.localStorage.clear();
  });

  function initTestDockview(options: Partial<Parameters<typeof initDesktopDockview>[0]> = {}) {
    return initDesktopDockview({
      host: document.createElement("div") as HTMLDivElement,
      layoutMode: "normal",
      storageKey: "test.dockview.layout",
      onPanelReady: vi.fn(),
      onPanelActivated: vi.fn(),
      onPopoutBlocked: vi.fn(),
      ...options,
    });
  }

  it("pops out the clicked panel rather than its whole Dockview group", () => {
    const readyContainers = new Map<string, HTMLElement>();
    initTestDockview({
      onPanelReady: (id, container) => readyContainers.set(id, container),
    });
    const dockview = dockviewMock.instances[0];
    const codePanel = dockview.panels.find(panel => panel.id === "code");
    const codeGroup = codePanel?.group;

    readyContainers.get("code")?.parentElement?.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    expect(dockview.popoutCalls).toHaveLength(1);
    expect(dockview.popoutCalls[0].item).toBe(codePanel);
    expect(dockview.popoutCalls[0].item).not.toBe(codeGroup);
  });

  it("activates and focuses a popped-out panel through its panel API", () => {
    const readyContainers = new Map<string, HTMLElement>();
    const desktopDockview = initTestDockview({
      onPanelReady: (id, container) => readyContainers.set(id, container),
    });
    const dockview = dockviewMock.instances[0];
    const codePanel = dockview.panels.find(panel => panel.id === "code");
    expect(codePanel).toBeDefined();
    readyContainers.get("code")?.parentElement?.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    const activated = desktopDockview.activatePanel("code");

    expect(activated).toBe(true);
    expect(codePanel?.setActiveCalls).toBe(1);
    expect(codePanel?.windowFocusCalls).toBe(1);
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

  it("manages BTW tabs as ephemeral panels in the transcript group", () => {
    const readyContainers = new Map<string, HTMLElement>();
    const onPanelClosed = vi.fn();
    const desktopDockview = initTestDockview({
      onPanelReady: (id, container) => readyContainers.set(id, container),
      onPanelClosed,
    });
    const dockview = dockviewMock.instances[0];
    const transcript = dockview.panels.find(panel => panel.id === "transcript");

    expect(desktopDockview.openEphemeralPanel("btw:request-1", "BTW · 12:34")).toBe(true);
    const btw = dockview.panels.find(panel => panel.id === "btw:request-1");
    expect(btw?.group).toBe(transcript?.group);
    expect(dockview.activePanel).toBe(btw);
    expect(readyContainers.get("btw:request-1")?.parentElement?.querySelector(".panel-toolbar")).toBeNull();

    expect(desktopDockview.setPanelTitle("btw:request-1", "BTW · Why this change?")).toBe(true);
    expect(btw?.title).toBe("BTW · Why this change?");
    expect(desktopDockview.closeEphemeralPanel("btw:request-1")).toBe(true);
    expect(dockview.panels.some(panel => panel.id === "btw:request-1")).toBe(false);
    expect(onPanelClosed).toHaveBeenCalledWith("btw:request-1");
  });
});
