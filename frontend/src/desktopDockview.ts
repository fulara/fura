import "dockview-core/dist/styles/dockview.css";
import { DockviewComponent, themeDark, type SerializedDockview } from "dockview-core";

export type DesktopDockviewPanelId = "sessionChanges" | "transcript" | "code" | "tools" | "diffs" | "compare";

export type DesktopDockview = {
  panelMounted(id: DesktopDockviewPanelId): boolean;
  panelContains(id: DesktopDockviewPanelId, element: Element): boolean;
  isPanelActive(id: DesktopDockviewPanelId): boolean;
  activatePanel(id: DesktopDockviewPanelId): boolean;
  withPanel(id: DesktopDockviewPanelId, render: (container: HTMLElement) => void): boolean;
  ensureSessionChangesPanel(): boolean;
  ensureDiffsPanel(): boolean;
  ensureComparePanel(): boolean;
  closePanel(id: "sessionChanges" | "diffs" | "compare"): boolean;
};

type DesktopDockviewOptions = {
  host: HTMLDivElement;
  onPanelReady(id: DesktopDockviewPanelId, container: HTMLElement): void;
  onPanelActivated(id: DesktopDockviewPanelId): void;
  onPanelClosed?(id: "sessionChanges" | "diffs" | "compare"): void;
  onPopoutBlocked(): void;
};

type PersistedDockviewLayout = {
  version: 1;
  layout: SerializedDockview;
};

type DesktopPanelShell = {
  element: HTMLDivElement;
  scroll: HTMLDivElement;
};

const DOCKVIEW_LAYOUT_STORAGE_KEY = "fura.dockview.layout";

export function initDesktopDockview(options: DesktopDockviewOptions): DesktopDockview {
  const panelEls: Partial<Record<DesktopDockviewPanelId, HTMLElement>> = {};
  const panelActivators: Partial<Record<DesktopDockviewPanelId, () => void>> = {};
  const owner = options.host.ownerDocument;
  const win = owner.defaultView ?? window;

  const api = new DockviewComponent(options.host, {
    theme: themeDark,
    createComponent(componentOptions) {
      const panelId = desktopPanelId(componentOptions.name);
      if (!panelId) {
        const element = owner.createElement("div");
        return { element, init() {} };
      }

      let popoutPanel: (() => void) | null = null;
      const shell = createDesktopPanelShell(owner, panelId, () => {
        popoutPanel?.();
      });

      return {
        element: shell.element,
        init(params) {
          popoutPanel = () => {
            const panel = params.containerApi.getPanel(panelId);
            if (!panel) return;
            void params.containerApi.addPopoutGroup(panel, {
              popoutUrl: "/popout.html",
              onDidOpen: ({ window: popWin }) => copyStylesToPopout(owner, popWin),
            });
          };
          panelActivators[panelId] = () => {
            params.api.setActive();
            params.api.getWindow().focus();
          };
          panelEls[panelId] = shell.scroll;
          options.onPanelReady(panelId, shell.scroll);
        },
      };
    },
  });

  api.onDidActivePanelChange(panel => {
    const panelId = panel ? desktopPanelId(panel.id) : null;
    if (panelId) options.onPanelActivated(panelId);
  });
  api.onDidOpenPopoutWindowFail(options.onPopoutBlocked);

  restoreOrCreateLayout(api, storage(win));
  ensureCodePanel(api);
  ensureDiffsPanel(api);

  let layoutSaveTimer: number | undefined;
  api.onDidLayoutChange(() => {
    win.clearTimeout(layoutSaveTimer);
    layoutSaveTimer = win.setTimeout(() => {
      const data: PersistedDockviewLayout = { version: 1, layout: api.toJSON() };
      storage(win).setItem(DOCKVIEW_LAYOUT_STORAGE_KEY, JSON.stringify(data));
    }, 300);
  });

  return {
    panelMounted(id) {
      return Boolean(panelEls[id]);
    },
    panelContains(id, element) {
      return Boolean(panelEls[id]?.contains(element));
    },
    isPanelActive(id) {
      return api.activePanel?.id === id;
    },
    activatePanel(id) {
      const activate = panelActivators[id];
      if (activate) {
        activate();
        return true;
      }

      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      api.setActivePanel(panel);
      api.focus();
      return true;
    },
    withPanel(id, render) {
      const panel = panelEls[id];
      if (!panel) return false;
      render(panel);
      return true;
    },
    ensureSessionChangesPanel() {
      return ensureSessionChangesPanel(api);
    },
    ensureDiffsPanel() {
      ensureDiffsPanel(api);
      return true;
    },
    ensureComparePanel() {
      return ensureComparePanel(api);
    },
    closePanel(id) {
      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      delete panelEls[id];
      delete panelActivators[id];
      api.removePanel(panel);
      options.onPanelClosed?.(id);
      return true;
    },
  };
}

