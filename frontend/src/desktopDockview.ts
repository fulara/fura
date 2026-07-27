import "dockview-core/dist/styles/dockview.css";
import { DockviewComponent, themeDark, type SerializedDockview } from "dockview-core";

export type DesktopStaticPanelId = "sessionChanges" | "transcript" | "goal" | "code" | "tools" | "diffs" | "compare";
export type DesktopEphemeralPanelId = `btw:${string}`;
export type DesktopDockviewPanelId = DesktopStaticPanelId | DesktopEphemeralPanelId;

export type DesktopDockviewLayoutMode = "normal" | "diffReview";

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
  openEphemeralPanel(id: DesktopEphemeralPanelId, title: string): boolean;
  setPanelTitle(id: DesktopEphemeralPanelId, title: string): boolean;
  closeEphemeralPanel(id: DesktopEphemeralPanelId): boolean;
};

type DesktopDockviewOptions = {
  host: HTMLDivElement;
  layoutMode: DesktopDockviewLayoutMode;
  storageKey: string;
  onPanelReady(id: DesktopDockviewPanelId, container: HTMLElement): void;
  onPanelActivated(id: DesktopDockviewPanelId): void;
  onPanelClosed?(id: DesktopDockviewPanelId): void;
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

      const ephemeral = isBtwPanelId(panelId);
      let popoutPanel: (() => void) | null = null;
      const shell = createDesktopPanelShell(owner, panelId, () => {
        popoutPanel?.();
      }, !ephemeral);

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
  api.onDidRemovePanel(panel => {
    const panelId = desktopPanelId(panel.id);
    if (!panelId) return;
    delete panelEls[panelId];
    delete panelActivators[panelId];
    options.onPanelClosed?.(panelId);
  });

  restoreOrCreateLayout(api, storage(win), options.storageKey, options.layoutMode);
  ensureRequiredPanels(api, options.layoutMode);

  let layoutSaveTimer: number | undefined;
  api.onDidLayoutChange(() => {
    win.clearTimeout(layoutSaveTimer);
    layoutSaveTimer = win.setTimeout(() => {
      if (api.panels.some(panel => isBtwPanelId(panel.id))) return;
      const data: PersistedDockviewLayout = { version: 1, layout: api.toJSON() };
      storage(win).setItem(options.storageKey, JSON.stringify(data));
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
      api.removePanel(panel);
      return true;
    },
    openEphemeralPanel(id, title) {
      if (api.getGroupPanel(id)) {
        return this.activatePanel(id);
      }
      api.addPanel({
        id,
        component: id,
        title,
        position: { referencePanel: "transcript", direction: "within" },
        renderer: "always",
      });
      return this.activatePanel(id);
    },
    setPanelTitle(id, title) {
      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      panel.api.setTitle(title);
      return true;
    },
    closeEphemeralPanel(id) {
      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      api.removePanel(panel);
      return true;
    },
  };
}

export function createDesktopPanelShell(
  owner: Document,
  panelId: DesktopDockviewPanelId,
  onPopout: () => void,
  showPopout = true,
): DesktopPanelShell {
  const element = owner.createElement("div");
  element.className = `panel-content panel-content-${panelId}`;

  const toolbar = showPopout ? createPanelToolbar(owner, onPopout) : null;
  const scroll = owner.createElement("div");
  scroll.className = "panel-scroll";
  if (toolbar) element.append(toolbar);
  element.append(scroll);
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

function restoreOrCreateLayout(
  api: DockviewComponent,
  store: Storage,
  storageKey: string,
  layoutMode: DesktopDockviewLayoutMode,
): void {
  const stored = store.getItem(storageKey);
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

  if (!layoutRestored) loadDefaultLayout(api, layoutMode);
}

function loadDefaultLayout(api: DockviewComponent, layoutMode: DesktopDockviewLayoutMode): void {
  if (layoutMode === "diffReview") {
    api.addPanel({
      id: "sessionChanges",
      component: "sessionChanges",
      title: "Diff",
      renderer: "always",
    });
    api.addPanel({
      id: "transcript",
      component: "transcript",
      title: "Transcript",
      position: { referencePanel: "sessionChanges", direction: "right" },
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
      position: { referencePanel: "transcript", direction: "below" },
      renderer: "always",
    });
    return;
  }

  api.addPanel({
    id: "transcript",
    component: "transcript",
    title: "Transcript",
    renderer: "always",
  });
  api.addPanel({
    id: "goal",
    component: "goal",
    title: "Goal",
    position: { referencePanel: "transcript", direction: "within" },
    inactive: true,
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

function ensureRequiredPanels(api: DockviewComponent, layoutMode: DesktopDockviewLayoutMode): void {
  ensureTranscriptPanel(api);
  if (layoutMode === "normal") ensureGoalPanel(api);
  ensureCodePanel(api);
  ensureToolsPanel(api);
  if (layoutMode === "diffReview") {
    removePanelIfPresent(api, "diffs");
    removePanelIfPresent(api, "compare");
    ensureSessionChangesPanel(api);
  } else {
    removePanelIfPresent(api, "sessionChanges");
    ensureDiffsPanel(api);
  }
}

function removePanelIfPresent(api: DockviewComponent, id: "sessionChanges" | "diffs" | "compare"): void {
  const panel = api.getGroupPanel(id);
  if (panel) api.removePanel(panel);
}

function ensureTranscriptPanel(api: DockviewComponent): void {
  const hasTranscriptPanel = api.panels.some(panel => panel.id === "transcript");
  if (hasTranscriptPanel) return;
  api.addPanel({
    id: "transcript",
    component: "transcript",
    title: "Transcript",
    renderer: "always",
  });
}

function ensureToolsPanel(api: DockviewComponent): void {
  const hasToolsPanel = api.panels.some(panel => panel.id === "tools");
  if (hasToolsPanel) return;
  api.addPanel({
    id: "tools",
    component: "tools",
    title: "Tools",
    position: { referencePanel: "transcript", direction: "right" },
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

function ensureGoalPanel(api: DockviewComponent): void {
  const hasGoalPanel = api.panels.some(panel => panel.id === "goal");
  if (hasGoalPanel) return;
  api.addPanel({
    id: "goal",
    component: "goal",
    title: "Goal",
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
    position: { referencePanel: "transcript", direction: "left" },
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
  return name === "sessionChanges" || name === "transcript" || name === "goal" || name === "code" || name === "tools" || name === "diffs" || name === "compare" || isBtwPanelId(name) ? name : null;
}

function isBtwPanelId(name: string): name is DesktopEphemeralPanelId {
  return name.startsWith("btw:") && name.length > 4;
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
