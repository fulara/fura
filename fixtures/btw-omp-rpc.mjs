// Fault-injection producer for the isolated BTW browser regression, not OMP or a provider.
// Every journal/control file must belong to the caller's private fixture root.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const root = fs.realpathSync(process.env.FURA_BTW_FIXTURE_ROOT);
const resumeIndex = process.argv.indexOf("--resume");
const sessionFile = resumeIndex >= 0 ? fs.realpathSync(process.argv[resumeIndex + 1]) : null;
if (sessionFile && !sessionFile.startsWith(root + path.sep)) throw new Error("foreign fixture journal");
const entries = sessionFile ? fs.readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse) : [];
let sessionId = entries.find(entry => entry.type === "session")?.id ?? randomUUID();
const originalId = sessionId;
const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
const requests = new Map();
const received = [];
let busy = false;
let compacting = false;
let acceptMode = "normal";
let nextError = null;
let mainText = "";
let mainTimestamp = Date.now();
const model = { id: "btw-fixture", name: "Synthetic BTW fixture", api: "openai-responses", provider: "fixture", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const output = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const success = (command, data = {}) => output({ type: "response", id: command.id, command: command.type, success: true, data });
const error = (command, message) => output({ type: "response", id: command.id, command: command.type, success: false, error: message });
const btw = (btwId, state, fields = {}) => output({ type: "btw_update", btwId, state, ...fields });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, timestamp: mainTimestamp, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function start(command) {
  if (nextError) { error(command, nextError); nextError = null; return; }
  if ([...requests.values()].some(request => request.running)) { error(command, "A BTW request is already running."); return; }
  const request = { command, running: true, accepted: false };
  requests.set(command.btwId, request);
  if (acceptMode === "queued") return;
  btw(command.btwId, "started", { question: command.question });
  if (acceptMode !== "delayed") { request.accepted = true; success(command, { btwId: command.btwId }); }
}
function command(command) {
  received.push(command);
  switch (command.type) {
    case "negotiate_protocol": success(command, { protocolVersion: 2 }); break;
    case "get_state": success(command, { sessionId, sessionFile, sessionName: entries[0]?.title ?? "Fixture", model, isStreaming: busy, isCompacting: compacting, thinkingLevel: "off", todoPhases: [], planMode: null, goalMode: null }); break;
    case "get_messages": success(command, { messages }); break;
    case "get_available_models": success(command, { models: [model] }); break;
    case "get_available_commands": success(command, { commands: [] }); break;
    case "btw_start": start(command); break;
    case "btw_cancel": {
      const request = requests.get(command.btwId);
      if (request) { request.running = false; btw(command.btwId, "cancelled"); }
      success(command, { btwId: command.btwId });
      break;
    }
    case "btw_release": requests.delete(command.btwId); success(command, { btwId: command.btwId }); break;
    case "prompt": {
      success(command);
      busy = true;
      mainText = "";
      mainTimestamp = Date.now();
      const message = { role: "user", content: [{ type: "text", text: command.message }], timestamp: mainTimestamp };
      messages.push(message);
      output({ type: "agent_start" });
      output({ type: "message_end", message });
      output({ type: "message_start", message: assistant("") });
      break;
    }
    case "abort": busy = false; output({ type: "agent_end", isTerminal: true, messages: [] }); success(command); break;
    case "get_session_stats": success(command, {}); break;
    case "get_subagents": success(command, { subagents: [] }); break;
    default: success(command); break;
  }
}
const server = http.createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 1000000) throw new Error("fixture input too large"); }
    const op = body ? JSON.parse(body) : { op: "inspect" };
    switch (op.op) {
      case "mode": acceptMode = op.mode; nextError = op.error ?? null; break;
      case "ack": {
        const item = requests.get(op.id);
        if (item) { item.accepted = true; success(item.command, { btwId: op.id }); }
        break;
      }
      case "side": {
        if (op.state === "completed" || op.state === "error") { const item = requests.get(op.id); if (item) item.running = false; }
        btw(op.id, op.state, op.fields ?? {});
        break;
      }
      case "main": {
        mainText += op.delta ?? "";
        const message = assistant(mainText);
        output({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: op.delta ?? "", partial: message } });
        if (op.complete) { busy = false; messages.push(message); output({ type: "message_end", message }); output({ type: "agent_end", isTerminal: true, messages: [message] }); }
        break;
      }
      case "compact": compacting = op.active; output({ type: op.active ? "auto_compaction_start" : "auto_compaction_end", aborted: false }); break;
      case "rebind": sessionId = op.sessionId; break;
      case "frame": output(op.frame); break;
      case "inspect": break;
      default: throw new Error("unknown fixture control");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sessionId, received, retained: [...requests.keys()], busy }));
  } catch (error) { response.writeHead(400); response.end(String(error)); }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(path.join(root, `control-${originalId}.json`), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid }));
  output({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => { try { command(JSON.parse(line)); } catch (err) { output({ type: "error", message: String(err) }); } });
input.on("close", () => { requests.clear(); server.close(); });
