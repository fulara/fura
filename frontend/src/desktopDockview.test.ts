import { beforeEach, describe, expect, it, vi } from "vitest";

type MockPanel = {
  id: string;
  group: MockGroup;
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
    readonly popoutCalls: Array<{ item: MockPanel | MockGroup; options: unknown }> = [];
    private readonly createComponent: (options: { name: string }) => {
      element: HTMLElement;
      init(params: { api: MockPanel; containerApi: MockDockviewComponent }): void;
    };

    constructor(_host: HTMLElement, options: { createComponent: MockDockviewComponent["createComponent"] }) {
      this.createComponent = options.createComponent;
      instances.push(this);
    }

    addPanel(options: { id: string; component: string }): MockPanel {
      const group: MockGroup = { id: `${options.id}-group`, panels: [], size: 0 };
      const panel: MockPanel = {
        id: options.id,
        group,
        setActiveCalls: 0,
        windowFocusCalls: 0,
        setActive: () => { panel.setActiveCalls += 1; this.activePanel = panel; },
        getWindow: () => ({ focus: () => { panel.windowFocusCalls += 1; } }),
      };
      group.panels.push(panel);
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

    focus(): void {}

    addPopoutGroup(item: MockPanel | MockGroup, options: unknown): Promise<boolean> {
      this.popoutCalls.push({ item, options });
      return Promise.resolve(true);
    }

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

  it("pops out the clicked panel rather than its whole Dockview group", () => {
    const host = document.createElement("div") as HTMLDivElement;
    const readyContainers = new Map<string, HTMLElement>();
    initDesktopDockview({
      host,
      onPanelReady: (id, container) => readyContainers.set(id, container),
      onPanelActivated: vi.fn(),
      onPopoutBlocked: vi.fn(),
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
    const host = document.createElement("div") as HTMLDivElement;
    const readyContainers = new Map<string, HTMLElement>();
    const desktopDockview = initDesktopDockview({
      host,
      onPanelReady: (id, container) => readyContainers.set(id, container),
      onPanelActivated: vi.fn(),
      onPopoutBlocked: vi.fn(),
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
});
