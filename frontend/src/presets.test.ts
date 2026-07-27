import { describe, expect, it } from "vitest";
import type { PresetSummary } from "./protocol";
import {
  buildPresetSaveMessage,
  isValidPresetName,
  parsePresetParams,
  presetNameFromInput,
  pruneDefaults,
  requiredParamsFilled,
  resolvePresetCommand,
  substitutePresetParams,
} from "./presets";

function preset(overrides: Partial<PresetSummary> & { name: string }): PresetSummary {
  return { description: "", body: "", defaults: {}, ...overrides };
}

describe("parsePresetParams", () => {
  it("returns unique params in order of first appearance", () => {
    expect(parsePresetParams("Review {skill}; scope {zakres}; again {skill}.")).toEqual([
      "skill",
      "zakres",
    ]);
  });

  it("ignores literal braces that are not identifiers", () => {
    expect(parsePresetParams('json {} and { "k": 1 } and {123}')).toEqual([]);
  });

  it("returns empty for bodies without params", () => {
    expect(parsePresetParams("Commit and rebase.")).toEqual([]);
  });
});

describe("substitutePresetParams", () => {
  it("replaces known params and leaves unknown intact", () => {
    expect(substitutePresetParams("Hi {name}, see {x}", { name: "Al" })).toBe("Hi Al, see {x}");
  });

  it("substitutes empty-string values", () => {
    expect(substitutePresetParams("[{note}]", { note: "" })).toBe("[]");
  });

  it("does not leak inherited Object.prototype keys", () => {
    expect(substitutePresetParams("{toString}{constructor}", {})).toBe("{toString}{constructor}");
  });
});

describe("isValidPresetName", () => {
  it("accepts slugs", () => {
    for (const name of ["finish", "update-skill", "a_b", "ship2"]) {
      expect(isValidPresetName(name)).toBe(true);
    }
  });

  it("rejects invalid names", () => {
    for (const name of ["", ".", "../evil", "a/b", "A B", "Upper", "-lead", "trail-", "a--b"]) {
      expect(isValidPresetName(name)).toBe(false);
    }
    expect(isValidPresetName("a".repeat(65))).toBe(false);
  });
});

describe("presetNameFromInput", () => {
  it("normalizes free text to a slug", () => {
    expect(presetNameFromInput("  Update Skill!  ")).toBe("update-skill");
    expect(presetNameFromInput("finish")).toBe("finish");
    expect(presetNameFromInput("@@@")).toBe("");
  });
});

describe("requiredParamsFilled", () => {
  it("requires params without defaults to be non-empty", () => {
    expect(requiredParamsFilled(["skill"], {}, {})).toBe(false);
    expect(requiredParamsFilled(["skill"], {}, { skill: "  " })).toBe(false);
    expect(requiredParamsFilled(["skill"], {}, { skill: "develop-fura" })).toBe(true);
  });

  it("treats params with defaults as satisfied", () => {
    expect(requiredParamsFilled(["skill"], { skill: "develop-fura" }, {})).toBe(true);
  });
});

describe("pruneDefaults", () => {
  it("keeps only non-empty defaults for actual params", () => {
    expect(pruneDefaults(["a", "b"], { a: "x", b: "", c: "stale" })).toEqual({ a: "x" });
  });
});

describe("buildPresetSaveMessage", () => {
  it("omits empty description and defaults", () => {
    expect(buildPresetSaveMessage("finish", "  ", "body", {})).toEqual({
      type: "preset.save",
      name: "finish",
      body: "body",
    });
  });

  it("includes description and defaults when present", () => {
    expect(buildPresetSaveMessage("x", "Desc", "body {a}", { a: "1" })).toEqual({
      type: "preset.save",
      name: "x",
      body: "body {a}",
      description: "Desc",
      defaults: { a: "1" },
    });
  });
});

describe("resolvePresetCommand", () => {
  const presets: PresetSummary[] = [
    preset({ name: "finish", body: "Commit and rebase." }),
    preset({ name: "update-skill", body: "Review {skill}." }),
  ];

  it("opens the picker when no name is given", () => {
    expect(resolvePresetCommand("/presets", presets)).toEqual({ kind: "picker" });
    expect(resolvePresetCommand("/preset   ", presets)).toEqual({ kind: "picker" });
  });

  it("reports unknown presets with the available list", () => {
    expect(resolvePresetCommand("/presets nope", presets)).toEqual({
      kind: "unknown",
      name: "nope",
      available: ["finish", "update-skill"],
    });
  });

  it("runs a zero-param preset immediately", () => {
    const result = resolvePresetCommand("/presets finish", presets);
    expect(result.kind).toBe("run");
    expect(result.kind === "run" && result.preset.name).toBe("finish");
  });

  it("requests param fill for a preset with params", () => {
    const result = resolvePresetCommand("/presets update-skill extra ignored", presets);
    expect(result.kind).toBe("params");
    expect(result.kind === "params" && result.preset.name).toBe("update-skill");
  });

  it("accepts the /preset alias", () => {
    expect(resolvePresetCommand("/preset finish", presets).kind).toBe("run");
  });
});
