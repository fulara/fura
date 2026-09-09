import { describe, expect, it } from "vitest";
import { intralineChanges } from "./diffIntraline";

function expectChanges(before: string, after: string, removed: string[], added: string[]): void {
  const changes = intralineChanges(before, after);
  expect(changes).not.toBeNull();
  if (!changes) throw new Error("Expected a confident intraline comparison");
  expect(changes.before.map(({ start, end }) => before.slice(start, end))).toEqual(removed);
  expect(changes.after.map(({ start, end }) => after.slice(start, end))).toEqual(added);

  const unchanged: string[] = [];
  for (const [text, ranges] of [
    [before, changes.before],
    [after, changes.after],
  ] as const) {
    const boundaries = new Set([text.length]);
    for (const { index } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
      boundaries.add(index);
    }
    let cursor = 0;
    let retained = "";
    for (const { start, end } of ranges) {
      expect(start).toBeGreaterThanOrEqual(cursor);
      expect(end).toBeGreaterThan(start);
      expect(boundaries.has(start)).toBe(true);
      expect(boundaries.has(end)).toBe(true);
      retained += text.slice(cursor, start);
      cursor = end;
    }
    unchanged.push(retained + text.slice(cursor));
  }
  expect(unchanged[0]).toBe(unchanged[1]);
}

describe("intralineChanges", () => {
  it("marks changed string contents without quotes or surrounding syntax", () => {
    expectChanges('let name = "old";', 'let name = "new";', ["old"], ["new"]);
  });

  it("marks complete changed numeric values rather than shared digits", () => {
    expectChanges("const limit = 100;", "const limit = 120;", ["100"], ["120"]);
  });

  it("returns no ranges for unchanged source", () => {
    expect(intralineChanges('let name = "old";', 'let name = "old";')).toBeNull();
    expect(intralineChanges("", "")).toBeNull();
  });

  it("represents insertions and deletions without empty ranges on the other side", () => {
    expectChanges("const total = price;", "const total = price + tax;", [], [" + tax"]);
    expectChanges("const total = price + tax;", "const total = price;", [" + tax"], []);
  });

  it("keeps unchanged words and punctuation between separated changes", () => {
    expectChanges("let first = 1, second = 2;", "let first = 3, second = 4;", ["1", "2"], ["3", "4"]);
  });

  it("preserves whitespace runs exactly, including tabs and trailing spaces", () => {
    expectChanges("\tlet count = 1;  ", "  let count = 1;\t", ["\t", "  "], ["  ", "\t"]);
  });

  it("keeps complete emoji clusters and correct UTF-16 offsets after emoji", () => {
    expectChanges('let icon = "👩🏽‍💻";', 'let icon = "👨🏽‍💻";', ["👩🏽‍💻"], ["👨🏽‍💻"]);
    expectChanges('let icon = "👩🏽‍💻 old";', 'let icon = "👩🏽‍💻 new";', ["old"], ["new"]);
  });

  it("does not normalize combining marks or split Unicode words", () => {
    expectChanges('let label = "e\u0301";', 'let label = "é";', ["e\u0301"], ["é"]);
    expectChanges('const 名称 = "旧值";', 'const 名称 = "新值";', ["旧值"], ["新值"]);
  });

  it("declines ambiguous repeated-token alignments", () => {
    expect(intralineChanges("let x = a + a;", "let x = a;")).toBeNull();
    expect(intralineChanges("let x = a;", "let x = a + a;")).toBeNull();
  });

  it("declines unrelated lines and large replacements sharing only a small prefix", () => {
    expect(intralineChanges("alpha", "beta")).toBeNull();
    expect(intralineChanges("foo(x);", "bar(y);")).toBeNull();
    expect(intralineChanges(`const value = "${"a".repeat(120)}";`, `const value = "${"b".repeat(120)}";`)).toBeNull();
    expect(intralineChanges("", "const value = 1;")).toBeNull();
  });

  it("declines excessive UTF-16 input even when it contains few grapheme clusters", () => {
    expect(intralineChanges(`let x = "a${"\u0301".repeat(2048)}";`, 'let x = "b";')).toBeNull();
  });

  it("declines excessive grapheme input even when it forms one word token", () => {
    expect(intralineChanges(`let x = "${"a".repeat(257)}";`, 'let x = "b";')).toBeNull();
  });

  it("accepts a bounded matrix and declines the next size without partial ranges", () => {
    expectChanges(`a${"!".repeat(253)};`, `a${"!".repeat(253)}?`, [";"], ["?"]);
    expect(intralineChanges(`a${"!".repeat(254)};`, `a${"!".repeat(254)}?`)).toBeNull();
  });
});
