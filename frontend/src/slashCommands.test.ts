import { describe, expect, it } from "vitest";
import { buildPaletteCommands, findSlashCommand, SLASH_COMMANDS } from "./slashCommands";

describe("slash command registry", () => {
  it("does not advertise /goal in Fura", () => {
    expect(SLASH_COMMANDS.some(command => command.name === "goal")).toBe(false);
    expect(findSlashCommand("/goal")).toBeUndefined();
  });
});

describe("buildPaletteCommands", () => {
  it("merges curated supported commands with non-builtin live extras, excludes builtins and tui-only", () => {
    const live = [
      { name: "tools", aliases: [], subcommands: [], source: "builtin", description: "Show tools" },
      { name: "skill:develop-fura", aliases: [], subcommands: [], source: "skill", description: "Run skill" },
      { name: "review", aliases: [], subcommands: [], source: "mcp_prompt", description: "MCP review" },
    ];
    const names = buildPaletteCommands(live).map(cmd => cmd.name);
    expect(names).toContain("help"); // Fura-native curated command
    expect(names).toContain("skill:develop-fura"); // non-builtin live extra
    expect(names).toContain("review"); // mcp_prompt live extra
    expect(names.filter(name => name === "tools")).toHaveLength(1); // builtin not duplicated
    expect(names).not.toContain("settings"); // tui-only stays excluded
  });

  it("falls back to curated supported commands when no live commands are available", () => {
    const pool = buildPaletteCommands([]);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every(cmd => cmd.support === "supported")).toBe(true);
    expect(pool.some(cmd => cmd.name === "help")).toBe(true);
  });
});
