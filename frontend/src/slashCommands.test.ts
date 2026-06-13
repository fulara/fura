import { describe, expect, it } from "vitest";
import { buildCommandsPopupSections, findSlashCommand, SLASH_COMMANDS } from "./slashCommands";

describe("slash command registry", () => {
  it("does not advertise /goal in Fura", () => {
    expect(SLASH_COMMANDS.some(command => command.name === "goal")).toBe(false);
    expect(findSlashCommand("/goal")).toBeUndefined();
  });
});

describe("buildCommandsPopupSections", () => {
  const live = [
    { name: "skill:develop-fura", aliases: [], subcommands: [], source: "skill", description: "Develop Fura" },
    { name: "deploy", aliases: [], subcommands: [], source: "file", description: "Deploy" },
    { name: "tools", aliases: [], subcommands: [], source: "builtin", description: "Tools" },
  ];

  it("groups curated commands, live skills, and other live commands", () => {
    const sections = buildCommandsPopupSections(live);
    expect(sections.map(section => section.title)).toEqual(["Commands", "Skills", "Other commands"]);

    const skills = sections.find(section => section.title === "Skills");
    expect(skills?.rows.some(row => row.insertText === "/skill:develop-fura ")).toBe(true);

    const other = sections.find(section => section.title === "Other commands");
    expect(other?.rows.some(row => row.label === "/deploy")).toBe(true);
    expect(other?.rows.some(row => row.label === "/tools")).toBe(false); // builtin excluded

    const commands = sections.find(section => section.title === "Commands");
    expect(commands?.rows.some(row => row.label.startsWith("/plan"))).toBe(true);
    expect(commands?.rows.some(row => row.label === "/help")).toBe(false);
    expect(commands?.rows.some(row => row.label === "/commands")).toBe(false);
  });

  it("returns only the Commands section when no live commands are available", () => {
    const sections = buildCommandsPopupSections([]);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Commands");
    expect(sections[0].rows.length).toBeGreaterThan(0);
  });
});
