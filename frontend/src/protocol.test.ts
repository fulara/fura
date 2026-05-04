import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage, SessionProjection } from "./protocol";

const emptyProjection = {
  summary: {
    kind: "managed",
    sessionId: "session-1",
    status: "idle",
    createdAt: 1,
    messageCount: 0,
  },
  transcript: [],
  isBusy: false,
  tokensTotal: 0,
  costUsd: 0,
  todoPhases: [],
} satisfies SessionProjection;

describe("protocol type fixtures", () => {
  it("preserves the session snapshot server message shape", () => {
    const message = {
      type: "session.snapshot",
      sessionId: "session-1",
      state: emptyProjection,
    } satisfies ServerMessage;

    expect(message.type).toBe("session.snapshot");
    expect(message.state.summary.sessionId).toBe("session-1");
  });

  it("preserves prompt send client message shape", () => {
    const message = {
      type: "prompt.send",
      sessionId: "session-1",
      text: "continue",
      behavior: "followUp",
    } satisfies ClientMessage;

    expect(message.type).toBe("prompt.send");
    expect(message.behavior).toBe("followUp");
  });

  it("preserves code viewer message shapes", () => {
    const open = {
      type: "code.workspace.open",
      sessionId: "session-1",
    } satisfies ClientMessage;

    const ready = {
      type: "code.workspace.ready",
      workspace: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        root: "/repo",
        status: "filesOnly",
        source: "session",
      },
    } satisfies ServerMessage;

    expect(open.type).toBe("code.workspace.open");
    expect(ready.workspace.status).toBe("filesOnly");

    const search = {
      type: "code.file.search",
      workspaceId: "workspace-1",
      basePath: "/repo",
      query: "main",
      limit: 20,
    } satisfies ClientMessage;

    const results = {
      type: "code.file.searchResults",
      workspaceId: "workspace-1",
      basePath: "/repo",
      query: "main",
      entries: [{ kind: "file", name: "main.rs", path: "src/main.rs", size: 12 }],
    } satisfies ServerMessage;

    expect(search.query).toBe("main");
    expect(results.entries[0]?.path).toBe("src/main.rs");
  });
});
