import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";

const messages = [
  {
    role: "custom",
    customType: "async-result",
    content: "<system-notice>\nBackground job mock-bootstrap-job has completed. Resume work using its private result.\n</system-notice>",
    display: true,
    attribution: "agent",
    details: {
      jobs: [{ jobId: "mock-bootstrap-job", type: "task", label: "Mock bootstrap", durationMs: 1250 }],
    },
    timestamp: Date.now(),
  },
];
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
let currentThinkingLevel = undefined;
const processSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// Honor `--resume <file>` like real OMP so get_state returns the same session id the bridge
// opened — otherwise the bridge remaps to a fresh id and the attached client desyncs.
const resumeArgIndex = process.argv.indexOf("--resume");
const resumeFile = resumeArgIndex >= 0 ? process.argv[resumeArgIndex + 1] : undefined;
const resumedSessionId = resumeFile
  ? resumeFile.match(/_([0-9a-fA-F-]{36})\.jsonl$/)?.[1]
    ?? resumeFile.split("/").pop()?.replace(/\.jsonl$/, "")
  : undefined;
let currentSessionId = resumedSessionId ?? `mock-session-${processSeed}`;
let currentSessionFile = resumeFile ?? `${currentSessionId}.jsonl`;
let currentSessionName = "Mock RPC Session";
let forkCount = 0;
let planExecutionCount = 0;
let planMode = null;
let isCompacting = false;
let goalMode = {
  enabled: true,
  mode: "active",
  goal: {
    id: `mock-goal-${processSeed}`,
    objective: "Keep the mock Fura session aligned with OMP Goal Mode.",
    status: "active",
    tokenBudget: 50000,
    tokensUsed: 3200,
    timeUsedSeconds: 180,
    createdAt: Date.now() - 180000,
    updatedAt: Date.now(),
  },
};
let hostTools = [];
let activeTools = [];
const todoPhases = [
  {
    name: "Mock Verification",
    tasks: [
      { content: "Confirm todo projection", status: "completed" },
      { content: "Keep current todos visible", status: "in_progress", notes: ["Rendered from get_state.todoPhases"] },
      { content: "Wait for upstream paged history", status: "blocked", blocker: "mock v2 cursor" },
    ],
  },
];
const mockImageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const mockSnapshotCommit = "1111111111111111111111111111111111111111";
const mockSnapshotHeadCommit = "2222222222222222222222222222222222222222";


const diffSnapshots = [
  {
    entryId: "snap-session-start",
    label: "session-start",
    kind: "session-start",
    createdAt: "2026-04-29T00:00:00.000Z",
    repoRoot: "/mock/repo",
    ref: "refs/omp/diff-snapshots/snap-session-start",
    sourceRef: "HEAD",
    commit: mockSnapshotCommit,
    headCommit: mockSnapshotHeadCommit,
  },
];

const availableCommands = [
  { name: "help", aliases: [], description: "Show Fura command help", subcommands: [], source: "builtin" },
  { name: "model", aliases: ["models"], description: "Select model", input: { hint: "[provider/model]" }, subcommands: [], source: "builtin" },
  { name: "tools", aliases: [], description: "Show tools visible to the agent", subcommands: [], source: "builtin" },
  { name: "skill:develop-fura", aliases: [], description: "Run the develop-fura skill", subcommands: [], source: "skill" },
  { name: "review", aliases: [], description: "MCP review prompt", subcommands: [], source: "mcp_prompt" },
];
function write(frame) {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function success(command, data = {}) {
  write({ id: command.id, type: "response", command: command.type, success: true, data });
}

function stats() {
  return {
    tokens: { total: Math.max(1, messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0)) },
    cost: { total: 0 },
    messages: { total: messages.length },
  };
}

function error(command, message) {
  write({ id: command.id, type: "response", command: command.type, success: false, error: message });
}

