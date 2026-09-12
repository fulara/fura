import "dockview-core/dist/styles/dockview.css";
import { DockviewComponent, themeDark, type SerializedDockview } from "dockview-core";
import { captureDiffViewScroll, restoreDiffViewScroll } from "./diffViewDom";

export type DesktopDockviewPanelId = "sessionChanges" | "transcript" | "goal" | "code" | "tools" | "diffs" | "compare";

export type DesktopDockviewLayoutMode = "normal" | "diffReview";

export type DesktopDockview = {
  panelMounted(id: DesktopDockviewPanelId): boolean;
  panelContains(id: DesktopDockviewPanelId, element: Element): boolean;
  isPanelActive(id: DesktopDockviewPanelId): boolean;
  isPanelVisible(id: DesktopDockviewPanelId): boolean;
  activatePanel(id: DesktopDockviewPanelId): boolean;
  setPanelExpanded(id: DesktopDockviewPanelId, expanded: boolean): void;
  isPanelExpanded(id: DesktopDockviewPanelId): boolean;
  withPanel(id: DesktopDockviewPanelId, render: (container: HTMLElement) => void): boolean;
  ensureSessionChangesPanel(): boolean;
  ensureDiffsPanel(): boolean;
  ensureComparePanel(): boolean;
  closePanel(id: "sessionChanges" | "diffs" | "compare"): boolean;
};

