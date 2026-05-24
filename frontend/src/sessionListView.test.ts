import { describe, expect, it } from "vitest";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
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

function renderList(options: Partial<Parameters<ReturnType<typeof createSessionListView>["render"]>[0]> = {}) {
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
    expect(buttons[0].querySelector(".session-status")?.textContent).toBe("Ready");
    expect(buttons[0].querySelector(".session-meta")?.textContent).toBe("Mobile · …/repos/fura · Live · 1 msg");
    expect(buttons[1].className).toBe("session has-updates");
    expect(buttons[1].querySelector(".session-status")?.textContent).toBe("Working");
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
