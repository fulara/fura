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

  it("preserves conflict resolver message shapes", () => {
    const scan = {
      type: "conflict.scan",
      root: "/repo",
    } satisfies ClientMessage;
    const open = {
      type: "conflict.file.open",
      repoId: "/repo",
      path: "src/main.rs",
    } satisfies ClientMessage;
    const previewRequest = {
      type: "conflict.file.previewMagicWand",
      repoId: "/repo",
      path: "src/main.rs",
      expectedVersion: "1:9",
    } satisfies ClientMessage;
    const agentRun = {
      type: "conflict.agent.run",
      sessionId: "conflict-session",
      repoId: "/repo",
      path: "src/main.rs",
      expectedVersion: "1:9",
      mode: "propose",
      scope: "selectedConflict",
      conflictId: "conflict-1",
      instructions: "Resolve only the selected conflict.",
    } satisfies ClientMessage;
    const snapshot = {
      type: "conflict.snapshot",
      repos: [{
        repoId: "/repo",
        root: "/repo",
        operation: "merge",
        files: [{ path: "src/main.rs", kind: "bothModified", supported: true }],
      }],
    } satisfies ServerMessage;
    const preview = {
      type: "conflict.magicWandPreview",
      preview: {
        repoId: "/repo",
        path: "src/main.rs",
        sourceVersion: "1:9",
        content: "resolved\n",
        resolvedConflictCount: 1,
        remainingConflictCount: 0,
        summary: "Resolved 1 conflict block with the magic wand. 0 conflict blocks remain.",
        rules: [{ conflictId: "conflict-1", rule: "identicalSides", summary: "Both sides already contain the same text; kept a single copy." }],
      },
    } satisfies ServerMessage;
    const agentResult = {
      type: "conflict.agentResult",
      result: {
        repoId: "/repo",
        path: "src/main.rs",
        sourceVersion: "1:9",
        mode: "propose",
        scope: "selectedConflict",
        conflictId: "conflict-1",
        risk: "medium",
        summary: "Merged the selected conflict and kept the rest untouched.",
        explanation: "This combines the selected edits and preserves the remaining conflicts for manual review.",
        content: "resolved\n",
        remainingConflictCount: 0,
      },
    } satisfies ServerMessage;
    const write = {
      type: "conflict.file.writeResult",
      repoId: "/repo",
      path: "src/main.rs",
      content: "resolved\n",
      expectedVersion: "1:9",
    } satisfies ClientMessage;
    const status = {
      type: "conflict.status",
      repoId: "/repo",
      path: "src/main.rs",
      state: "staged",
      message: "File marked resolved and staged.",
    } satisfies ServerMessage;
    const stage = {
      type: "conflict.file.stageResolved",
      repoId: "/repo",
      path: "src/main.rs",
      expectedVersion: "1:9",
    } satisfies ClientMessage;

    expect(scan.root).toBe("/repo");
    expect(open.path).toBe("src/main.rs");
    expect(previewRequest.expectedVersion).toBe("1:9");
    expect(snapshot.repos[0]?.files[0]?.kind).toBe("bothModified");
    expect(preview.preview.rules[0]?.rule).toBe("identicalSides");
    expect(write.expectedVersion).toBe("1:9");
    expect(stage.type).toBe("conflict.file.stageResolved");
    expect(status.state).toBe("staged");
    expect(agentRun.scope).toBe("selectedConflict");
    expect(agentResult.result.risk).toBe("medium");
  });
});
