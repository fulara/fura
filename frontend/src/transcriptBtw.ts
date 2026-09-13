import type { ClientMessage, SessionBtwUpdate } from "./protocol";
import { copyTextToClipboard, reconcileChildren, setRenderDocument } from "./dom";
import { renderMarkdown } from "./transcriptView";

// OMP TUI has follow-ups, but Fura-facing RPC has no topic continuation.
// Never route the main composer as a workaround. Revisit only with an explicit
// richer backend contract, not an OMP version check or an upgrade promise.
export const BTW_TOOLTIP = "Uses conversation context captured at start. Codex-like continuing side chats require a richer backend contract; upgrading OMP alone does not enable them.";
export const BTW_EXPLANATION = "One-shot question. Continuing this conversation is not supported by the current OMP integration. No follow-ups or tools; this does not enter the main conversation. The main conversation keeps running. Results are not saved.";

type BtwState = "sending" | "running" | "completed" | "cancelled" | "error" | "interrupted";
type BtwTab = {
  requestId: string;
  sourceSessionId: string;
  generation: number;
  question: string;
  answer: string;
  state: BtwState;
  accepted: boolean;
  closed: boolean;
  nativePending: boolean;
  releasing: boolean;
  cleanupError: string | null;
  error: string | null;
  unread: boolean;
  scroll: number;
  focus: HTMLElement | null;
};
type SourceTabs = { selected: string | null; mainScroll: number | null; mainFocus: HTMLElement | null; sendBlocked: boolean };
type SideView = { panel: HTMLElement; status: HTMLElement; answer: HTMLElement; copy: HTMLButtonElement; renderedAnswer: string | null };
type TranscriptView = {
  prefix: string;
  tablist: HTMLElement;
  main: HTMLElement;
  warning: HTMLElement;
  tabs: Map<string, { wrapper: HTMLElement; button: HTMLButtonElement; badge: HTMLElement }>;
  sides: Map<string, SideView>;
  source: string | null;
};

export class TranscriptBtw {
  readonly tabs = new Map<string, BtwTab>();
  private readonly sources = new Map<string, SourceTabs>();
  private readonly views = new WeakMap<HTMLElement, TranscriptView>();
  private generation = 0;
  private nextViewId = 0;
  private visibleSource: string | null = null;
  private transcriptVisible = true;

  constructor(private readonly options: {
    clientId: string;
    send(message: ClientMessage): boolean;
    changed(): void;
    accepted(requestId: string): void;
    failed(requestId: string): void;
  }) {}

  isSideSelected(source: string | null): boolean {
    return Boolean(source && this.sources.get(source)?.selected);
  }

  isBlocked(source: string): boolean {
    return [...this.tabs.values()].some(tab => tab.sourceSessionId === source && tab.nativePending);
  }

  rejectMainSend(source: string): boolean {
    const state = this.sources.get(source);
    if (!state?.selected) return false;
    state.sendBlocked = true;
    this.options.changed();
    return true;
  }

  setVisibleSource(source: string | null, transcriptVisible: boolean): void {
    this.visibleSource = source;
    this.transcriptVisible = transcriptVisible;
    const selected = source ? this.sources.get(source)?.selected : null;
    const tab = selected ? this.tabs.get(selected) : undefined;
    if (transcriptVisible && tab) tab.unread = false;
  }

  start(source: string, requestId: string, question: string): boolean {
    if (this.isBlocked(source)) return false;
    const tab: BtwTab = { requestId, sourceSessionId: source, generation: this.generation,
      question, answer: "", state: "sending", accepted: false, closed: false,
      nativePending: true, releasing: false, cleanupError: null, error: null, unread: false, scroll: 0, focus: null };
    this.tabs.set(requestId, tab);
    const sourceTabs = this.sources.get(source) ?? { selected: null, mainScroll: null, mainFocus: null, sendBlocked: false };
    this.sources.set(source, sourceTabs);
    sourceTabs.selected = requestId;
    if (!this.options.send({ type: "session.btw.start", clientId: this.options.clientId, sessionId: source, requestId, question })) {
      tab.state = "error";
      tab.nativePending = false;
      tab.error = "Not connected. The question was not sent.";
      this.options.failed(requestId);
    }
    this.options.changed();
    return true;
  }

