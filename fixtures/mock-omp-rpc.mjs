import readline from "node:readline";
import { stdin, stdout, stderr } from "node:process";

const messages = [];

function write(frame) {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function success(command, data = {}) {
  write({ id: command.id, type: "response", command: command.type, status: "success", data });
}

function error(command, message) {
  write({ id: command.id, type: "response", command: command.type, status: "error", error: { message } });
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
        model: "mock-model",
        thinking: false,
        sessionId: "mock-session",
        sessionName: "Mock RPC Session",
      });
      break;
    }
    case "get_messages": {
      success(command, { messages });
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
