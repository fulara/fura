import "dockview-core/dist/styles/dockview.css";
import { DockviewComponent, themeDark } from "dockview-core";
import type { DockviewGroupPanel, IDockviewPanel, SerializedDockview } from "dockview-core";
import { captureDiffViewScroll, restoreDiffViewScroll } from "./diffViewDom";

export type PinnedDiffPanelId = `pinnedDiff:${string}`;
export type DesktopDockviewPanelId = "sessionChanges" | "transcript" | "code" | "tools" | "diffs" | "compare" | PinnedDiffPanelId;

export type DesktopDockviewLayoutMode = "normal" | "diffReview";

export type PinnedPanelPresentation = {
  id: PinnedDiffPanelId;
  title: string;
  content: HTMLElement;
  active: boolean;
  restore: () => void;
};

export function isPinnedDiffPanelId(id: string): id is PinnedDiffPanelId {
  return id.startsWith("pinnedDiff:") && id.length > "pinnedDiff:".length;
}

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
  addPinnedPanel(id: PinnedDiffPanelId, title: string, presentation?: PinnedPanelPresentation): boolean;
  detachPinnedPanel(id: PinnedDiffPanelId): PinnedPanelPresentation | null;
  isPanelPoppedOut(id: PinnedDiffPanelId): boolean;
  forgetPinnedPanel(id: PinnedDiffPanelId): void;
  setPanelTitle(id: DesktopDockviewPanelId, title: string): boolean;
  closePanel(id: "sessionChanges" | "diffs" | "compare" | PinnedDiffPanelId): boolean;
};

type DesktopDockviewOptions = {
  host: HTMLDivElement;
  layoutMode: DesktopDockviewLayoutMode;
  storageKey: string;
  onPanelReady(id: DesktopDockviewPanelId, container: HTMLElement): void;
  onPanelActivated(id: DesktopDockviewPanelId): void;
  onPanelClosed?(id: DesktopDockviewPanelId): void;
  onPinnedPanelReturned?(id: PinnedDiffPanelId): void;
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
  scroll: HTMLElement;
};

type PanelReturnLocation = { group: DockviewGroupPanel; order: string[] };
const pendingScrollRestores = new WeakMap<HTMLElement, { restore(): void; stop(): void }>();


