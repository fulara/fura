import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";

const messages = [];
const models = [
  {
    id: "mock-model",
    name: "Mock Model",
    api: "anthropic",
    provider: "mock",
    baseUrl: "https://mock.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "mock-reasoner",
    name: "Mock Reasoner",
    api: "anthropic",
    provider: "mock",
    baseUrl: "https://mock.local",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 1000000,
    maxTokens: 32000,
    thinking: { efforts: ["low", "medium", "high"] },
  },
  {
    id: "tiny",
    name: "Tiny Fast Mock",
    api: "openai-responses",
    provider: "local",
    baseUrl: "http://localhost:1234",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 4096,
  },
];
let currentModel = models[0];
const processSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let currentSessionId = `mock-session-${processSeed}`;
let currentSessionFile = `${currentSessionId}.jsonl`;
let currentSessionName = "Mock RPC Session";
let forkCount = 0;
let planExecutionCount = 0;
let planMode = null;
let hostTools = [];
let activeTools = [];
const todoPhases = [
  {
    name: "Mock Verification",
    tasks: [
      { content: "Confirm todo projection", status: "completed" },
      { content: "Keep current todos visible", status: "in_progress", notes: ["Rendered from get_state.todoPhases"] },
    ],
  },
];
const mockImageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const diffSnapshots = [
  {
    entryId: "snap-session-start",
    label: "session-start",
    kind: "session-start",
    createdAt: "2026-04-29T00:00:00.000Z",
    repoRoot: "/mock/repo",
  },
];
function write(frame) {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function success(command, data = {}) {
  write({ id: command.id, type: "response", command: command.type, success: true, data });
}

function error(command, message) {
  write({ id: command.id, type: "response", command: command.type, success: false, error: message });
}

write({ type: "ready" });
stderr.write("mock rpc child ready\n");

const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;

  let command;
  try {
    command = JSON.parse(line);
  } catch (err) {
    write({ type: "error", message: `invalid json: ${err.message}` });
    continue;
  }

  switch (command.type) {
    case "get_state": {
      success(command, {
        model: currentModel,
        thinkingLevel: undefined,
        sessionId: currentSessionId,
        sessionFile: currentSessionFile,
        sessionName: currentSessionName,
        planMode,
        todoPhases,
      });
      break;
    }
    case "set_plan_mode": {
      planMode = command.enabled
        ? {
            enabled: true,
            planFilePath: command.planFilePath ?? "local://PLAN.md",
            workflow: command.workflow ?? "parallel",
          }
        : null;
      success(command, { planMode });
      break;
    }
    case "approve_plan_mode": {
      planMode = null;
      planExecutionCount += 1;
      currentSessionId = `mock-session-plan-execution-${planExecutionCount}-${processSeed}`;
      currentSessionFile = `${currentSessionId}.jsonl`;
      success(command, { finalPlanFilePath: command.finalPlanFilePath });
      break;
    }
    case "get_messages": {
      success(command, { messages });
      break;
    }
    case "get_available_models": {
      success(command, { models });
      break;
    }
    case "set_model": {
      const nextModel = models.find(model => model.provider === command.provider && model.id === command.modelId);
      if (!nextModel) {
        error(command, `Model not found: ${command.provider}/${command.modelId}`);
        break;
      }
      currentModel = nextModel;
      success(command, currentModel);
      break;
    }
    case "cycle_model": {
      const currentIndex = models.findIndex(model => model === currentModel);
      currentModel = models[(currentIndex + 1) % models.length];
      success(command, { model: currentModel, thinkingLevel: undefined, isScoped: false });
      break;
    }
    case "fork": {
      forkCount += 1;
      currentSessionId = `mock-session-fork-${forkCount}-${processSeed}`;
      currentSessionFile = `${currentSessionId}.jsonl`;
      currentSessionName = `Mock RPC Fork ${forkCount}`;
      success(command, { cancelled: false });
      break;
    }
    case "set_session_name": {
      currentSessionName = String(command.name ?? "").trim() || currentSessionName;
      success(command, { name: currentSessionName });
      break;
    }
    case "set_host_tools": {
      hostTools = Array.isArray(command.tools) ? command.tools : [];
      success(command, { toolNames: hostTools.map(tool => tool.name).filter(Boolean) });
      break;
    }
    case "set_active_tools": {
      activeTools = Array.isArray(command.toolNames) ? command.toolNames : [];
      success(command, { toolNames: activeTools });
      break;
    }
    case "host_tool_result": {
      // The deterministic mock does not need tool results to continue; real OMP does.
      break;
    }
    case "prompt": {
      if (String(command.message ?? "").includes("Fura Controller")) {
        const now = Date.now();
        success(command);
        write({ type: "agent_start", timestamp: now });
        const userRequest = String(command.message ?? "").split("User request:").pop() ?? "";
        const wantsOpen = /open|select/i.test(userRequest);
        if (wantsOpen) {
          write({
            type: "host_tool_call",
            id: `mock-host-${now}` ,
            toolCallId: `mock-tool-${now}`,
            toolName: "fura_select_session",
            arguments: { sessionId: currentSessionId },
          });
        } else {
          write({
            type: "host_tool_call",
            id: `mock-host-${now}` ,
            toolCallId: `mock-tool-${now}`,
            toolName: "fura_reply",
            arguments: {
              message: "I found one mock session that matches.",
              candidates: [
                {
                  type: "session",
                  candidateId: "session-1",
                  sessionId: currentSessionId,
                  title: currentSessionName,
                  cwd: "/mock/repo",
                  timestamp: "2026-04-29T00:00:00.000Z",
                  status: "idle",
                  kind: "managed",
                  reason: "matched mock session",
                  snippets: ["Mock assistant received prompts in this session."],
                },
              ],
              suggestedActions: [],
            },
          });
        }
        write({ type: "agent_end", timestamp: now + 1 });
        break;
      }
      const now = Date.now();
      const promptText = String(command.message ?? "");
      const userContent = [];
      if (promptText) userContent.push({ type: "text", text: promptText });
      for (const image of Array.isArray(command.images) ? command.images : []) {
        if (!image || typeof image !== "object") continue;
        if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
        const content = { type: "image", data: image.data, mimeType: image.mimeType };
        if (typeof image.alt === "string" && image.alt.trim()) content.alt = image.alt.trim();
        userContent.push(content);
      }
      if (userContent.length === 0) userContent.push({ type: "text", text: promptText });
      const user = {
        id: `user-${now}`,
        role: "user",
        content: userContent,
        timestamp: now,
      };
      if (promptText.toLowerCase().includes("generate_image") || promptText.toLowerCase().includes("mock image")) {
        const toolCallId = `mock-generate-image-${now}`;
        const assistant = {
          id: `assistant-${now + 1}`,
          role: "assistant",
          content: [{ type: "text", text: "Mock generated one image." }],
          timestamp: now + 2,
        };
        messages.push(user, assistant);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({
          type: "tool_execution_start",
          timestamp: now + 1,
          toolCallId,
          toolName: "generate_image",
          args: { subject: "mock image fixture" },
          intent: "generating mock image",
        });
        write({
          type: "tool_execution_end",
          timestamp: now + 2,
          toolCallId,
          toolName: "generate_image",
          result: {
            content: [{ type: "text", text: "Provider: mock\nModel: mock-image\nGenerated 1 image(s):\n  mock://generated-image.png" }],
            details: {
              provider: "mock",
              model: "mock-image",
              imageCount: 1,
              imagePaths: ["mock://generated-image.png"],
              images: [{ data: mockImageData, mimeType: "image/png", alt: "Mock generated image" }],
            },
          },
          isError: false,
        });
        write({ type: "message_end", timestamp: now + 3, message: assistant });
        write({ type: "agent_end", timestamp: now + 4 });
        break;
      }

      if (promptText.toLowerCase().includes("mock broken mermaid")) {
        const assistant = {
          id: `assistant-${now + 1}`,
          role: "assistant",
          content: [{ type: "text", text: "Here is a broken Mermaid diagram for local renderer testing.\n\n```mermaid\ngraph TD\n  A -->\n```" }],
          timestamp: now + 1,
        };
        messages.push(user, assistant);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({ type: "message_end", timestamp: now + 1, message: assistant });
        write({ type: "agent_end", timestamp: now + 2 });
        break;
      }

      if (promptText.toLowerCase().includes("mock mermaid")) {
        const assistant = {
          id: `assistant-${now + 1}`,
          role: "assistant",
          content: [{ type: "text", text: "Here is a local Mermaid diagram.\n\n```mermaid\nflowchart TD\n  Agent[OMP agent] -->|fenced source| Fura[Fura browser]\n  Fura -->|local render| Preview[SVG preview]\n  Preview --> Export[SVG/PNG export]\n```" }],
          timestamp: now + 1,
        };
        messages.push(user, assistant);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({ type: "message_end", timestamp: now + 1, message: assistant });
        write({ type: "agent_end", timestamp: now + 2 });
        break;
      }

      const assistant = {
        id: `assistant-${now + 1}`,
        role: "assistant",
        content: [{ type: "text", text: `Mock assistant received ${promptText.length} bytes.` }],
        timestamp: now + 1,
      };
      messages.push(user, assistant);
      success(command);
      write({ type: "agent_start", timestamp: now });
      write({ type: "message_end", timestamp: now + 1, message: assistant });
      write({ type: "agent_end", timestamp: now + 2 });
      break;
    }
    case "abort": {
      success(command);
      write({ type: "agent_end", timestamp: Date.now() });
      break;
    }
    case "repo_diff_get": {
      const selector = command.selector ?? diffSnapshots.at(-1)?.entryId ?? null;
      const selectedSnapshot = diffSnapshots.find(snapshot => snapshot.entryId === selector) ?? diffSnapshots.at(-1) ?? null;
      const headSelector = command.headSelector ?? null;
      const headSnapshot = headSelector
        ? diffSnapshots.find(snapshot => snapshot.entryId === headSelector) ?? null
        : null;
      const diff = !selectedSnapshot
        ? ""
        : headSnapshot
          ? `diff --git a/mock.ts b/mock.ts\n@@ -1 +1 @@\n-console.log('${selectedSnapshot.label}')\n+console.log('${headSnapshot.label}')\n`
          : "diff --git a/mock.ts b/mock.ts\n@@ -1 +1 @@\n-console.log('old')\n+console.log('new')\n";
      success(command, {
        snapshots: diffSnapshots,
        selectedSnapshot,
        headSnapshot,
        diff,
        stat: Boolean(command.stat),
      });
      break;
    }
    case "repo_diff_snapshot": {
      const snapshot = {
        entryId: `snap-${diffSnapshots.length + 1}`,
        label: command.label ?? `snapshot-${diffSnapshots.length + 1}`,
        kind: "manual",
        createdAt: new Date().toISOString(),
        repoRoot: "/mock/repo",
      };
      diffSnapshots.push(snapshot);
      success(command, {
        snapshots: diffSnapshots,
        selectedSnapshot: snapshot,
        headSnapshot: null,
        diff: "",
        stat: false,
      });
      break;
    }

    default: {
      if (command.type) {
        success(command, { echoedType: command.type });
      } else {
        error(command, "command is missing type");
      }
      break;
    }
  }
}
