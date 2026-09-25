import { reconcileChildren } from "./dom";
import type { ActivityItem, ClientMessage, ServerMessage, SessionActivityDetail, SessionActivitySnapshot, SessionRecapSnapshot } from "./protocol";
import "./sessionInsights.css";

export type SessionInsightsOptions = {
  context(): { sessionId: string | null; ready: boolean; visible: boolean };
  send(message: ClientMessage): boolean;
  requestId(): string;
  showTool(toolCallId: string): void;
};

export type SessionInsights = {
  sync(): void;
  receive(message: ServerMessage): boolean;
  disconnect(): void;
  dispose(): void;
  mountActivity(host: HTMLElement): void;
};

type Operation = "activity" | "detail" | "recap";
type Pending = { id: string; sessionId: string; epoch: number; deadline: number; generation?: string; item?: ActivityItem };
type DetailState = { value?: SessionActivityDetail; error?: string; next: number; status?: ActivityItem["status"] };
type Cache = { activity?: SessionActivitySnapshot; activityError?: string; activityFresh: boolean; recap?: SessionRecapSnapshot; recapError?: string; recapFresh: boolean; details: Map<string, DetailState> };
type Row = { root: HTMLDetailsElement; summary: HTMLElement; label: HTMLElement; status: HTMLElement; meta: HTMLElement; text: HTMLElement; note: HTMLElement; tool: HTMLButtonElement; retry: HTMLButtonElement; item: ActivityItem };
type ActivityView = { host: HTMLElement; root: HTMLDetailsElement; heading: HTMLElement; note: HTMLElement; retry: HTMLButtonElement; active: HTMLElement; recent: HTMLElement; activeSection: HTMLElement; recentSection: HTMLElement; empty: HTMLElement; rows: Map<string, Row>; generation?: string; sessionId?: string | null };

const POLL_MS = 2_000;
const RECAP_POLL_MS = 5_000;
const TIMEOUT_MS = 15_000;
const RECENT_MS = 5 * 60_000;
const terminal: Partial<Record<ActivityItem["status"], true>> = { completed: true, failed: true, cancelled: true, exited: true, aborted: true };
const activeItem = (item: ActivityItem): boolean => !terminal[item.status];
const itemKey = (item: ActivityItem): string => `${item.kind}:${item.id}`;