export function initDesktopDockview(options: DesktopDockviewOptions): DesktopDockview {
  const panelEls: Partial<Record<DesktopDockviewPanelId, HTMLElement>> = {};
  const panelActivators: Partial<Record<DesktopDockviewPanelId, () => void>> = {};
  const owner = options.host.ownerDocument;
  const win = owner.defaultView ?? window;
  const visiblePanels = new Set<DesktopDockviewPanelId>();
  const watchedDocuments = new WeakSet<Document>();
  let visibilityQueued = false;
  let shuttingDown = false;
  let layoutSaveTimer: number | undefined;
  const returnLocations = new Map<string, PanelReturnLocation>();
  const openingPins = new Map<PinnedDiffPanelId, { window?: Window; timer?: number }>();
  let mountingPresentation: PinnedPanelPresentation | undefined;
  let detachingPanel: PinnedDiffPanelId | undefined;
  let transferSelections: Map<string, boolean> | undefined;
  const guardedGroups = new WeakSet<DockviewGroupPanel>();
  win.addEventListener("beforeunload", () => {
    if (api.isDisposed || shuttingDown) return;
    shuttingDown = true;
    for (const opening of openingPins.values()) win.clearInterval(opening.timer);
    win.clearTimeout(layoutSaveTimer);
    // Save return positions before Dockview closes its windows. Do not move
    // content or reopen anything while the owning application is shutting down.
    const data: PersistedDockviewLayout = {
      version: 1,
      layout: persistentLayout(dockedLayout(api.toJSON(), id => returnLocations.get(id))),
    };
    storage(win).setItem(options.storageKey, JSON.stringify(data));
  }, { capture: true });

  function mainGroup(group: DockviewGroupPanel): boolean {
    return api.groups.includes(group) && group.api.location.type !== "popout";
  }

  function pinFallbackGroup(): DockviewGroupPanel {
    const diffs = api.getGroupPanel(options.layoutMode === "normal" ? "diffs" : "sessionChanges");
    return diffs?.api.location.type === "grid" ? diffs.group
      : api.groups.find(group => group.api.location.type === "grid") ?? api.addGroup();
  }

  function returnIndex(id: string, target: DockviewGroupPanel, order: string[]): number {
    const originalIndex = order.indexOf(id);
    if (originalIndex < 0) return target.panels.length;
    const remaining = target.panels.filter(panel => panel.id !== id);
    const next = order.slice(originalIndex + 1).find(candidate => remaining.some(panel => panel.id === candidate));
    const previous = order.slice(0, originalIndex).reverse().find(candidate => remaining.some(panel => panel.id === candidate));
    return next ? remaining.findIndex(panel => panel.id === next)
      : previous ? remaining.findIndex(panel => panel.id === previous) + 1
      : Math.min(originalIndex, remaining.length);
  }

  function rememberLocation(panel: IDockviewPanel, group: DockviewGroupPanel, order: string[]): void {
    const fullOrder = [...order];
    for (const [id, origin] of returnLocations) {
      if (origin.group !== group || fullOrder.includes(id)) continue;
      const current = api.getGroupPanel(id);
      if (current && current.api.location.type !== "popout") continue;
      const index = origin.order.indexOf(id);
      const next = origin.order.slice(index + 1).find(candidate => fullOrder.includes(candidate));
      const previous = origin.order.slice(0, index).reverse().find(candidate => fullOrder.includes(candidate));
      fullOrder.splice(next ? fullOrder.indexOf(next) : previous ? fullOrder.indexOf(previous) + 1 : 0, 0, id);
    }
    returnLocations.set(panel.id, { group, order: fullOrder });
  }

  function forgetLocation(id: string): void {
    const origin = returnLocations.get(id);
    returnLocations.delete(id);
    if (!origin) return;
    queueMicrotask(() => {
      if (shuttingDown || api.isDisposed || !mainGroup(origin.group) || origin.group.size !== 0) return;
      const retained = [...returnLocations].some(([panelId, location]) => {
        const panel = api.getGroupPanel(panelId);
        return location.group === origin.group
          && (panel?.api.location.type === "popout" || (!panel && isPinnedDiffPanelId(panelId)));
      });
      if (!retained) api.removeGroup(origin.group);
    });
  }

  function removePinnedPanel(panel: IDockviewPanel): void {
    const group = panel.group;
    const retained = group.api.location.type === "grid" && [...returnLocations].some(([id, origin]) => {
      const current = api.getGroupPanel(id);
      return id !== panel.id && origin.group === group
        && (current?.api.location.type === "popout" || (!current && isPinnedDiffPanelId(id)));
    });
    api.removePanel(panel, { removeEmptyGroup: !retained });
    if (retained && group.size === 0) group.api.setVisible(false);
  }

  function returnPanels(panels: IDockviewPanel[]): void {
    if (shuttingDown || api.isDisposed) return;
    const locations = panels.map(panel => ({ panel, origin: returnLocations.get(panel.id) }));
    const selected = panels.filter(panel => panel.api.isVisible);
    for (const { panel, origin } of locations) {
      if (api.getGroupPanel(panel.id) !== panel) continue;
      const target = origin && mainGroup(origin.group) ? origin.group
        : isPinnedDiffPanelId(panel.id) ? pinFallbackGroup()
        : mainGroup(panel.group) ? panel.group
        : api.groups.find(group => group.api.location.type === "grid") ?? api.addGroup();
      // A popup can collect tabs detached at different times. Use the fullest
      // original ordering so later departures do not erase earlier tab slots.
      const order = locations.filter(entry => entry.origin?.group === origin?.group)
        .reduce((best, entry) => (entry.origin?.order.length ?? 0) > best.length ? entry.origin!.order : best, origin?.order ?? []);
      const index = returnIndex(panel.id, target, order);
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
    if (shuttingDown) return;
    if (isPinnedDiffPanelId(panel.id)) {
      removePinnedPanel(panel);
      return;
    }
    if (panel.api.location.type !== "popout") return;
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
        if (group.api.location.type !== "popout") rememberLocation(panel, group, order);
        order = group.panels.map(candidate => candidate.id);
      }),
    );
  }

  function workspaceVisible(): boolean {
    return !options.host.classList.contains("workspace-panel-host")
      || options.host.classList.contains("workspace-panel-host-active");
  }

  function panelSelected(id: DesktopDockviewPanelId): boolean {
    const panel = api.getGroupPanel(id);
    return Boolean(panel?.api.isVisible
      && (workspaceVisible() || (isPinnedDiffPanelId(id) && panel.api.location.type === "popout")));
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
        if (element) element.style.visibility = !isPinnedDiffPanelId(id) && element.ownerDocument !== owner && !workspaceVisible() ? "hidden" : "";
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
        for (const panel of panels) {
          if (isPinnedDiffPanelId(panel.id) && api.getGroupPanel(panel.id) === panel && panel.api.location.type !== "popout") {
            options.onPinnedPanelReturned?.(panel.id);
          }
        }
      });
    }, { capture: true });
  }

  function preserveTransferScroll(id: DesktopDockviewPanelId): () => void {
    const container = panelEls[id];
    return container ? capturePanelScroll(container) : () => {};
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
          if (isPinnedDiffPanelId(params.api.id)) {
            const close = owner.createElement("button");
            close.type = "button";
            close.className = "dv-default-tab-action panel-close-btn";
            close.title = "Close pinned panel";
            close.setAttribute("aria-label", "Close pinned panel");
            close.textContent = "×";
            close.addEventListener("pointerdown", event => { event.stopPropagation(); });
            close.addEventListener("click", event => {
              event.preventDefault();
              event.stopPropagation();
              params.api.close();
            });
            element.append(close);
          }
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
        const pinId = isPinnedDiffPanelId(panelId) ? panelId : undefined;
        const opening: { window?: Window; timer?: number } | undefined = pinId ? {} : undefined;
        if (pinId && opening) {
          if (openingPins.has(pinId)) return;
          openingPins.set(pinId, opening);
        }
        let restoreScroll = preserveTransferScroll(panelId);
        const finish = (opened: boolean) => {
          if (pinId && openingPins.get(pinId) !== opening) return;
          if (opening) win.clearInterval(opening.timer);
          if (pinId) openingPins.delete(pinId);
          if (opened) restoreScroll();
          else if (pinId && opening) {
            opening.window?.close();
            if (!shuttingDown && !api.isDisposed && api.getGroupPanel(pinId) === panel) options.onPinnedPanelReturned?.(pinId);
          }
          notifyVisibility();
        };
        void api.api.addPopoutGroup(panel, {
          popoutUrl: "/popout.html",
          onDidOpen: ({ window: popWin }) => {
            if (opening) {
              opening.window = popWin;
              // Dockview's opening promise is load-only; a pre-load close may
              // emit no usable document event. Check only during this handshake.
              opening.timer = win.setInterval(() => { if (popWin.closed) finish(false); }, 100);
            }
            copyStylesToPopout(owner, popWin);
            watchPopout(popWin);
            popWin.addEventListener("load", () => {
              restoreScroll = preserveTransferScroll(panelId);
              watchPopout(popWin);
            }, { once: true });
          },
        }).then(finish, () => finish(false));
      });
      const button = element.querySelector<HTMLButtonElement>("button")!;
      const update = () => {
        const returning = group.api.location.type === "popout";
        button.className = returning ? "panel-return-btn" : "panel-popout-btn";
        const pin = group.activePanel && isPinnedDiffPanelId(group.activePanel.id);
        button.textContent = returning ? "Return to main" : pin ? "Open in new window" : "Pop out";
        button.title = returning ? "Return to main" : pin ? "Open in new window" : "Open panel in a separate window";
      };
      const listeners = [group.api.onDidLocationChange(update), group.api.onDidActivePanelChange(update)];
      update();
      return { element, init() {}, dispose() { for (const listener of listeners) listener.dispose(); } };
    },
    createComponent(componentOptions) {
      const panelId = desktopPanelId(componentOptions.name);
      if (!panelId) {
        const element = owner.createElement("div");
        return { element, init() {} };
      }

      const shell = createDesktopPanelShell(owner, panelId, mountingPresentation?.id === panelId ? mountingPresentation.content : undefined);

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
          params.api.onDidVisibilityChange(({ isVisible }) => {
            if (isPinnedDiffPanelId(panelId) && panelEls[panelId] === shell.scroll) {
              // Registered before Dockview's overlay listener sets display:none:
              // hidden scrollers report zero, so retain the last visible state.
              if (!isVisible && !mountingPresentation) preserveTransferScroll(panelId)();
              else if (isVisible) pendingScrollRestores.get(shell.scroll)?.restore();
            }
            notifyVisibility();
          });
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
    const content = panelEls[panelId];
    delete panelEls[panelId];
    delete panelActivators[panelId];
    visiblePanels.delete(panelId);
    if (content) pendingScrollRestores.get(content)?.stop();
    if (detachingPanel === panelId) return;
    if (isPinnedDiffPanelId(panelId)) {
      const opening = openingPins.get(panelId);
      openingPins.delete(panelId);
      if (opening) win.clearInterval(opening.timer);
      opening?.window?.close();
    }
    queueMicrotask(() => { if (!api.getGroupPanel(panelId)) forgetLocation(panelId); });
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
      const data: PersistedDockviewLayout = { version: 1, layout: persistentLayout(api.toJSON()) };
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
    addPinnedPanel(id, title, presentation) {
      if (!isPinnedDiffPanelId(id) || api.getGroupPanel(id) || (presentation && presentation.id !== id)) return false;
      const origin = presentation && returnLocations.get(id);
      const group = origin && mainGroup(origin.group) ? origin.group : pinFallbackGroup();
      mountingPresentation = presentation;
      try {
        const panel = api.addPanel({
          id,
          component: id,
          title,
          position: { referenceGroup: group, direction: "within", index: origin?.group === group ? returnIndex(id, group, origin.order) : undefined },
          inactive: presentation ? !presentation.active : false,
          renderer: "always",
        });
        if (!group.activePanel) group.model.openPanel(panel, { skipSetGroupActive: true });
      } finally {
        mountingPresentation = undefined;
      }
      if (!group.api.isVisible) group.api.setVisible(true);
      presentation?.restore();
      return true;
    },
    detachPinnedPanel(id) {
      const panel = api.getGroupPanel(id);
      const content = panelEls[id];
      if (!panel || !content || !isPinnedDiffPanelId(id) || openingPins.has(id) || panel.api.location.type === "popout") return null;
      if (!transferSelections) {
        transferSelections = new Map(api.panels.filter(candidate => isPinnedDiffPanelId(candidate.id))
          .map(candidate => [candidate.id, candidate.group.activePanel === candidate]));
        queueMicrotask(() => { transferSelections = undefined; });
      }
      const presentation: PinnedPanelPresentation = {
        id, title: panel.title ?? id, content,
        active: transferSelections.get(id) ?? false,
        restore: preserveTransferScroll(id),
      };
      const group = panel.group;
      rememberLocation(panel, group, group.panels.map(candidate => candidate.id));
      detachingPanel = id;
      try {
        content.remove();
        api.removePanel(panel, { removeEmptyGroup: group.api.location.type !== "grid", skipSetActiveGroup: true });
      } finally {
        detachingPanel = undefined;
      }
      if (group.api.location.type === "grid" && group.size === 0) group.api.setVisible(false);
      return presentation;
    },
    isPanelPoppedOut(id) {
      return openingPins.has(id) || api.getGroupPanel(id)?.api.location.type === "popout";
    },
    forgetPinnedPanel(id) {
      if (!api.getGroupPanel(id)) forgetLocation(id);
    },
    setPanelTitle(id, title) {
      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      panel.api.setTitle(title);
      return true;
    },
    closePanel(id) {
      const panel = api.getGroupPanel(id);
      if (!panel) return false;
      if (isPinnedDiffPanelId(id)) removePinnedPanel(panel);
      else api.removePanel(panel);
      return true;
    },
  };
}