export function createDesktopPanelShell(
  owner: Document,
  panelId: DesktopDockviewPanelId,
  onPopout: () => void,
): DesktopPanelShell {
  const element = owner.createElement("div");
  element.className = `panel-content panel-content-${panelId}`;

  const toolbar = createPanelToolbar(owner, onPopout);
  const scroll = owner.createElement("div");
  scroll.className = "panel-scroll";
  element.append(toolbar, scroll);
  return { element, scroll };
}

function createPanelToolbar(owner: Document, onPopout: () => void): HTMLElement {
  const toolbar = owner.createElement("div");
  toolbar.className = "panel-toolbar";

  const popoutBtn = owner.createElement("button");
  popoutBtn.type = "button";
  popoutBtn.className = "panel-popout-btn";
  popoutBtn.title = "Open panel in a separate window";
  popoutBtn.textContent = "Pop out";
  popoutBtn.addEventListener("click", onPopout);
  toolbar.append(popoutBtn);
  return toolbar;
}

function restoreOrCreateLayout(api: DockviewComponent, store: Storage): void {
  const stored = store.getItem(DOCKVIEW_LAYOUT_STORAGE_KEY);
  let layoutRestored = false;

  if (stored) {
    try {
      const data = JSON.parse(stored) as PersistedDockviewLayout;
      if (data.version === 1 && data.layout) {
        api.fromJSON(data.layout);
        layoutRestored = true;
      }
    } catch {
      // Corrupt or incompatible layout — fall through to default.
    }
  }

  if (!layoutRestored) loadDefaultLayout(api);
}

function loadDefaultLayout(api: DockviewComponent): void {
  api.addPanel({
    id: "transcript",
    component: "transcript",
    title: "Transcript",
    renderer: "always",
  });
  api.addPanel({
    id: "code",
    component: "code",
    title: "Code",
    position: { referencePanel: "transcript", direction: "within" },
    inactive: true,
    renderer: "always",
  });
  api.addPanel({
    id: "tools",
    component: "tools",
    title: "Tools",
    position: { referencePanel: "transcript", direction: "right" },
    renderer: "always",
  });
  api.addPanel({
    id: "diffs",
    component: "diffs",
    title: "Diffs",
    position: { referencePanel: "tools", direction: "below" },
    renderer: "always",
  });
}

function ensureCodePanel(api: DockviewComponent): void {
  const hasCodePanel = api.panels.some(panel => panel.id === "code");
  if (hasCodePanel) return;
  api.addPanel({
    id: "code",
    component: "code",
    title: "Code",
    position: { referencePanel: "transcript", direction: "within" },
    inactive: true,
    renderer: "always",
  });
}

function ensureDiffsPanel(api: DockviewComponent): void {
  const hasDiffsPanel = api.panels.some(panel => panel.id === "diffs");
  if (hasDiffsPanel) return;
  api.addPanel({
    id: "diffs",
    component: "diffs",
    title: "Diffs",
    position: { referencePanel: "tools", direction: "below" },
    renderer: "always",
  });
}

function ensureSessionChangesPanel(api: DockviewComponent): boolean {
  const hasSessionChangesPanel = api.panels.some(panel => panel.id === "sessionChanges");
  if (hasSessionChangesPanel) return false;
  api.addPanel({
    id: "sessionChanges",
    component: "sessionChanges",
    title: "Diff",
    position: { referencePanel: "transcript", direction: "within", index: 0 },
    renderer: "always",
  });
  return true;
}

function ensureComparePanel(api: DockviewComponent): boolean {
  const hasComparePanel = api.panels.some(panel => panel.id === "compare");
  if (hasComparePanel) return false;
  api.addPanel({
    id: "compare",
    component: "compare",
    title: "Compare",
    position: { referencePanel: "diffs", direction: "within" },
    renderer: "always",
  });
  return true;
}

function desktopPanelId(name: string): DesktopDockviewPanelId | null {
  return name === "sessionChanges" || name === "transcript" || name === "code" || name === "tools" || name === "diffs" || name === "compare" ? name : null;
}

function copyStylesToPopout(owner: Document, popWin: Window): void {
  const head = popWin.document.head;
  if (!head) return;
  owner.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
    head.appendChild(popWin.document.importNode(node, true));
  });
}

function storage(win: Window): Storage {
  return win.localStorage;
}
