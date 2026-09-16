import "dockview-core/dist/styles/dockview.css";
import { DockviewComponent, themeDark } from "dockview-core";
import type { DockviewGroupPanel, IDockviewPanel, SerializedDockview } from "dockview-core";
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

type PanelReturnLocation = { group: DockviewGroupPanel; order: string[] };


export function initDesktopDockview(options: DesktopDockviewOptions): DesktopDockview {
  const panelEls: Partial<Record<DesktopDockviewPanelId, HTMLElement>> = {};
  const panelActivators: Partial<Record<DesktopDockviewPanelId, () => void>> = {};
  const owner = options.host.ownerDocument;
  const win = owner.defaultView ?? window;
  const visiblePanels = new Set<DesktopDockviewPanelId>();
  const watchedDocuments = new WeakSet<Document>();
  const pendingScrollRestores = new Map<DesktopDockviewPanelId, () => void>();
  let visibilityQueued = false;
  let shuttingDown = false;
  let layoutSaveTimer: number | undefined;
  const returnLocations = new WeakMap<IDockviewPanel, PanelReturnLocation>();
  const guardedGroups = new WeakSet<DockviewGroupPanel>();
  win.addEventListener("beforeunload", () => {
    if (api.isDisposed || shuttingDown) return;
    shuttingDown = true;
    win.clearTimeout(layoutSaveTimer);
    // Save return positions before Dockview closes its windows. Do not move
    // content or reopen anything while the owning application is shutting down.
    const data: PersistedDockviewLayout = {
      version: 1,
      layout: dockedLayout(api.toJSON(), id => returnLocations.get(api.getGroupPanel(id)!)),
    };
    storage(win).setItem(options.storageKey, JSON.stringify(data));
  }, { capture: true });

  function mainGroup(group: DockviewGroupPanel): boolean {
    return api.groups.includes(group) && group.api.location.type !== "popout";
  }

  function returnPanels(panels: IDockviewPanel[]): void {
    if (shuttingDown || api.isDisposed) return;
    const locations = panels.map(panel => ({ panel, origin: returnLocations.get(panel) }));
    const selected = panels.filter(panel => panel.api.isVisible);
    for (const { panel, origin } of locations) {
      if (api.getGroupPanel(panel.id) !== panel) continue;
      const target = origin && mainGroup(origin.group) ? origin.group
        : mainGroup(panel.group) ? panel.group
        : api.groups.find(group => group.api.location.type === "grid") ?? api.addGroup();
      // A popup can collect tabs detached at different times. Use the fullest
      // original ordering so later departures do not erase earlier tab slots.
      const order = locations.filter(entry => entry.origin?.group === origin?.group)
        .reduce((best, entry) => (entry.origin?.order.length ?? 0) > best.length ? entry.origin!.order : best, origin?.order ?? []);
      const originalIndex = order.indexOf(panel.id);
      const next = order.slice(originalIndex + 1).find(id => target.panels.some(candidate => candidate.id === id));
      const previous = order.slice(0, originalIndex).reverse().find(id => target.panels.some(candidate => candidate.id === id));
      const remaining = target.panels.filter(candidate => candidate !== panel);
      const index = next ? remaining.findIndex(candidate => candidate.id === next)
        : previous ? remaining.findIndex(candidate => candidate.id === previous) + 1
        : Math.min(Math.max(originalIndex, 0), remaining.length);
      if (panel.group !== target || target.panels.indexOf(panel) !== index) {
        panel.api.moveTo({ group: target, index, skipSetActive: true });
      }
      if (!target.api.isVisible) target.api.setVisible(true);
    }
    for (const panel of selected) {
      if (api.getGroupPanel(panel.id) === panel) panel.group.model.openPanel(panel, { skipSetGroupActive: true });
    }
    notifyVisibility();
  }

  function closePanelFromUser(panel: IDockviewPanel): void {
    if (shuttingDown || panel.api.location.type !== "popout") return;
    if (panel.group.size === 1) {
      panel.api.getWindow().close();
    } else {
      const restore = preserveTransferScroll(desktopPanelId(panel.id)!);
      returnPanels([panel]);
      restore();
    }
  }

  function guardGroup(group: DockviewGroupPanel): void {
    if (guardedGroups.has(group)) return;
    guardedGroups.add(group);
    let order = group.panels.map(panel => panel.id);
    // Dockview 5.2 has no cancellable close event. Adapt only user-close
    // entry points; removePanel/removeGroup remain available to transfers,
    // layout restoration and intentional application teardown.
    const close = () => {
      if (!shuttingDown && group.api.location.type === "popout") group.api.getWindow().close();
    };
    group.api.close = close;
    group.model.closeAllPanels = close;
    group.model.closePanel = closePanelFromUser;
    group.addDisposables(
      group.model.onDidAddPanel(() => { order = group.panels.map(panel => panel.id); }),
      group.model.onDidRemovePanel(({ panel }) => {
        if (group.api.location.type !== "popout") returnLocations.set(panel, { group, order });
        order = group.panels.map(candidate => candidate.id);
      }),
    );
  }

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
      // The initial about:blank window can retain its listener after navigation.
      // Only the loaded document may schedule a return correction.
      if (shuttingDown || api.isDisposed || popWin.document !== doc) return;
      const panels = api.panels.filter(panel => panel.api.getWindow() === popWin);
      const restores = panels
        .map(panel => desktopPanelId(panel.id))
        .filter((id): id is DesktopDockviewPanelId => id !== null)
        .map(preserveTransferScroll);
      // Native close transfers synchronously without disposing content. Correct
      // only its destination/order afterwards, never recreate removed panels.
      queueMicrotask(() => {
        if (shuttingDown || api.isDisposed) return;
        returnPanels(panels);
        for (const restore of restores) restore();
      });
    }, { capture: true });
  }

  function preserveTransferScroll(id: DesktopDockviewPanelId): () => void {
    const container = panelEls[id];
    const snapshot = container && captureDiffViewScroll(container);
    const focused = container?.ownerDocument.activeElement;
    const scroll = container ? [container, ...container.querySelectorAll<HTMLElement>("*")]
      .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })) : [];
    return () => {
      if (shuttingDown || !container || panelEls[id] !== container) return;
      for (const { element, top, left } of scroll) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
      if (workspaceVisible() && focused && container.contains(focused)) {
        (focused as HTMLElement).focus({ preventScroll: true });
      }
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
    defaultTabComponent: "workspace",
    createTabComponent() {
      const element = owner.createElement("div");
      element.className = "dv-default-tab";
      const title = owner.createElement("div");
      title.className = "dv-default-tab-content";
      element.append(title);
      let listener: { dispose(): void } | undefined;
      return {
        element,
        init(params) {
          title.textContent = params.title;
          listener = params.api.onDidTitleChange(event => { title.textContent = event.title; });
        },
        dispose() { listener?.dispose(); },
      };
    },
    createRightHeaderActionComponent(group) {
      guardGroup(group);
      const element = createPanelToolbar(owner, () => {
        if (group.api.location.type === "popout") {
          group.api.getWindow().close();
          return;
        }
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
      const button = element.querySelector<HTMLButtonElement>("button")!;
      const update = () => {
        const returning = group.api.location.type === "popout";
        button.className = returning ? "panel-return-btn" : "panel-popout-btn";
        button.textContent = returning ? "Return to main" : "Pop out";
        button.title = returning ? "Return to main" : "Open panel in a separate window";
      };
      const listener = group.api.onDidLocationChange(update);
      update();
      return { element, init() {}, dispose() { listener.dispose(); } };
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

  api.onDidLayoutChange(() => {
    if (shuttingDown || api.isDisposed) return;
    win.clearTimeout(layoutSaveTimer);
    layoutSaveTimer = win.setTimeout(() => {
      if (shuttingDown || api.isDisposed) return;
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

function dockedLayout(
  layout: SerializedDockview,
  originFor?: (id: string) => PanelReturnLocation | undefined,
): SerializedDockview {
  const popouts = layout.popoutGroups ?? [];
  if (popouts.length === 0) return layout;
  type Node = SerializedDockview["grid"]["root"];
  type Group = Exclude<Node["data"], Node[]>;
  type Target = { group: Group; node?: Node };
  const groups = new Map<string, Target>();
  const orders = new Map<Group, string[]>();
  function visit(node: Node): void {
    if (Array.isArray(node.data)) node.data.forEach(visit);
    else groups.set(node.data.id, { group: node.data, node });
  }
  visit(layout.grid.root);
  for (const floating of layout.floatingGroups ?? []) {
    groups.set(floating.data.id, { group: floating.data });
  }
  for (const popout of popouts) {
    let fallback: Target | undefined;
    const active = layout.activeGroup === popout.data.id;
    for (const id of popout.data.views) {
      const origin = originFor?.(id);
      let target = (origin && groups.get(origin.group.id))
        || (popout.gridReferenceGroup && groups.get(popout.gridReferenceGroup));
      if (!target) {
        if (!fallback) {
          const group: Group = { ...popout.data, views: [], activeView: undefined };
          const node: Node = { type: "leaf", data: group };
          const root = layout.grid.root;
          if (Array.isArray(root.data)) root.data.push(node);
          else layout.grid.root = { type: "branch", data: [root, node], size: root.size };
          fallback = { group, node };
          groups.set(group.id, fallback);
        }
        target = fallback;
      }
      if (!target.group.views.includes(id)) target.group.views.push(id);
      if (origin?.group.id === target.group.id && origin.order.length > (orders.get(target.group)?.length ?? 0)) {
        orders.set(target.group, origin.order);
      }
      if (id === popout.data.activeView) {
        target.group.activeView ??= id;
        if (active) {
          target.group.activeView = id;
          layout.activeGroup = target.group.id;
        }
      }
      if (target.node) target.node.visible = true;
    }
  }
  // Merge every popup first: a later, shorter snapshot must not erase slots
  // captured before earlier tabs left this same group.
  for (const [group, order] of orders) {
    group.views.sort((a, b) => {
      const left = order.indexOf(a);
      const right = order.indexOf(b);
      return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
    });
  }
  delete layout.popoutGroups;
  return layout;
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
        api.fromJSON(dockedLayout(data.layout));
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