function createDesktopPanelShell(
  owner: Document,
  panelId: DesktopDockviewPanelId,
  content?: HTMLElement,
): DesktopPanelShell {
  const element = owner.createElement("div");
  element.className = isPinnedDiffPanelId(panelId)
    ? "panel-content panel-content-diffs panel-content-pinned-diff"
    : `panel-content panel-content-${panelId}`;

  const scroll = content ?? owner.createElement("div");
  if (!content) scroll.className = "panel-scroll";
  element.append(scroll);
  return { element, scroll };
}

function capturePanelScroll(container: HTMLElement): () => void {
  const pending = pendingScrollRestores.get(container);
  if (pending) return pending.restore;
  const snapshot = captureDiffViewScroll(container);
  const focused = container.ownerDocument.activeElement;
  const scroll = [container, ...container.querySelectorAll<HTMLElement>("*")]
    .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0)
    .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  function apply(): void {
    for (const { element, top, left } of scroll) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    restoreDiffViewScroll(container, snapshot);
    const active = container.ownerDocument.activeElement;
    // A popup can close while the user is already typing in the main composer.
    // Its stale activeElement must not replace focus in the destination.
    if (container.isConnected && focused && container.contains(focused)
      && (!active || active === container.ownerDocument.body || container.contains(active))
      && !container.closest(".workspace-panel-host:not(.workspace-panel-host-active)")) {
      (focused as HTMLElement).focus({ preventScroll: true });
    }
  }
  return function restore(): void {
    pendingScrollRestores.get(container)?.stop();
    apply();
    const view = container.ownerDocument.defaultView;
    if (!view || (scroll.length === 0 && !snapshot)) return;
    let frame = 0;
    const schedule = () => {
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(settle);
    };
    const observer = new view.ResizeObserver(schedule);
    const stop = () => {
      observer.disconnect();
      view.cancelAnimationFrame(frame);
      if (pendingScrollRestores.get(container)?.stop === stop) pendingScrollRestores.delete(container);
    };
    function settle(): void {
      const root = container.querySelector<HTMLElement>(".diffs-view, .compare-view") ?? container;
      if (!container.isConnected || (snapshot && root.dataset.reviewTarget !== snapshot.target)) {
        stop();
        return;
      }
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      apply();
      stop();
    }
    pendingScrollRestores.set(container, { restore, stop });
    observer.observe(container);
    schedule();
  };
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

