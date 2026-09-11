// Synthetic RPC producer for restart tests. Only the owned fixture journal is
// appended; this is not a real OMP/model implementation.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync(process.env.FURA_RECENCY_FIXTURE_ROOT);
const resumeIndex = process.argv.indexOf("--resume");
if (resumeIndex < 0) throw new Error("recency fixture requires an owned --resume file");
const sessionFile = fs.realpathSync(process.argv[resumeIndex + 1]);
const relative = path.relative(path.join(root, "sessions"), sessionFile);
if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("journal is outside fixture session root");
const entries = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
let parentId = entries.at(-1)?.id ?? null;
if (entries.at(-1)?.type === "session") parentId = null;
const child = spawn(process.execPath, [fileURLToPath(new URL("./mock-omp-rpc.mjs", import.meta.url)), ...process.argv.slice(2)], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "response" && frame.command === "get_state" && frame.success) {
    frame.data.sessionName = entries[0].title;
  }
  if (frame.type === "message_end" && ["user", "assistant"].includes(frame.message?.role)) {
    const id = randomUUID();
    fs.appendFileSync(sessionFile, JSON.stringify({
      type: "message", id, parentId, timestamp: new Date().toISOString(), message: frame.message,
    }) + "\n");
    parentId = id;
  }
  process.stdout.write(JSON.stringify(frame) + "\n");
});
child.on("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
