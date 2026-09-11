import { describe, expect, it } from "vitest";
import { createSessionListView, renderSessionCategoryFilter, type SessionListRenderOptions } from "./sessionListView";
import type { SessionSummary } from "./protocol";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionMode: "standard",
    sessionId: "session-1abcdef",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

function renderList(options: Partial<SessionListRenderOptions> = {}) {
  const selected: string[] = [];
  const deleted: string[] = [];
  const container = document.createElement("nav");
  const view = createSessionListView(container, {
    onSelectSession: sessionId => selected.push(sessionId),
    onDeleteSession: sessionId => deleted.push(sessionId),
  });
  const sessions = options.sessions ?? [session()];
  view.render({
    sessions,
    visibleSessions: options.visibleSessions ?? sessions,
    selectedCategoryFilter: options.selectedCategoryFilter ?? "",
    activeSessionId: options.activeSessionId ?? null,
    unreadSessionIds: options.unreadSessionIds ?? new Set<string>(),
    sessionGoalLabels: options.sessionGoalLabels,
  });
  return { container, view, selected, deleted };
}

describe("createSessionListView", () => {
  it("renders an empty state before any sessions exist", () => {
    const { container } = renderList({ sessions: [], visibleSessions: [] });

    expect(container.querySelector(".empty")?.textContent).toBe("No sessions yet.");
    expect(container.querySelector("button.session")).toBeNull();
  });

  it("renders a filtered-empty state with the selected category", () => {
    const sessions = [session({ category: "Backend" })];
    const { container } = renderList({ sessions, visibleSessions: [], selectedCategoryFilter: "Mobile" });

    expect(container.querySelector(".empty")?.textContent).toBe("No sessions in category Mobile.");
  });

  it("renders session label, status, metadata, active state, and unread state", () => {
    const sessions = [
      session({ sessionId: "active-session", title: "Active", category: "Mobile", cwd: "/home/aleksander/repos/fura", messageCount: 1 }),
      session({ sessionId: "unread-session", status: "busy", title: "Unread", messageCount: 2 }),
    ];
    const { container } = renderList({
      sessions,
      activeSessionId: "active-session",
      unreadSessionIds: new Set(["unread-session"]),
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.session"));

    expect(buttons).toHaveLength(2);
    expect(buttons[0].className).toBe("session active");
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons[0].querySelector(".session-id")?.textContent).toBe("Active");
    expect(buttons[1].className).toBe("session has-updates");
  });
  it("renders goal badges for sessions with projected goal state", () => {
    const sessions = [session({ sessionId: "goal-session", title: "Goal session" })];
    const { container } = renderList({
      sessions,
      sessionGoalLabels: new Map([["goal-session", "Goal set"]]),
    });

    const badge = container.querySelector(".session-goal-badge");
    expect(badge?.textContent).toBe("Goal set");
    expect(badge?.hasAttribute("hidden")).toBe(false);
  });

  it("wires select and delete callbacks to the session id", () => {
    const { container, selected, deleted } = renderList({ sessions: [session({ sessionId: "session-abc", title: "Named" })] });

    container.querySelector<HTMLButtonElement>("button.session")?.click();
    container.querySelector<HTMLButtonElement>("button.session-delete")?.click();

    expect(selected).toEqual(["session-abc"]);
    expect(deleted).toEqual(["session-abc"]);
    expect(container.querySelector(".session-delete")?.getAttribute("aria-label")).toBe("Delete session Named");
  });

  it("selects on mouse down before a busy rerender can cancel the click", () => {
    const first = session({ sessionId: "session-abc", title: "Named", status: "busy" });
    const updated = session({ sessionId: "session-abc", title: "Named", status: "busy", messageCount: 1 });
    const { container, view, selected } = renderList({ sessions: [first] });
    const button = container.querySelector<HTMLButtonElement>("button.session");
    if (!button) throw new Error("session button missing");

    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    view.render({
      sessions: [updated],
      visibleSessions: [updated],
      selectedCategoryFilter: "",
      activeSessionId: null,
      unreadSessionIds: new Set(),
    });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(selected).toEqual(["session-abc"]);
  });

  it("reorders existing nodes and removes hidden sessions without recreating retained items", () => {
    const first = session({ sessionId: "first-session", title: "First" });
    const second = session({ sessionId: "second-session", title: "Second" });
    const { container, view } = renderList({ sessions: [first, second] });
    const firstNode = container.querySelector<HTMLButtonElement>("button.session")?.parentElement;

    view.render({
      sessions: [second, first],
      visibleSessions: [second],
      selectedCategoryFilter: "",
      activeSessionId: null,
      unreadSessionIds: new Set(),
    });

    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-id")?.textContent).toBe("Second");
    expect(container.querySelector(".session-id")?.closest(".session-item")).not.toBe(firstNode);
  });

  it("exposes distinct statuses and the full Unicode title without relying on color", () => {
    const title = "Żółw — 日本語 — długi tytuł ".repeat(12);
    const sessions = [
      session({ sessionId: "ready", title }),
      session({ sessionId: "working", title, status: "busy" }),
      session({ sessionId: "opening", title, status: "starting" }),
      session({ sessionId: "failed", title, status: "error" }),
      session({ sessionId: "ended", title, status: "exited" }),
      session({ sessionId: "saved", title, kind: "available", status: "available" }),
      session({ sessionId: "answer", title, status: "busy", awaitingAsk: true }),
    ];
    const { container } = renderList({ sessions });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.session")];
    const names = buttons.map(button => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(sessions.length);
    for (const button of buttons) {
      expect(button.getAttribute("aria-label")).toContain(title);
      expect(button.title).toBe(title);
      const status = button.querySelector<HTMLElement>(".session-status")!;
      expect(button.getAttribute("aria-label")).toContain(status.title);
      expect(status.title).not.toBe("");
      expect(status.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("retains focused nodes, scroll and ownerDocument through reordered live updates", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument!;
    const container = foreignDocument.createElement("nav");
    foreignDocument.body.append(container);
    const selected: string[] = [];
    const deleted: string[] = [];
    const view = createSessionListView(container, {
      onSelectSession: id => selected.push(id),
      onDeleteSession: id => deleted.push(id),
    });
    const first = session({ sessionId: "first", title: "First" });
    const second = session({ sessionId: "second", title: "Second" });
    const options = { sessions: [first, second], visibleSessions: [first, second], selectedCategoryFilter: "", activeSessionId: "first", unreadSessionIds: new Set(["second"]) };
    view.render(options);
    const button = container.querySelector<HTMLButtonElement>("button.session")!;
    button.focus();
    expect(foreignDocument.activeElement).toBe(button);
    container.scrollTop = 40;
    view.render({ ...options, sessions: [second, first], visibleSessions: [second, first] });
    expect(container.querySelectorAll("button.session")[1]).toBe(button);
    expect(button.ownerDocument).toBe(foreignDocument);
    expect(foreignDocument.activeElement).toBe(button);
    expect(container.scrollTop).toBe(40);
    button.click();
    button.parentElement!.querySelector<HTMLButtonElement>(".session-delete")!.click();
    expect(selected).toEqual(["first"]);
    expect(deleted).toEqual(["first"]);
    frame.remove();
  });
});

describe("renderSessionCategoryFilter", () => {
  it("renders category options and preserves a valid selected category", () => {
    const select = document.createElement("select");

    const selected = renderSessionCategoryFilter(select, ["Backend", "Mobile"], "Mobile");

    expect(selected).toBe("Mobile");
    expect(Array.from(select.options).map(option => option.value)).toEqual(["", "Backend", "Mobile"]);
    expect(select.value).toBe("Mobile");
    expect(select.options[0]?.textContent).toBe("All sessions");
  });

  it("resets a stale selected category", () => {
    const select = document.createElement("select");

    const selected = renderSessionCategoryFilter(select, ["Backend"], "Mobile");

    expect(selected).toBe("");
    expect(select.value).toBe("");
  });
});
