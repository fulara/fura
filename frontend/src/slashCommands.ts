export type SlashCommandSupport = "supported" | "tui-only";

export type SlashCommandSpec = {
  name: string;
  description: string;
  usage?: string;
  support: SlashCommandSupport;
  aliases?: string[];
};

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "help", description: "Show Fura command help", support: "supported" },
  { name: "commands", description: "Alias for /help", support: "supported" },
  { name: "new", description: "Start a new OMP RPC session", support: "supported" },
  { name: "abort", description: "Abort the current prompt", support: "supported" },
  { name: "compact", description: "Compact session context", usage: "[instructions]", support: "supported" },
  { name: "handoff", description: "Hand off session context to a new session", usage: "[focus instructions]", support: "supported" },
  { name: "rename", description: "Rename the current session", usage: "<title>", support: "supported" },
  { name: "model", description: "List, cycle, or select model", usage: "[list|cycle|provider/model]", support: "supported", aliases: ["models"] },
  { name: "thinking", description: "Cycle or set thinking level", usage: "[cycle|off|minimal|low|medium|high|inherit]", support: "supported" },
  { name: "session", description: "Request current session stats", usage: "[info]", support: "supported", aliases: ["status", "usage"] },
  { name: "export", description: "Export session HTML", usage: "[path]", support: "supported" },

  { name: "settings", description: "TUI settings panel", support: "tui-only" },
  { name: "plan", description: "TUI plan-mode toggle", support: "tui-only" },
  { name: "fast", description: "TUI fast-mode toggle", support: "tui-only" },
  { name: "browser", description: "TUI browser mode selector", support: "tui-only" },
  { name: "copy", description: "TUI clipboard helper", support: "tui-only" },
  { name: "dump", description: "TUI transcript copy", support: "tui-only" },
  { name: "share", description: "TUI gist share flow", support: "tui-only" },
  { name: "hotkeys", description: "TUI hotkey help", support: "tui-only" },
  { name: "tools", description: "TUI tools view", support: "tui-only" },
  { name: "extensions", description: "TUI extension dashboard", support: "tui-only", aliases: ["status"] },
  { name: "agents", description: "TUI agent dashboard", support: "tui-only" },
  { name: "branch", description: "TUI branch picker", support: "tui-only" },
  { name: "fork", description: "TUI fork flow", support: "tui-only" },
  { name: "tree", description: "TUI session tree", support: "tui-only" },
  { name: "login", description: "TUI OAuth login flow", support: "tui-only" },
  { name: "logout", description: "TUI OAuth logout flow", support: "tui-only" },
  { name: "mcp", description: "TUI MCP manager", support: "tui-only" },
  { name: "ssh", description: "TUI SSH manager", support: "tui-only" },
  { name: "resume", description: "Use the Fura session list instead", support: "tui-only" },
  { name: "btw", description: "TUI side-question flow", support: "tui-only" },
  { name: "background", description: "TUI background detach", support: "tui-only", aliases: ["bg"] },
  { name: "debug", description: "TUI debug selector", support: "tui-only" },
  { name: "memory", description: "TUI memory maintenance", support: "tui-only" },
  { name: "move", description: "TUI session move flow", support: "tui-only" },
  { name: "exit", description: "TUI exit", support: "tui-only", aliases: ["quit"] },
  { name: "marketplace", description: "TUI marketplace manager", support: "tui-only" },
  { name: "plugins", description: "TUI plugin manager", support: "tui-only" },
  { name: "reload-plugins", description: "TUI plugin reload", support: "tui-only" },
  { name: "force", description: "TUI force tool choice", support: "tui-only" },
];

export function findSlashCommand(input: string): SlashCommandSpec | undefined {
  const match = input.match(/^\/([^\s:]+)/);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return SLASH_COMMANDS.find(cmd => cmd.name === name || cmd.aliases?.includes(name));
}

/** Returns score (lower = better match), null if no match. */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let firstMatchPos = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatchPos === -1) firstMatchPos = ti;
      qi++;
    }
  }
  return qi === q.length ? firstMatchPos : null;
}

export function fuzzyMatchCommands(query: string): SlashCommandSpec[] {
  const scored: { cmd: SlashCommandSpec; score: number }[] = [];
  for (const cmd of SLASH_COMMANDS) {
    const candidates = [cmd.name, ...(cmd.aliases ?? [])];
    let best: number | null = null;
    for (const c of candidates) {
      const s = fuzzyScore(query, c);
      if (s !== null && (best === null || s < best)) best = s;
    }
    if (best !== null) scored.push({ cmd, score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.cmd);
}
