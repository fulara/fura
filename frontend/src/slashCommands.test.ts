import { describe, expect, it } from "vitest";
import { findSlashCommand, SLASH_COMMANDS } from "./slashCommands";

describe("slash command registry", () => {
  it("does not advertise /goal in Fura", () => {
    expect(SLASH_COMMANDS.some(command => command.name === "goal")).toBe(false);
    expect(findSlashCommand("/goal")).toBeUndefined();
  });
});