write({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
write({ type: "available_commands_update", commands: availableCommands });
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
    case "negotiate_protocol": {
      if (command.protocolVersion === 2) {
        success(command, { protocolVersion: 2 });
      } else {
        error(command, `unsupported protocol version: ${command.protocolVersion}`);
      }
      break;
    }
    case "get_state": {
      success(command, {
        model: currentModel,
        thinkingLevel: currentThinkingLevel,
        sessionId: currentSessionId,
        sessionFile: currentSessionFile,
        sessionName: currentSessionName,
        planMode,
        goalMode,
        todoPhases,
        isCompacting,
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
    case "goal_mode": {
      const now = Date.now();
      if (command.op === "create") {
        const objective = String(command.objective ?? "").trim();
        if (!objective) {
          error(command, "objective is required when op=create");
          break;
        }
        goalMode = {
          enabled: true,
          mode: "active",
          goal: {
            id: `mock-goal-${now}`,
            objective,
            status: "active",
            tokenBudget: command.tokenBudget,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: now,
            updatedAt: now,
          },
        };
      } else if (command.op === "pause") {
        if (goalMode?.goal) {
          goalMode = { ...goalMode, enabled: false, goal: { ...goalMode.goal, status: "paused", updatedAt: now } };
        }
      } else if (command.op === "resume") {
        if (goalMode?.goal) {
          goalMode = { ...goalMode, enabled: true, mode: "active", reason: undefined, goal: { ...goalMode.goal, status: "active", updatedAt: now } };
        }
      } else if (command.op === "drop") {
        goalMode = null;
      } else if (command.op === "set_budget") {
        if (goalMode?.enabled && goalMode.goal) {
          goalMode = { ...goalMode, goal: { ...goalMode.goal, tokenBudget: command.tokenBudget, updatedAt: now } };
        }
      }
      success(command, { goalMode });
      write({ type: "goal_updated", goal: goalMode?.goal ?? null, state: goalMode ?? undefined });
      break;
    }
    case "approve_plan_mode": {
      planMode = null;
      const contextPreserved = command.preserveContext === true;
      if (!contextPreserved) {
        planExecutionCount += 1;
        currentSessionId = `mock-session-plan-execution-${planExecutionCount}-${processSeed}`;
        currentSessionFile = `${currentSessionId}.jsonl`;
      }
      success(command, {
        finalPlanFilePath: command.finalPlanFilePath,
        contextPreserved,
        compactionOutcome: command.compactBeforeExecute === true ? "ok" : undefined,
        executionDispatched: true,
      });
      break;
    }
    case "get_messages": {
      success(command, { messages });
      break;
    }
    case "get_messages_page": {
      const limit = Number.isFinite(command.limit) ? Math.max(1, Math.min(256, Math.trunc(command.limit))) : 256;
      const offset = command.cursor ? Number.parseInt(String(command.cursor), 10) : 0;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
      const page = messages.slice(safeOffset, safeOffset + limit);
      const nextOffset = safeOffset + page.length;
      success(command, {
        messages: page,
        nextCursor: nextOffset < messages.length ? String(nextOffset) : undefined,
        totalMessages: messages.length,
      });
      break;
    }
    case "get_session_stats": {
      success(command, stats());
      break;
    }
    case "get_available_models": {
      success(command, { models });
      break;
    }
    case "get_available_commands": {
      success(command, { commands: availableCommands });
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
    case "set_thinking_level": {
      const level = String(command.level ?? "");
      const validLevels = ["off", "minimal", "low", "medium", "high", "inherit"];
      if (!validLevels.includes(level)) {
        error(command, `Invalid thinking level: ${level}`);
        break;
      }
      currentThinkingLevel = level === "inherit" ? undefined : level;
      success(command, { thinkingLevel: currentThinkingLevel });
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
      const slashMessage = String(command.message ?? "");
      if (slashMessage.startsWith("/")) {
        // Server-side slash execution: echo a command_output frame, no model turn.
        success(command);
        write({ type: "command_output", text: `Mock command output for ${slashMessage.trim()}` });
        break;
      }
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
      if (planMode?.enabled && promptText.toLowerCase().includes("smoke plan")) {
        messages.push(user);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({
          type: "plan_review",
          sessionId: currentSessionId,
          planFilePath: planMode.planFilePath ?? "local://PLAN.md",
          finalPlanFilePath: "local://SMOKE_PLAN.md",
          title: "SMOKE_PLAN",
          content: "# Smoke Plan\n\n- Verify browser smoke plan review.",
        });
        write({ type: "agent_end", timestamp: now + 1 });
        break;
      }

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
      if (promptText.toLowerCase().includes("mock edit")) {
        const editToolCallId = `mock-edit-${now}`;
        const bashToolCallId = `mock-bash-${now}`;
        const editDiff = [
          "--- a/src/main.rs",
          "+++ b/src/main.rs",
          "@@ -1,4 +1,5 @@",
          " fn main() {",
          '-    println!("hello");',
          '+    println!("hello, fura!");',
          '+    println!("mock edit fixture");',
          " }",
        ].join("\n");
        const bashOutput = Array.from({ length: 12 }, (_, i) => `Checking crate segment ${i + 1} of 12`).join("\n");
        // Persist the same toolCall + toolResult pairs that real OMP writes to
        // the session log, so a post-agent get_messages refresh rebuilds the
        // edit/bash cards instead of dropping them.
        const editToolCallAssistant = {
          id: `assistant-tc-edit-${now}`,
          role: "assistant",
          content: [{ type: "toolCall", id: editToolCallId, name: "edit", arguments: { path: "src/main.rs" }, intent: "updating the greeting" }],
          timestamp: now + 1,
        };
        const editToolResult = {
          id: `toolresult-edit-${now}`,
          role: "toolResult",
          toolCallId: editToolCallId,
          toolName: "edit",
          content: [{ type: "text", text: "Edited src/main.rs" }],
          details: { path: "src/main.rs", diff: editDiff, firstChangedLine: 2 },
          timestamp: now + 2,
        };
        const bashToolCallAssistant = {
          id: `assistant-tc-bash-${now}`,
          role: "assistant",
          content: [{ type: "toolCall", id: bashToolCallId, name: "bash", arguments: { command: "cargo check" }, intent: "verifying the edit" }],
          timestamp: now + 3,
        };
        const bashToolResult = {
          id: `toolresult-bash-${now}`,
          role: "toolResult",
          toolCallId: bashToolCallId,
          toolName: "bash",
          content: [{ type: "text", text: bashOutput }],
          timestamp: now + 4,
        };
        const assistant = {
          id: `assistant-${now + 1}`,
          role: "assistant",
          content: [{ type: "text", text: "Mock edited one file and ran a command." }],
          timestamp: now + 6,
        };
        messages.push(user, editToolCallAssistant, editToolResult, bashToolCallAssistant, bashToolResult, assistant);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({
          type: "tool_execution_start",
          timestamp: now + 1,
          toolCallId: editToolCallId,
          toolName: "edit",
          args: { path: "src/main.rs" },
          intent: "updating the greeting",
        });
        write({
          type: "tool_execution_end",
          timestamp: now + 2,
          toolCallId: editToolCallId,
          toolName: "edit",
          result: {
            content: [{ type: "text", text: "Edited src/main.rs" }],
            details: { path: "src/main.rs", diff: editDiff, firstChangedLine: 2 },
          },
          isError: false,
        });
        write({
          type: "tool_execution_start",
          timestamp: now + 3,
          toolCallId: bashToolCallId,
          toolName: "bash",
          args: { command: "cargo check" },
          intent: "verifying the edit",
        });
        write({
          type: "tool_execution_end",
          timestamp: now + 4,
          toolCallId: bashToolCallId,
          toolName: "bash",
          result: {
            content: [{ type: "text", text: bashOutput }],
          },
          isError: false,
        });
        write({ type: "message_end", timestamp: now + 5, message: assistant });
        write({ type: "agent_end", timestamp: now + 6 });
        break;
      }
      if (promptText.toLowerCase().includes("mock review")) {
        const toolCallId = `mock-review-task-${now}`;
        const taskArgs = { agent: "reviewer", tasks: [{ description: "Review the diff" }] };
        const reviewDetails = {
          projectAgentsDir: null,
          totalDurationMs: 1800,
          results: [{
            index: 0,
            id: "1-reviewer",
            agent: "reviewer",
            task: "Review the diff",
            exitCode: 0,
            output: "Reviewed src/auth.rs and src/buffer.rs.",
            stderr: "",
            truncated: false,
            durationMs: 1800,
            tokens: 4096,
            extractedToolData: {
              report_finding: [
                {
                  title: "Validate token before authenticating",
                  body: "An empty token authenticates because the guard returns early.\n\n```suggestion\nif token.is_empty() { return Err(AuthError::Empty); }\n```",
                  priority: "P0",
                  confidence: 0.95,
                  file_path: "src/auth.rs",
                  line_start: 42,
                  line_end: 44,
                },
                {
                  title: "Bound the copy length",
                  body: "`memcpy` can write past the buffer when the payload exceeds the cap.",
                  priority: "P2",
                  confidence: 0.6,
                  file_path: "src/buffer.rs",
                  line_start: 88,
                  line_end: 90,
                },
              ],
              yield: [{
                data: {
                  overall_correctness: "incorrect",
                  explanation: "One blocking auth bypass plus a lower-severity buffer bound.",
                  confidence: 0.9,
                },
              }],
            },
          }],
        };
        // Persist the same toolCall + toolResult that real OMP writes to the
        // session log, so a post-agent get_messages refresh rebuilds the task
        // card (and the derived review) instead of dropping it.
        const toolCallAssistant = {
          id: `assistant-tc-${now}`,
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: taskArgs, intent: "reviewing the diff" }],
          timestamp: now + 1,
        };
        const toolResultMessage = {
          id: `toolresult-${now}`,
          role: "toolResult",
          toolCallId,
          toolName: "task",
          content: [{ type: "text", text: "1 reviewer finished." }],
          details: reviewDetails,
          timestamp: now + 2,
        };
        const assistant = {
          id: `assistant-review-${now}`,
          role: "assistant",
          content: [{ type: "text", text: "Mock review complete: one blocking issue found." }],
          timestamp: now + 3,
        };
        messages.push(user, toolCallAssistant, toolResultMessage, assistant);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({
          type: "tool_execution_start",
          timestamp: now + 1,
          toolCallId,
          toolName: "task",
          args: taskArgs,
          intent: "reviewing the diff",
        });
        write({
          type: "tool_execution_end",
          timestamp: now + 2,
          toolCallId,
          toolName: "task",
          result: { content: [{ type: "text", text: "1 reviewer finished." }], details: reviewDetails },
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
      if (promptText.toLowerCase().includes("mock ask")) {
        messages.push(user);
        success(command);
        write({ type: "agent_start", timestamp: now });
        write({
          type: "extension_ui_request",
          id: `mock-ask-${now}`,
          method: "select",
          title: "Pick a color",
          options: ["Red", "Green", "Blue"],
          timeout: 60000,
        });
        // No agent_end: the turn stays open until the user answers the ask.
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
    case "extension_ui_response": {
      const now = Date.now();
      const answer = command.cancelled
        ? "(cancelled)"
        : typeof command.value === "string"
          ? command.value
          : command.confirmed === true
            ? "confirmed"
            : "declined";
      const assistant = {
        id: `assistant-ask-${now}`,
        role: "assistant",
        content: [{ type: "text", text: `Mock assistant recorded your answer: ${answer}.` }],
        timestamp: now,
      };
      messages.push(assistant);
      write({ type: "message_end", timestamp: now, message: assistant });
      write({ type: "agent_end", timestamp: now + 1 });
      break;
    }
    case "compact": {
      // Simulate a real compaction: report in-flight state, then settle after a short delay
      // so the Fura compaction indicator is exercised end-to-end against the smoke fixture.
      isCompacting = true;
      const instructions = typeof command.customInstructions === "string" ? command.customInstructions : null;
      setTimeout(() => {
        isCompacting = false;
        write({
          id: command.id,
          type: "response",
          command: "compact",
          success: true,
          data: {
            compacted: true,
            customInstructions: instructions,
            messagesBefore: messages.length,
            messagesAfter: messages.length,
          },
        });
      }, 1500);
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
      const snapshotNumber = diffSnapshots.length + 1;
      const snapshot = {
        entryId: `snap-${snapshotNumber}`,
        label: command.label ?? `snapshot-${snapshotNumber}`,
        kind: "manual",
        createdAt: new Date().toISOString(),
        repoRoot: command.repoRoot ?? "/mock/repo",
        ref: command.ref ?? `refs/omp/diff-snapshots/snap-${snapshotNumber}`,
        sourceRef: command.sourceRef ?? command.ref ?? "HEAD",
        commit: mockSnapshotHeadCommit,
        headCommit: mockSnapshotHeadCommit,
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
      const type = command.type ? String(command.type) : "<missing>";
      stderr.write(`unsupported mock rpc command: ${type}\n`);
      error(command, `Unsupported mock RPC command: ${type}`);
      break;
    }
  }
}