function activityDuration(item: ActivityItem, observedAt: number): string {
  const seconds = Math.max(0, Math.floor(((item.endedAt ?? observedAt) - item.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Keep stable text nodes, focus and selected output while polling updates the view.
function text(node: HTMLElement, value: string): void {
  if (node.textContent === value) return;
  const child = node.firstChild;
  if (child?.nodeType === 3 && node.childNodes.length === 1) {
    const selection = node.ownerDocument.getSelection();
    const selected = selection?.anchorNode === child && selection.focusNode === child;
    const anchor = selection?.anchorOffset ?? 0;
    const focus = selection?.focusOffset ?? 0;
    (child as Text).data = value;
    if (selected) selection!.setBaseAndExtent(child, Math.min(anchor, value.length), child, Math.min(focus, value.length));
  } else node.textContent = value;
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, value?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (value) node.textContent = value;
  return node;
}

function button(doc: Document, className: string, label: string, action: () => void): HTMLButtonElement {
  const node = element(doc, "button", className, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function boundedDetail(value: SessionActivityDetail): SessionActivityDetail {
  const lines = value.text.split("\n");
  const capped = lines.slice(0, 200).join("\n");
  const bytes = new TextEncoder().encode(capped);
  const output = bytes.length > 65_536 ? new TextDecoder().decode(bytes.subarray(0, 65_536), { stream: true }) : capped;
  return { ...value, text: output, truncated: value.truncated || lines.length > 200 || bytes.length > 65_536 };
}

export function createSessionInsights(summaryButton: HTMLButtonElement, options: SessionInsightsOptions): SessionInsights {
  const caches = new Map<string, Cache>();
  const views = new Map<HTMLElement, ActivityView>();
  const documents = new Set<Document>();
  const pending: Partial<Record<Operation, Pending>> = {};
  let sessionId: string | null = null;
  let ready = false;
  let visible = false;
  let epoch = 0;
  let disposed = false;
  let timer: number | undefined;
  let activityNext = 0;
  let recapNext = 0;
  let summaryOpen = false;
  let popup: HTMLElement | undefined;
  let recapText: HTMLElement | undefined;
  let recapMeta: HTMLElement | undefined;
  let recapNote: HTMLElement | undefined;
  let recapRetry: HTMLButtonElement | undefined;
  let summaryClose: HTMLButtonElement | undefined;

  function cache(): Cache | undefined {
    if (!sessionId) return undefined;
    let value = caches.get(sessionId);
    if (!value) {
      value = { activityFresh: false, recapFresh: false, details: new Map() };
      caches.set(sessionId, value);
      if (caches.size > 10) caches.delete(caches.keys().next().value!);
    }
    return value;
  }

  function stopTimer(): void {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function invalidate(): void {
    epoch += 1;
    stopTimer();
    delete pending.activity;
    delete pending.detail;
    delete pending.recap;
    for (const entry of caches.values()) {
      entry.activityFresh = false;
      entry.recapFresh = false;
      for (const detail of entry.details.values()) detail.next = 0;
    }
    activityNext = 0;
    recapNext = 0;
  }

  function closeSummary(restoreFocus = true): void {
    if (!summaryOpen) return;
    summaryOpen = false;
    summaryButton.setAttribute("aria-expanded", "false");
    if (popup) {
      const hadFocus = popup.contains(popup.ownerDocument.activeElement);
      if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
      popup.hidden = true;
      if (restoreFocus && hadFocus && summaryButton.isConnected) summaryButton.focus();
    }
    schedule();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (summaryOpen && popup?.ownerDocument === event.currentTarget) {
      event.preventDefault();
      closeSummary();
      return;
    }
    for (const view of views.values()) {
      if (view.host.ownerDocument !== event.currentTarget || !view.root.contains(view.root.ownerDocument.activeElement)) continue;
      const row = [...view.rows.values()].find(row => row.root.open && row.root.contains(view.root.ownerDocument.activeElement));
      if (row) { row.root.open = false; row.summary.focus(); }
      else { view.root.open = false; view.heading.focus(); }
      event.preventDefault();
      schedule();
      break;
    }
  }

  function syncDocuments(): void {
    const next = new Set([summaryButton.ownerDocument, ...[...views.values()].map(view => view.host.ownerDocument)]);
    for (const doc of documents) if (!next.has(doc)) { doc.removeEventListener("keydown", onKey); documents.delete(doc); }
    for (const doc of next) if (!documents.has(doc)) { doc.addEventListener("keydown", onKey); documents.add(doc); }
    if (popup && popup.ownerDocument !== summaryButton.ownerDocument) {
      closeSummary(false);
      popup.remove();
      popup = undefined;
    }
  }

  function ensurePopup(): void {
    if (popup) return;
    const doc = summaryButton.ownerDocument;
    popup = element(doc, "section", "session-summary");
    popup.id = `session-summary-${options.requestId()}`;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Session summary");
    popup.setAttribute("popover", "auto");
    popup.hidden = true;
    const heading = element(doc, "header", "session-summary-heading");
    summaryClose = button(doc, "session-summary-close", "Close", () => closeSummary());
    heading.append(element(doc, "strong", "", "Summary"), summaryClose);
    recapMeta = element(doc, "p", "session-insights-note");
    recapNote = element(doc, "p", "session-insights-note");
    recapText = element(doc, "pre", "session-summary-text");
    recapRetry = button(doc, "session-insights-retry", "Retry", () => { recapNext = 0; pump(); });
    popup.append(heading, recapMeta, recapNote, recapText, recapRetry);
    popup.addEventListener("beforetoggle", event => {
      if ((event as ToggleEvent).newState === "closed") closeSummary();
    });
    doc.body.append(popup);
    summaryButton.setAttribute("aria-controls", popup.id);
  }

  function toggleSummary(): void {
    sync();
    if (!visible || !sessionId || disposed) return;
    if (summaryOpen) { closeSummary(); return; }
    ensurePopup();
    summaryOpen = true;
    recapNext = 0;
    const current = cache();
    if (current) current.recapFresh = false;
    summaryButton.setAttribute("aria-expanded", "true");
    popup!.hidden = false;
    renderSummary();
    if (typeof popup!.showPopover === "function") popup!.showPopover();
    summaryClose!.focus();
    pump();
  }

  function renderSummary(): void {
    const current = cache();
    const state = current?.recap;
    const recap = state?.recap;
    summaryButton.hidden = !visible || !sessionId;
    summaryButton.disabled = !sessionId;
    summaryButton.title = recap ? `Saved ${new Date(recap.createdAt).toLocaleString()}` : "Read the latest saved session recap";
    if (!popup) return;
    const fresh = current?.recapFresh && ready;
    popup.dataset.state = !fresh ? (state ? "stale" : "unavailable") : current?.recapError ? "unavailable" : "current";
    text(recapMeta!, recap
      ? `Saved ${new Date(recap.createdAt).toLocaleString()} · ${!fresh ? "Freshness unknown (cached)" : recap.stale === null ? "Freshness unknown" : recap.stale ? "Stale — conversation changed" : "Up to date"}`
      : fresh ? "No saved recap available." : "Saved recap is unknown until it can be read.");
    const notes: string[] = [];
    if (!ready) notes.push("Unavailable while disconnected or session is not ready.");
    else if (current?.recapError) notes.push(`Unable to read summary: ${current.recapError}`);
    else if (!state) notes.push("Reading saved summary…");
    if (state?.error) notes.push(`Recap generation failed: ${state.error}`);
    if (state && !state.enabled) notes.push("Automatic recap generation is disabled. Saved recaps remain readable.");
    if (state?.generating) notes.push("An automatic recap is being generated. This view only reads saved recaps.");
    if (state?.enabled && !state.generating && !recap) notes.push(`An automatic recap can appear after ${state.idleSeconds} seconds of session idle time.`);
    text(recapNote!, notes.join(" "));
    recapNote!.hidden = notes.length === 0;
    text(recapText!, recap?.text ?? "");
    recapText!.hidden = !recap;
    recapRetry!.hidden = !current?.recapError;
    recapRetry!.disabled = !ready || Boolean(pending.recap);
  }

  function createRow(view: ActivityView, item: ActivityItem): Row {
    const doc = view.host.ownerDocument;
    const root = element(doc, "details", "session-activity-item");
    root.dataset.activityId = item.id;
    root.dataset.kind = item.kind;
    const summary = element(doc, "summary", "session-activity-item-heading");
    const label = element(doc, "span", "session-activity-label");
    const status = element(doc, "span", "session-activity-status");
    const meta = element(doc, "p", "session-insights-note");
    const output = element(doc, "pre", "session-activity-output");
    const note = element(doc, "p", "session-insights-note");
    const row: Row = { root, summary, label, status, meta, text: output, note, item,
      tool: button(doc, "session-activity-tool", "Show tool", () => { if (row.item.toolCallId) options.showTool(row.item.toolCallId); }),
      retry: button(doc, "session-insights-retry", "Retry output", () => {
        const detail = cache()?.details.get(itemKey(row.item));
        if (detail) detail.next = 0;
        pump();
      }),
    };
    summary.append(label, status);
    root.append(summary, meta, row.tool, note, output, row.retry);
    root.addEventListener("toggle", () => { if (!disposed) pump(); });
    return row;
  }

  function renderActivity(view: ActivityView): void {
    const current = cache();
    const snapshot = current?.activity;
    const doc = view.host.ownerDocument;
    const focused = doc.activeElement as HTMLElement | null;
    const ownedFocus = focused && view.root.contains(focused);
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    const anchorOffset = selection?.anchorOffset ?? 0;
    const focusOffset = selection?.focusOffset ?? 0;
    const ownedSelection = anchor && focus && view.root.contains(anchor) && view.root.contains(focus);
    view.host.hidden = !visible || !sessionId;
    if (view.sessionId !== sessionId || view.generation !== snapshot?.generation) {
      const switched = view.sessionId !== sessionId;
      view.rows.clear();
      view.active.replaceChildren();
      view.recent.replaceChildren();
      view.sessionId = sessionId;
      view.generation = snapshot?.generation;
      if (switched) view.root.open = false;
    }
    const active = snapshot?.items.filter(activeItem) ?? [];
    const recent = snapshot?.items.filter(item => !activeItem(item) && snapshot.observedAt - (item.endedAt ?? item.startedAt) <= RECENT_MS)
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)).slice(0, 20) ?? [];
    const unavailable = snapshot ? Object.entries(snapshot.sources).filter(([, source]) => !source.available) : [];
    const fresh = Boolean(ready && current?.activityFresh && !current.activityError);
    const state = !fresh ? (snapshot ? "stale" : "unavailable") : unavailable.length ? "partial" : "current";
    view.root.dataset.state = state;
    const counts = (["job", "agent", "service"] as const).flatMap(kind => {
      const count = active.filter(item => item.kind === kind).length;
      return count ? [`${count} ${kind}${count === 1 ? "" : "s"}`] : [];
    });
    const single = active.length === 1 && active[0].kind !== "service" ? active[0] : undefined;
    const heading = ["Activity",
      ...(single ? [single.label, activityDuration(single, snapshot!.observedAt)] : counts.length ? counts : [fresh && !unavailable.length ? "none" : "unknown"]),
      ...(state === "current" ? [] : [state])].join(" · ");
    text(view.heading, heading);
    view.heading.title = heading;
    const notes: string[] = [];
    if (!ready) notes.push("Unavailable while disconnected or session is not ready. Cached activity may have changed.");
    else if (current?.activityError) notes.push(`Unable to read activity: ${current.activityError}`);
    else if (!snapshot) notes.push("Reading registered session activity…");
    for (const [name, source] of unavailable) notes.push(`${name}: unavailable${source.error ? ` — ${source.error}` : ""}`);
    if (snapshot) notes.push(`Observed ${new Date(snapshot.observedAt).toLocaleTimeString()}. Background activity is separate from agent Busy status.`);
    text(view.note, notes.join(" "));
    view.retry.hidden = !current?.activityError && unavailable.length === 0;
    view.retry.disabled = !ready || Boolean(pending.activity);
    view.empty.hidden = active.length + recent.length > 0;
    text(view.empty, fresh && !unavailable.length ? "No registered activity." : "Activity is unknown; this is not confirmation that nothing is running.");
    const keys = new Set<string>();
    const nodes = (items: ActivityItem[]): HTMLElement[] => items.map(item => {
      const key = itemKey(item);
      keys.add(key);
      let row = view.rows.get(key);
      if (!row) { row = createRow(view, item); view.rows.set(key, row); }
      row.item = item;
      row.root.dataset.status = item.status;
      text(row.label, item.label);
      text(row.status, `${item.status}${item.queued ? " · queued" : ""} · ${activityDuration(item, snapshot!.observedAt)}`);
      text(row.meta, `${item.kind} · ${item.id} · Started ${new Date(item.startedAt).toLocaleString()}${item.endedAt ? ` · Ended ${new Date(item.endedAt).toLocaleString()}` : ""}${item.exitCode === undefined ? "" : ` · Exit ${item.exitCode}`}`);
      row.tool.hidden = !item.toolCallId;
      const detail = current?.details.get(key);
      text(row.text, detail?.value?.text ?? "");
      row.text.hidden = !detail?.value;
      text(row.note, !item.detailAvailable ? "Output unavailable for this activity."
        : detail?.error ? `Output unavailable: ${detail.error}${detail.value ? " (cached output shown)" : ""}`
          : !fresh || detail?.next === 0 ? "Output may be stale."
            : detail?.value ? (detail.value.truncated ? "Output truncated (up to 200 lines / 64 KiB)." : "")
              : "Open to read output.");
      row.note.hidden = !row.note.textContent;
      row.retry.hidden = !detail?.error;
      row.retry.disabled = !ready || Boolean(pending.detail);
      return row.root;
    });
    reconcileChildren(view.active, nodes(active));
    reconcileChildren(view.recent, nodes(recent));
    for (const key of view.rows.keys()) if (!keys.has(key)) view.rows.delete(key);
    view.activeSection.hidden = active.length === 0;
    view.recentSection.hidden = recent.length === 0;
    if (ownedFocus && focused.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
    if (ownedSelection && anchor.isConnected && focus.isConnected && anchor.nodeType === 3 && focus.nodeType === 3) {
      selection!.setBaseAndExtent(anchor, Math.min(anchorOffset, anchor.textContent?.length ?? 0), focus, Math.min(focusOffset, focus.textContent?.length ?? 0));
    }
  }

  function render(): void {
    renderSummary();
    for (const view of views.values()) renderActivity(view);
  }

  function openedItems(): ActivityItem[] {
    const result = new Map<string, ActivityItem>();
    const snapshot = cache()?.activity;
    for (const view of views.values()) {
      if (!view.root.open || !view.host.isConnected || view.sessionId !== sessionId || view.generation !== snapshot?.generation) continue;
      for (const [key, row] of view.rows) {
        const item = snapshot?.items.find(item => itemKey(item) === key);
        if (row.root.open && item?.detailAvailable) result.set(key, item);
      }
    }
    return [...result.values()];
  }

  function fail(operation: Operation, request: Pending, message: string): void {
    const current = cache();
    if (!current) return;
    if (operation === "activity") { current.activityError = message; current.activityFresh = false; activityNext = Date.now() + POLL_MS; }
    if (operation === "recap") { current.recapError = message; current.recapFresh = false; recapNext = Date.now() + RECAP_POLL_MS; }
    if (operation === "detail" && request.item && request.generation === current.activity?.generation) {
      const key = itemKey(request.item);
      current.details.set(key, { ...current.details.get(key), error: message, next: Date.now() + POLL_MS });
    }
  }

  function request(operation: Operation, item?: ActivityItem): void {
    if (!sessionId || pending[operation]) return;
    const id = options.requestId();
    const generation = cache()?.activity?.generation;
    const flight: Pending = { id, sessionId, epoch, deadline: Date.now() + TIMEOUT_MS, generation, item };
    pending[operation] = flight;
    const message: ClientMessage = operation === "activity" ? { type: "session.activity.get", requestId: id, sessionId }
      : operation === "recap" ? { type: "session.recap.get", requestId: id, sessionId }
        : { type: "session.activity.detail", requestId: id, sessionId, generation: generation!, kind: item!.kind, activityId: item!.id };
    if (!options.send(message)) { delete pending[operation]; fail(operation, flight, "Request could not be sent."); }
  }

  function detailDue(item: ActivityItem): number {
    const state = cache()?.details.get(itemKey(item));
    if (!state || state.next === 0) return 0;
    if (state.error || activeItem(item)) return state.next;
    return state.status !== item.status ? 0 : Infinity;
  }

  function pump(): void {
    if (disposed) return;
    if (ready && visible && sessionId && summaryButton.isConnected) {
      const now = Date.now();
      for (const operation of ["activity", "detail", "recap"] as const) {
        const flight = pending[operation];
        if (flight && flight.deadline <= now) { delete pending[operation]; fail(operation, flight, "Read timed out. Retrying while this view is active."); }
      }
      if (!pending.activity && now >= activityNext) request("activity");
      if (summaryOpen && !pending.recap && now >= recapNext) request("recap");
      if (!pending.detail && cache()?.activityFresh) {
        const item = openedItems().filter(item => detailDue(item) <= now).sort((a, b) => detailDue(a) - detailDue(b))[0];
        if (item) request("detail", item);
      }
    }
    render();
    schedule();
  }

  function schedule(): void {
    stopTimer();
    if (disposed || !ready || !visible || !sessionId || !summaryButton.isConnected) return;
    const due = [pending.activity?.deadline ?? activityNext];
    if (summaryOpen) due.push(pending.recap?.deadline ?? recapNext);
    if (pending.detail) due.push(pending.detail.deadline);
    else if (cache()?.activityFresh) due.push(...openedItems().map(detailDue));
    timer = window.setTimeout(sync, Math.max(1, Math.min(...due) - Date.now()));
  }

  function sync(): void {
    if (disposed) return;
    const context = options.context();
    if (context.sessionId !== sessionId) {
      closeSummary(false);
      invalidate();
      sessionId = context.sessionId;
    } else if (ready !== context.ready) invalidate();
    ready = context.ready;
    visible = context.visible;
    if (!visible) closeSummary(false);
    syncDocuments();
    pump();
  }

  function receive(message: ServerMessage): boolean {
    const operation: Operation | undefined = message.type === "session.activity.result" ? "activity"
      : message.type === "session.activity.detail.result" ? "detail"
        : message.type === "session.recap.result" ? "recap"
          : message.type === "session.insights.error" ? message.operation : undefined;
    if (!operation) return false;
    if (disposed || !("requestId" in message) || !("sessionId" in message)) return true;
    const flight = pending[operation];
    const context = options.context();
    if (!flight || flight.id !== message.requestId || flight.sessionId !== message.sessionId
      || flight.epoch !== epoch || sessionId !== message.sessionId || context.sessionId !== sessionId || !ready || !context.ready) return true;
    const current = cache()!;
    delete pending[operation];
    if (message.type === "session.insights.error") fail(operation, flight, message.message);
    else if (message.type === "session.activity.result" && message.activity.sessionId === sessionId) {
      if (current.activity?.generation !== message.activity.generation) current.details.clear();
      current.activity = message.activity;
      current.activityFresh = true;
      current.activityError = undefined;
      const keys = new Set(message.activity.items.map(itemKey));
      for (const key of current.details.keys()) if (!keys.has(key)) current.details.delete(key);
      activityNext = Date.now() + POLL_MS;
    } else if (message.type === "session.recap.result" && message.state.sessionId === sessionId) {
      current.recap = message.state;
      current.recapFresh = true;
      current.recapError = undefined;
      recapNext = Date.now() + RECAP_POLL_MS;
    } else if (message.type === "session.activity.detail.result" && flight.item
      && message.detail.sessionId === sessionId && message.detail.generation === current.activity?.generation
      && message.detail.generation === flight.generation && message.detail.kind === flight.item.kind && message.detail.activityId === flight.item.id) {
      current.details.set(itemKey(flight.item), { value: boundedDetail(message.detail), status: flight.item.status, next: Date.now() + POLL_MS });
    } else fail(operation, flight, "Read returned a different session or activity generation.");
    pump();
    return true;
  }

  function mountActivity(host: HTMLElement): void {
    if (disposed) return;
    if (views.has(host)) { sync(); return; }
    const doc = host.ownerDocument;
    const root = element(doc, "details", "session-activity");
    const heading = element(doc, "summary", "session-activity-heading", "Activity");
    const body = element(doc, "div", "session-activity-body");
    const note = element(doc, "p", "session-insights-note");
    const retry = button(doc, "session-insights-retry", "Retry activity", () => { activityNext = 0; pump(); });
    const activeSection = element(doc, "section", "session-activity-active");
    const recentSection = element(doc, "section", "session-activity-recent");
    const active = element(doc, "div", "session-activity-items");
    const recent = element(doc, "div", "session-activity-items");
    activeSection.append(element(doc, "h3", "", "Active"), active);
    recentSection.append(element(doc, "h3", "", "Recent"), recent);
    const empty = element(doc, "p", "session-insights-note");
    body.append(note, retry, empty, activeSection, recentSection);
    root.append(heading, body);
    root.addEventListener("toggle", () => { if (!disposed) pump(); });
    host.append(root);
    views.set(host, { host, root, heading, note, retry, active, recent, activeSection, recentSection, empty, rows: new Map() });
    sync();
  }

  summaryButton.type = "button";
  summaryButton.setAttribute("aria-haspopup", "dialog");
  summaryButton.setAttribute("aria-expanded", "false");
  summaryButton.addEventListener("click", toggleSummary);

  return {
    sync, receive, mountActivity,
    disconnect() { invalidate(); ready = false; render(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      closeSummary(false);
      summaryButton.removeEventListener("click", toggleSummary);
      summaryButton.removeAttribute("aria-controls");
      for (const doc of documents) doc.removeEventListener("keydown", onKey);
      documents.clear();
      popup?.remove();
      for (const view of views.values()) view.root.remove();
      views.clear();
      caches.clear();
      delete pending.activity;
      delete pending.detail;
      delete pending.recap;
    },
  };
}