// Pin descriptors and their content live only in RAM. Filter before Dockview
// deserializes anything, including stale pins mixed into an older workspace.
function persistentLayout(layout: SerializedDockview): SerializedDockview {
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (!desktopPanelId(id) || isPinnedDiffPanelId(id) || panel.id !== id || panel.contentComponent !== id) {
      delete layout.panels[id];
    }
  }
  type Node = SerializedDockview["grid"]["root"];
  type Group = Exclude<Node["data"], Node[]>;
  const groups = new Set<string>();
  const panels = new Set<string>();
  // Native popouts need their empty main-group placeholders until redocked.
  // A transient/unknown-only popup must not retain one.
  const returnGroups = new Set((layout.popoutGroups ?? [])
    .filter(group => group.data.views.some(id => Object.hasOwn(layout.panels, id)))
    .map(group => group.gridReferenceGroup));
  function keepGroup(group: Group): boolean {
    group.views = group.views.filter(id => {
      if (!Object.hasOwn(layout.panels, id) || panels.has(id)) return false;
      panels.add(id);
      return true;
    });
    if (group.views.length === 0 && !returnGroups.has(group.id)) return false;
    if (!group.activeView || !group.views.includes(group.activeView)) group.activeView = group.views[0];
    groups.add(group.id);
    return true;
  }
  function keepNode(node: Node): boolean {
    if (!Array.isArray(node.data)) return keepGroup(node.data);
    node.data = node.data.filter(keepNode);
    // Retain single-child branches: depth determines split orientation.
    return node.data.length > 0;
  }
  if (!keepNode(layout.grid.root)) layout.grid.root = { type: "branch", data: [] };
  layout.floatingGroups = layout.floatingGroups?.filter(group => keepGroup(group.data));
  layout.popoutGroups = layout.popoutGroups?.filter(group => keepGroup(group.data));
  for (const group of layout.popoutGroups ?? []) {
    if (group.gridReferenceGroup && !groups.has(group.gridReferenceGroup)) delete group.gridReferenceGroup;
  }
  if (layout.activeGroup && !groups.has(layout.activeGroup)) delete layout.activeGroup;
  for (const id of Object.keys(layout.panels)) {
    if (!panels.has(id)) delete layout.panels[id];
  }
  return layout;
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
        api.fromJSON(persistentLayout(dockedLayout(data.layout)));
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
  return name === "sessionChanges" || name === "transcript" || name === "code" || name === "tools" || name === "diffs" || name === "compare" || isPinnedDiffPanelId(name) ? name : null;
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
