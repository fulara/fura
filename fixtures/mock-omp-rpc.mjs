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
let currentSessionId = "mock-session";
let currentSessionFile = "mock-session.jsonl";
let forkCount = 0;
let planMode = null;
const todoPhases = [
  {
    name: "Mock Verification",
    tasks: [
      { content: "Confirm todo projection", status: "completed" },
      { content: "Keep current todos visible", status: "in_progress", notes: ["Rendered from get_state.todoPhases"] },
    ],
  },
];

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
        sessionName: "Mock RPC Session",
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
      currentSessionId = `mock-session-fork-${forkCount}`;
      currentSessionFile = `${currentSessionId}.jsonl`;
      success(command, { cancelled: false });
      break;
    }
    case "prompt": {
      const user = {
        id: `user-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: command.message ?? "" }],
      };
      const assistant = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: [{ type: "text", text: `Mock assistant received ${String(command.message ?? "").length} bytes.` }],
      };
      messages.push(user, assistant);
      success(command);
      write({ type: "agent_start" });
      write({ type: "message_end", message: assistant });
      write({ type: "agent_end" });
      break;
    }
    case "abort": {
      success(command);
      write({ type: "agent_end" });
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