  update(message: SessionBtwUpdate): void {
    const tab = this.tabs.get(message.requestId);
    if (!tab || tab.generation !== this.generation || message.targetClientId !== this.options.clientId
      || tab.sourceSessionId !== message.sourceSessionId) return;
    if (message.state === "accepted") {
      if (!tab.accepted && tab.state !== "interrupted") {
        tab.accepted = true;
        this.options.accepted(tab.requestId);
        if (tab.state === "error") this.options.failed(tab.requestId);
      }
    } else if (message.state === "released") {
      tab.nativePending = false;
      tab.releasing = false;
      tab.cleanupError = null;
      if (tab.closed) this.tabs.delete(tab.requestId);
    } else if (message.state === "release_error") {
      tab.releasing = false;
      tab.cleanupError = message.error ?? "Native cleanup failed.";
    } else if (!tab.closed && (tab.state === "sending" || tab.state === "running")) {
      if (message.state === "started" || message.state === "streaming") {
        tab.state = "running";
        if (message.state === "streaming") tab.answer += message.delta ?? "";
      } else {
        tab.state = message.state;
        if (message.state === "completed") tab.answer = message.answer ?? "";
        if (message.state === "error") {
          tab.error = message.error ?? "Side question failed.";
          this.options.failed(tab.requestId);
        }
        tab.unread = message.state === "completed" && !(this.visibleSource === tab.sourceSessionId
          && this.transcriptVisible && this.sources.get(tab.sourceSessionId)?.selected === tab.requestId);
        this.release(tab);
      }
    }
    this.options.changed();
  }

  private release(tab: BtwTab): void {
    if (!tab.nativePending || tab.releasing || tab.cleanupError) return;
    tab.releasing = true;
    if (!this.options.send({ type: "session.btw.release", clientId: this.options.clientId, requestId: tab.requestId })) {
      tab.releasing = false;
      tab.cleanupError = "Cleanup could not be sent. Disconnect to settle this request.";
    }
  }

  close(requestId: string): void {
    const tab = this.tabs.get(requestId);
    if (!tab || tab.closed) return;
    tab.closed = true;
    tab.unread = false;
    if (this.sources.get(tab.sourceSessionId)?.selected === requestId) this.sources.get(tab.sourceSessionId)!.selected = null;
    if (tab.nativePending && (tab.state === "sending" || tab.state === "running")) {
      this.options.send({ type: "session.btw.cancel", clientId: this.options.clientId, requestId });
    }
    this.release(tab);
    // The hidden record retains only ownership/cleanup state, not the answer.
    tab.question = "";
    tab.answer = "";
    tab.focus = null;
    if (!tab.nativePending) this.tabs.delete(requestId);
    this.options.changed();
  }

  interrupt(source?: string): void {
    if (!source) this.generation += 1;
    for (const tab of this.tabs.values()) {
      if (source && tab.sourceSessionId !== source) continue;
      if (source && tab.nativePending) this.release(tab);
      if (tab.state === "sending" || tab.state === "running") {
        tab.state = "interrupted";
        tab.error = source ? "Source session stopped or changed. This answer is incomplete." : "Connection lost. This answer is incomplete; it will not resume.";
        this.options.failed(tab.requestId);
      }
      if (!source) {
        tab.nativePending = false;
        tab.releasing = false;
        tab.cleanupError = null;
        if (tab.closed) this.tabs.delete(tab.requestId);
      }
    }
  }

  renderSessionBadges(container: HTMLElement, sources: readonly string[]): void {
    const rows = container.querySelectorAll<HTMLElement>(".session-item");
    const counts = new Map<string, { running: number; unread: number }>();
    for (const tab of this.tabs.values()) {
      if (!tab.nativePending && !tab.unread) continue;
      const count = counts.get(tab.sourceSessionId) ?? { running: 0, unread: 0 };
      if (tab.nativePending) count.running += 1;
      if (tab.unread) count.unread += 1;
      counts.set(tab.sourceSessionId, count);
    }
    sources.forEach((source, index) => {
      const row = rows[index];
      if (!row) return;
      const count = counts.get(source);
      let badges = row.querySelector<HTMLElement>(".btw-session-badges");
      if (!count) {
        badges?.remove();
        return;
      }
      if (!badges) {
        badges = container.ownerDocument.createElement("span");
        badges.className = "btw-session-badges";
        row.append(badges);
      }
      badges.textContent = [count.running ? `BTW running ${count.running}` : "", count.unread ? `BTW unread ${count.unread}` : ""].filter(Boolean).join(" · ");
    });
  }