type DesktopDockviewOptions = {
  host: HTMLDivElement;
  layoutMode: DesktopDockviewLayoutMode;
  storageKey: string;
  onPanelReady(id: DesktopDockviewPanelId, container: HTMLElement): void;
  onPanelActivated(id: DesktopDockviewPanelId): void;
  onPanelClosed?(id: DesktopDockviewPanelId): void;
  onPanelVisibilityChanged?(id: DesktopDockviewPanelId, visible: boolean): void;
  onWindowFocus?(owner: Document): void;
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
  const visiblePanels = new Set<DesktopDockviewPanelId>();
  const watchedDocuments = new WeakSet<Document>();
  const pendingScrollRestores = new Map<DesktopDockviewPanelId, () => void>();
  let visibilityQueued = false;

  function workspaceVisible(): boolean {
    return !options.host.classList.contains("workspace-panel-host")
      || options.host.classList.contains("workspace-panel-host-active");
  }

  function panelSelected(id: DesktopDockviewPanelId): boolean {
    return workspaceVisible() && Boolean(api.getGroupPanel(id)?.api.isVisible);
  }

  function notifyVisibility(): void {
    if (visibilityQueued) return;
    visibilityQueued = true;
    queueMicrotask(() => {
      visibilityQueued = false;
      // Dockview temporarily hides/removes a moving panel. Observe the settled
      // group selection, not those intermediate transfer states or OS focus.
      for (const id of Object.keys(panelEls) as DesktopDockviewPanelId[]) {
        const element = panelEls[id];
        if (element) element.style.visibility = element.ownerDocument !== owner && !workspaceVisible() ? "hidden" : "";
        const visible = panelSelected(id);
        if (visiblePanels.has(id) === visible) continue;
        if (visible) visiblePanels.add(id);
        else visiblePanels.delete(id);
        options.onPanelVisibilityChanged?.(id, visible);
      }
    });
  }

  function watchPopout(popWin: Window): void {
    const doc = popWin.document;
    if (doc === owner || watchedDocuments.has(doc)) return;
    watchedDocuments.add(doc);
    const refresh = () => {
      if (popWin.closed || popWin.document !== doc || doc.visibilityState === "hidden") return;
      options.onWindowFocus?.(doc);
    };
    popWin.addEventListener("focus", () => {
      const selected = api.panels.find(panel => panel.api.getWindow() === popWin && panel.api.isVisible);
      selected?.api.setActive();
      refresh();
    });
    doc.addEventListener("visibilitychange", refresh);
    popWin.addEventListener("beforeunload", () => {
      const restores = api.panels.filter(panel => panel.api.getWindow() === popWin)
        .map(panel => desktopPanelId(panel.id))
        .filter((id): id is DesktopDockviewPanelId => id !== null)
        .map(preserveTransferScroll);
      // Capture precedes Dockview's close listener; the main document's next
      // layout runs after native dispatch and the synchronous redock.
      win.requestAnimationFrame(() => { for (const restore of restores) restore(); });
    }, { capture: true });
  }

  function preserveTransferScroll(id: DesktopDockviewPanelId): () => void {
    const container = panelEls[id];
    const snapshot = container && captureDiffViewScroll(container);
    return () => {
      if (!container || !snapshot) return;
      pendingScrollRestores.get(id)?.();
      const view = container.ownerDocument.defaultView;
      if (!view) return;
      const observer = new view.ResizeObserver(restore);
      const stop = () => {
        observer.disconnect();
        view.cancelAnimationFrame(frame);
        pendingScrollRestores.delete(id);
      };
      function restore(): void {
        const root = container!.querySelector<HTMLElement>(".diffs-view, .compare-view");
        if (panelEls[id] !== container || !root || root.dataset.reviewTarget !== snapshot!.target) {
          stop();
          return;
        }
        const rect = root.getBoundingClientRect();
        if (!root.isConnected || rect.width <= 0 || rect.height <= 0) return;
        restoreDiffViewScroll(container!, snapshot!);
        stop();
      }
      const frame = view.requestAnimationFrame(restore);
      pendingScrollRestores.set(id, stop);
      observer.observe(container);
    };
  }

  const api = new DockviewComponent(options.host, {
    theme: themeDark,
    createRightHeaderActionComponent(group) {
      const element = createPanelToolbar(owner, () => {
        const panel = group.activePanel && api.getGroupPanel(group.activePanel.id);
        const panelId = panel && desktopPanelId(panel.id);
        if (!panel || !panelId) return;
        let restoreScroll = preserveTransferScroll(panelId);
        void api.api.addPopoutGroup(panel, {
          popoutUrl: "/popout.html",
          onDidOpen: ({ window: popWin }) => {
            copyStylesToPopout(owner, popWin);
            watchPopout(popWin);
            popWin.addEventListener("load", () => {
              restoreScroll = preserveTransferScroll(panelId);
              watchPopout(popWin);
            }, { once: true });
          },
        }).then(opened => {
          if (opened) restoreScroll();
          notifyVisibility();
        });
      });
      return { element, init() {}, dispose() {} };
    },
    createComponent(componentOptions) {
      const panelId = desktopPanelId(componentOptions.name);
      if (!panelId) {
        const element = owner.createElement("div");
        return { element, init() {} };
      }

      const shell = createDesktopPanelShell(owner, panelId);

      return {
        element: shell.element,
        init(params) {
          if (panelId === "diffs" || panelId === "sessionChanges" || panelId === "compare") {
            params.api.group.api.setConstraints({ minimumWidth: 560 });
          }
          panelActivators[panelId] = () => {
            params.api.setActive();
            params.api.getWindow().focus();
          };
          panelEls[panelId] = shell.scroll;
          params.api.onDidVisibilityChange(notifyVisibility);
          params.api.onDidLocationChange(() => {
            watchPopout(params.api.getWindow());
            notifyVisibility();
          });
          options.onPanelReady(panelId, shell.scroll);
        },
      };
    },
  });

  api.onDidActivePanelChange(panel => {
    const panelId = panel ? desktopPanelId(panel.id) : null;
    if (panelId) options.onPanelActivated(panelId);
    notifyVisibility();
  });
  api.onDidOpenPopoutWindowFail(options.onPopoutBlocked);
  api.onDidRemovePanel(panel => {
    const panelId = desktopPanelId(panel.id);
    if (!panelId) return;
    delete panelEls[panelId];
    delete panelActivators[panelId];
    visiblePanels.delete(panelId);
    pendingScrollRestores.get(panelId)?.();
    options.onPanelClosed?.(panelId);
  });

  restoreOrCreateLayout(api, storage(win), options.storageKey, options.layoutMode);
  ensureRequiredPanels(api, options.layoutMode);
  notifyVisibility();
  new MutationObserver(notifyVisibility).observe(options.host, { attributes: true, attributeFilter: ["class"] });
  api.onWillDrop(() => {
    const restores = (Object.keys(panelEls) as DesktopDockviewPanelId[]).map(preserveTransferScroll);
    // Internal drops do not emit onDidDrop. Their synchronous move is complete
    // when this stack unwinds; each restore then waits for destination layout.
    queueMicrotask(() => { for (const restore of restores) restore(); });
  });

  let layoutSaveTimer: number | undefined;
  api.onDidLayoutChange(() => {
    win.clearTimeout(layoutSaveTimer);
    layoutSaveTimer = win.setTimeout(() => {
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
    isPanelVisible(id) {
      const element = panelEls[id];
      return panelSelected(id) && Boolean(element?.isConnected && element.ownerDocument.visibilityState !== "hidden");
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
    setPanelExpanded(id, expanded) {
      const panel = api.getGroupPanel(id);
      if (!panel) return;
      if (expanded) api.maximizeGroup(panel.group);
      else api.exitMaximizedGroup();
    },
    isPanelExpanded(id) {
      const panel = api.getGroupPanel(id);
      return Boolean(panel && api.isMaximizedGroup(panel.group));
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
  };
}

function createDesktopPanelShell(
  owner: Document,
  panelId: DesktopDockviewPanelId,
): DesktopPanelShell {
  const element = owner.createElement("div");
  element.className = `panel-content panel-content-${panelId}`;

  const scroll = owner.createElement("div");
  scroll.className = "panel-scroll";
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
    title: "Git changes",
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
    title: "Git changes",
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
  return name === "sessionChanges" || name === "transcript" || name === "goal" || name === "code" || name === "tools" || name === "diffs" || name === "compare" ? name : null;
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
