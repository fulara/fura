import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage, SessionProjection } from "./protocol";

const emptyProjection = {
  summary: {
    kind: "managed",
    sessionMode: "standard",
    sessionId: "session-1",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
  },
  transcript: [],
  isBusy: false,
  tokensTotal: 0,
  costUsd: 0,
  todoPhases: [],
  seq: 0,
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

  it("preserves the session delta server message shape", () => {
    const message = {
      type: "session.delta",
      sessionId: "session-1",
      state: {
        summary: emptyProjection.summary,
        transcriptReplaceFrom: 0,
        transcriptAppend: [],
        isBusy: false,
        tokensTotal: 0,
        costUsd: 0,
        todoPhases: [],
        baseSeq: 0,
        seq: 1,
      },
    } satisfies ServerMessage;

    expect(message.type).toBe("session.delta");
    expect(message.state.transcriptReplaceFrom).toBe(0);
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

  it("preserves private rollback request and response shapes", () => {
    const list = {
      type: "session.rewind.list",
      sessionId: "session-1",
      requestId: "rewind-list-1",
    } satisfies ClientMessage;
    const select = {
      type: "session.rewind.select",
      sessionId: "session-1",
      requestId: "rewind-select-1",
      entryId: "entry-1",
    } satisfies ClientMessage;
    const result = {
      type: "session.rewind.result",
      requestId: "rewind-select-1",
      sourceSessionId: "session-1",
      sessionId: "session-2",
      text: "[Image 1]",
      images: [{ type: "image", data: "abc", mimeType: "image/png", providerFile: "file-1" }],
      cancelled: false,
    } satisfies ServerMessage;

    expect(list.requestId).toBe("rewind-list-1");
    expect(select.entryId).toBe("entry-1");
    expect(result.images[0]?.providerFile).toBe("file-1");
  });

  it("preserves proposed model config and catalog message shapes", () => {
    const create = {
      type: "session.create",
      requestId: "create-1",
      cwd: "/repo",
      proposedModelId: "fast-review",
    } satisfies ClientMessage;
    const setConfig = {
      type: "config.set",
      proposedModels: [{
        id: "fast-review",
        name: "Fast review",
        provider: "mock",
        modelId: "mock-reasoner",
        modelName: "Mock Reasoner",
        thinkingLevel: "high",
      }],
    } satisfies ClientMessage;
    const catalog = {
      type: "config.modelCatalog.list",
      requestId: "catalog-1",
      models: [{ provider: "mock", id: "mock-reasoner", name: "Mock Reasoner", contextWindow: 1000000, thinking: true }],
    } satisfies ServerMessage;

    expect(create.proposedModelId).toBe("fast-review");
    expect(setConfig.proposedModels?.[0]?.thinkingLevel).toBe("high");
    expect(catalog.models[0]?.id).toBe("mock-reasoner");
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