  render(container: HTMLElement, source: string | null, renderMain: (main: HTMLElement) => void): void {
    const visibleTabs = [...this.tabs.values()].filter(tab => tab.sourceSessionId === source && !tab.closed);
    const owner = container.ownerDocument;
    let view = this.views.get(container);
    if (!view) {
      const prefix = `btw-view-${++this.nextViewId}`;
      const main = owner.createElement("div");
      main.className = "btw-conversation";
      main.id = `${prefix}-conversation-panel`;
      main.tabIndex = 0;
      const tablist = owner.createElement("div");
      tablist.className = "btw-tablist";
      tablist.setAttribute("role", "tablist");
      tablist.setAttribute("aria-label", "Transcript conversations");
      const warning = owner.createElement("p");
      warning.setAttribute("role", "status");
      view = { prefix, main, tablist, warning, tabs: new Map(), sides: new Map(), source: null };
      this.views.set(container, view);
      main.addEventListener("scroll", () => {
        const current = view!.source ? this.sources.get(view!.source) : undefined;
        if (current && !main.hidden) current.mainScroll = main.scrollTop;
      });
      main.addEventListener("focusin", () => {
        const current = view!.source ? this.sources.get(view!.source) : undefined;
        if (current) current.mainFocus = main.ownerDocument.activeElement as HTMLElement | null;
      });
    }
    container.classList.add("btw-transcript");
    let state = source ? this.sources.get(source) : undefined;
    if (source && !state) {
      state = { selected: null, mainScroll: null, mainFocus: null, sendBlocked: false };
      this.sources.set(source, state);
    }
    const sourceChanged = view.source !== source;
    const mainWasHidden = view.main.hidden;
    // A display:none element has no scroll box. Never replace saved position
    // with its zero reading; restore only after the destination is visible.
    if (view.source && !mainWasHidden) {
      const previous = this.sources.get(view.source);
      if (previous) previous.mainScroll = view.main.scrollTop;
    }
    for (const [id, existing] of view.sides) {
      const tab = this.tabs.get(id);
      if (tab && existing.panel.isConnected && !existing.panel.hidden) tab.scroll = existing.panel.scrollTop;
    }
    view.source = source;
    const selected = state?.selected ?? null;
    const hasTabs = visibleTabs.length > 0;
    view.tablist.hidden = !hasTabs;
    view.main.hidden = selected !== null;
    // Stable from the first render: transcript caches and tool disclosures keep
    // their owning container when the first side question is opened.
    renderMain(view.main);
    if (hasTabs) {
      view.main.setAttribute("role", "tabpanel");
      view.main.setAttribute("aria-labelledby", `${view.prefix}-conversation-tab`);
    } else {
      view.main.removeAttribute("role");
      view.main.removeAttribute("aria-labelledby");
    }
    const entries = [{ id: "conversation", title: "Conversation", tab: undefined as BtwTab | undefined },
      ...visibleTabs.map(tab => ({ id: tab.requestId, title: tab.question.replace(/\s+/gu, " ").trim(), tab }))];
    const desired: HTMLElement[] = [];
    for (const entry of entries) {
      let controls = view.tabs.get(entry.id);
      if (!controls) {
        const wrapper = owner.createElement("div");
        wrapper.className = "btw-tab";
        const button = owner.createElement("button");
        button.type = "button";
        button.setAttribute("role", "tab");
        const badge = owner.createElement("span");
        badge.className = "btw-tab-badge";
        wrapper.append(button, badge);
        if (entry.tab) {
          const close = owner.createElement("button");
          close.type = "button";
          close.className = "btw-tab-close";
          close.textContent = "×";
          close.setAttribute("aria-label", `Close ${entry.title}`);
          close.addEventListener("click", () => {
            this.close(entry.id);
            if (view!.tablist.hidden) view!.main.focus({ preventScroll: true });
            else view!.tablist.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
          });
          wrapper.append(close);
        }
        button.addEventListener("keydown", event => {
          const buttons = [...view!.tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const index = buttons.indexOf(button);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowRight" ? (index + 1) % buttons.length
            : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : -1;
          if (next < 0) return;
          event.preventDefault();
          buttons[next].click();
          buttons[next].focus();
        });
        controls = { wrapper, button, badge };
        view.tabs.set(entry.id, controls);
      }
      controls.button.onclick = () => this.select(container, source!, entry.tab?.requestId ?? null);
      const active = entry.tab ? selected === entry.id : selected === null;
      controls.button.textContent = entry.tab ? `BTW: ${entry.title}` : entry.title;
      controls.button.title = entry.title;
      controls.button.id = `${view.prefix}-${entry.id}-tab`;
      controls.button.setAttribute("aria-label", entry.tab ? `BTW: ${entry.tab.question}` : "Conversation");
      controls.button.setAttribute("aria-selected", String(active));
      controls.button.setAttribute("aria-controls", `${view.prefix}-${entry.id}-panel`);
      controls.button.tabIndex = active ? 0 : -1;
      controls.badge.textContent = entry.tab?.unread ? "Unread" : entry.tab?.nativePending
        ? entry.tab.cleanupError ? "Cleanup failed" : entry.tab.releasing ? "Releasing" : "Running" : "";
      desired.push(controls.wrapper);
    }
    reconcileChildren(view.tablist, desired);
    for (const id of view.sides.keys()) if (!this.tabs.has(id) || this.tabs.get(id)!.closed) view.sides.delete(id);
    for (const id of view.tabs.keys()) if (id !== "conversation" && (!this.tabs.has(id) || this.tabs.get(id)!.closed)) view.tabs.delete(id);
    const cleanup = [...this.tabs.values()].find(tab => tab.sourceSessionId === source && tab.cleanupError);
    view.warning.hidden = !cleanup && !state?.sendBlocked;
    view.warning.className = cleanup ? "btw-notice btw-cleanup-warning" : "btw-notice btw-send-warning";
    view.warning.textContent = cleanup
      ? `Side-question cleanup failed: ${cleanup.cleanupError} Reconnect to settle cleanup; new side questions are blocked.`
      : state?.sendBlocked ? "Return to Conversation before sending to the main agent. Your draft is kept." : "";
    const panels: HTMLElement[] = [];
    let selectedSide: SideView | undefined;
    let scrollToEnd = false;
    for (const tab of visibleTabs) {
      let side = view.sides.get(tab.requestId);
      if (!side) {
        const panel = owner.createElement("section");
        panel.className = "btw-side";
        panel.id = `${view.prefix}-${tab.requestId}-panel`;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `${view.prefix}-${tab.requestId}-tab`);
        panel.tabIndex = 0;
        panel.addEventListener("scroll", () => { if (!panel.hidden) tab.scroll = panel.scrollTop; });
        panel.addEventListener("focusin", () => { tab.focus = panel.ownerDocument.activeElement as HTMLElement | null; });
        const back = owner.createElement("button");
        back.type = "button";
        back.textContent = "Back to conversation";
        back.addEventListener("click", () => this.select(container, tab.sourceSessionId, null));
        const explanation = owner.createElement("p");
        explanation.className = "btw-explanation";
        explanation.textContent = BTW_EXPLANATION;
        explanation.title = BTW_TOOLTIP;
        const question = owner.createElement("h3");
        question.textContent = tab.question;
        const status = owner.createElement("p");
        status.setAttribute("role", "status");
        const answer = owner.createElement("div");
        answer.className = "btw-answer";
        const copy = owner.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy answer";
        copy.addEventListener("click", async () => {
          copy.textContent = await copyTextToClipboard(tab.answer, panel.ownerDocument) ? "Copied" : "Copy failed";
        });
        panel.append(back, explanation, question, status, answer, copy);
        side = { panel, status, answer, copy, renderedAnswer: null };
        view.sides.set(tab.requestId, side);
      }
      const active = selected === tab.requestId;
      const nearBottom = !side.panel.hidden && side.panel.scrollHeight - side.panel.scrollTop - side.panel.clientHeight < 120;
      side.panel.hidden = !active;
      side.status.textContent = tab.error ?? ({ sending: "Sending…", running: "Answering…", completed: "Completed", cancelled: "Cancelled — incomplete answer", error: "Failed", interrupted: "Interrupted" }[tab.state]);
      if (side.renderedAnswer !== tab.answer) {
        setRenderDocument(owner);
        side.answer.replaceChildren(renderMarkdown(tab.answer));
        side.renderedAnswer = tab.answer;
        if (active) scrollToEnd = nearBottom;
      }
      side.copy.disabled = !tab.answer;
      panels.push(side.panel);
      if (active) selectedSide = side;
    }
    reconcileChildren(container, [view.tablist, view.warning, view.main, ...panels]);
    if (!view.main.hidden && (sourceChanged || mainWasHidden) && state?.mainScroll !== null && state?.mainScroll !== undefined) {
      view.main.scrollTop = state.mainScroll;
    }
    if (selectedSide && selected) {
      const tab = this.tabs.get(selected)!;
      selectedSide.panel.scrollTop = scrollToEnd ? selectedSide.panel.scrollHeight : tab.scroll;
      tab.scroll = selectedSide.panel.scrollTop;
    }
  }

  private select(container: HTMLElement, source: string, requestId: string | null): void {
    const state = this.sources.get(source);
    const view = this.views.get(container);
    if (!state || !view) return;
    if (state.selected === null) {
      state.mainScroll = view.main.scrollTop;
      const active = container.ownerDocument.activeElement as HTMLElement | null;
      if (active && view.main.contains(active)) state.mainFocus = active;
    }
    state.selected = requestId;
    state.sendBlocked = false;
    if (requestId) this.tabs.get(requestId)!.unread = false;
    this.options.changed();
    if (requestId === null) {
      if (state.mainScroll !== null) view.main.scrollTop = state.mainScroll;
      if (state.mainFocus?.isConnected && state.mainFocus.ownerDocument === container.ownerDocument) state.mainFocus.focus({ preventScroll: true });
      else view.main.focus({ preventScroll: true });
    } else {
      const focus = this.tabs.get(requestId)?.focus;
      if (focus?.isConnected && focus.ownerDocument === container.ownerDocument) focus.focus({ preventScroll: true });
    }
  }
}
