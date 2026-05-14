import { shortId } from "./format";
import { formatSessionMeta, sessionStatusClass, sessionStatusLabel } from "./sessionList";
import type { SessionSummary } from "./protocol";

export type SessionListRenderOptions = {
  sessions: SessionSummary[];
  visibleSessions: SessionSummary[];
  selectedCategoryFilter: string;
  activeSessionId: string | null;
  unreadSessionIds: ReadonlySet<string>;
  sessionGoalLabels?: ReadonlyMap<string, string>;
};

export type SessionListView = {
  render(options: SessionListRenderOptions): void;
  clear(): void;
};

type SessionListViewOptions = {
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
};

type SessionListItemDom = {
  item: HTMLDivElement;
  button: HTMLButtonElement;
  title: HTMLSpanElement;
  status: HTMLSpanElement;
  meta: HTMLSpanElement;
  goal: HTMLSpanElement;
  deleteBtn: HTMLButtonElement;
};

export function createSessionListView(container: HTMLElement, callbacks: SessionListViewOptions): SessionListView {
  const items = new Map<string, SessionListItemDom>();
  let emptyElement: HTMLParagraphElement | null = null;

  function clearItems(): void {
    for (const dom of items.values()) dom.item.remove();
    items.clear();
  }

  function emptyMessage(text: string): void {
    clearItems();
    if (!emptyElement) {
      emptyElement = container.ownerDocument.createElement("p");
      emptyElement.className = "empty";
    }
    emptyElement.textContent = text;
    if (emptyElement.parentNode !== container) container.replaceChildren(emptyElement);
  }

  return {
    render(options) {
      if (options.sessions.length === 0) {
        emptyMessage("No sessions yet.");
        return;
      }

      if (options.visibleSessions.length === 0) {
        emptyMessage(options.selectedCategoryFilter
          ? `No sessions in category ${options.selectedCategoryFilter}.`
          : "No sessions match the current filters.");
        return;
      }

      emptyElement?.remove();

      const nextSessionIds = new Set(options.visibleSessions.map(session => session.sessionId));
      for (const [sessionId, dom] of items) {
        if (!nextSessionIds.has(sessionId)) {
          dom.item.remove();
          items.delete(sessionId);
        }
      }

      let anchor = container.firstChild;
      for (const session of options.visibleSessions) {
        let dom = items.get(session.sessionId);
        if (!dom) {
          dom = createSessionListItem(container.ownerDocument, session.sessionId, callbacks);
          items.set(session.sessionId, dom);
        }

        updateSessionListItem(dom, session, options.activeSessionId, options.unreadSessionIds, options.sessionGoalLabels);
        if (dom.item !== anchor) container.insertBefore(dom.item, anchor);
        anchor = dom.item.nextSibling;
      }

      while (anchor) {
        const next = anchor.nextSibling;
        anchor.remove();
        anchor = next;
      }
    },
    clear() {
      clearItems();
      emptyElement?.remove();
    },
  };
}

function createSessionListItem(
  ownerDocument: Document,
  sessionId: string,
  callbacks: SessionListViewOptions,
): SessionListItemDom {
  const item = ownerDocument.createElement("div");
  item.className = "session-item";

  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.addEventListener("click", () => callbacks.onSelectSession(sessionId));

  const titleRow = ownerDocument.createElement("span");
  titleRow.className = "session-title-row";

  const title = ownerDocument.createElement("span");
  title.className = "session-id";

  const status = ownerDocument.createElement("span");
  const goal = ownerDocument.createElement("span");
  goal.className = "session-goal-badge";

  const meta = ownerDocument.createElement("span");
  meta.className = "session-meta";

  titleRow.append(title, status);
  button.append(titleRow, meta, goal);

  const deleteBtn = ownerDocument.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "session-delete";
  deleteBtn.textContent = "\u00d7";
  deleteBtn.addEventListener("click", event => {
    event.stopPropagation();
    callbacks.onDeleteSession(sessionId);
  });

  item.append(button, deleteBtn);
  return { item, button, title, status, meta, goal, deleteBtn };
}

function updateSessionListItem(
  dom: SessionListItemDom,
  session: SessionSummary,
  activeSessionId: string | null,
  unreadSessionIds: ReadonlySet<string>,
  sessionGoalLabels?: ReadonlyMap<string, string>,
): void {
  const isActive = session.sessionId === activeSessionId;
  const hasUpdates = !isActive && unreadSessionIds.has(session.sessionId);
  const classes = ["session", isActive ? "active" : "", hasUpdates ? "has-updates" : ""].filter(Boolean);
  const label = session.title || shortId(session.sessionId);

  dom.button.className = classes.join(" ");
  dom.button.setAttribute("aria-current", isActive ? "page" : "false");
  dom.title.textContent = label;
  dom.status.className = `session-status session-status-${sessionStatusClass(session)}`;
  dom.status.textContent = sessionStatusLabel(session);
  dom.meta.textContent = formatSessionMeta(session);
  const goalLabel = sessionGoalLabels?.get(session.sessionId) ?? null;
  dom.goal.textContent = goalLabel ?? "";
  dom.goal.hidden = !goalLabel;
  dom.deleteBtn.setAttribute("aria-label", `Delete session ${label}`);
}

export function renderSessionCategoryFilter(
  select: HTMLSelectElement,
  categories: string[],
  selectedCategoryFilter: string,
): string {
  const selected = selectedCategoryFilter && categories.includes(selectedCategoryFilter) ? selectedCategoryFilter : "";
  const currentOptions = Array.from(select.options).map(option => option.value);
  const nextOptions = ["", ...categories];
  if (currentOptions.length !== nextOptions.length || currentOptions.some((value, index) => value !== nextOptions[index])) {
    select.replaceChildren();
    const all = select.ownerDocument.createElement("option");
    all.value = "";
    all.textContent = "All sessions";
    select.append(all);
    for (const category of categories) {
      const option = select.ownerDocument.createElement("option");
      option.value = category;
      option.textContent = category;
      select.append(option);
    }
  }
  select.value = selected;
  return selected;
}
