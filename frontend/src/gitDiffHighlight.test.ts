import { describe, expect, it } from "vitest";
import { createGitDiffHighlighter } from "./gitDiffHighlight";
import type { DiffRow } from "./protocol";

function line(text: string, kind: "add" | "remove" | "context", hunk: string | null = "@@ -1 +1 @@"): DiffRow {
  return {
    type: "line",
    prefix: kind === "add" ? "+" : kind === "remove" ? "-" : " ",
    location: {
      oldPath: "src/lib.rs",
      newPath: "src/lib.rs",
      hunk,
      side: kind === "remove" ? "left" : "right",
      kind,
      oldLine: kind === "add" ? null : 1,
      newLine: kind === "remove" ? null : 1,
      text,
    },
  };
}
function render(rows: DiffRow[]): HTMLElement[] {
  const highlighter = createGitDiffHighlighter(rows, document);
  return rows.map((_, index) => {
    const code = document.createElement("code");
    highlighter.renderLine(index, code);
    return code;
  });
}

describe("Git diff highlighting adapter", () => {
  it("adds both visual layers without changing immutable wire rows or selected text", () => {
    const rows = [line('-let name = "old";', "remove"), line('+let name = "new";', "add")];
    for (const row of rows) {
      if (row.type === "line") Object.freeze(row.location);
      Object.freeze(row);
    }
    const original = JSON.stringify(rows);
    const nodes = render(rows);
    expect(nodes[1].querySelector(".hljs-string.diff-intraline-add")?.textContent).toBe("new");
    expect(JSON.stringify(rows)).toBe(original);
    const selection = document.createRange();
    selection.selectNodeContents(nodes[1]);
    expect(selection.toString()).toBe('+let name = "new";');
  });

  it("does not merge distinct hunk identities when a peer omits hunk header rows", () => {
    const nodes = render([line(" /* first hunk", "context", "@@ -1 +1 @@"), line(" pub fn after_gap() {}", "context", "@@ -99 +99 @@")]);
    expect(nodes[0].querySelector(".hljs-comment")).not.toBeNull();
    expect(nodes[1].querySelector(".hljs-keyword")?.textContent).toBe("pub");
  });

  it("does not intraline-pair unknown hunk identities or malformed wire prefixes", () => {
    const missing = render([line("-let x = 1;", "remove", null), line("+let x = 2;", "add", null)]);
    expect(missing.every((node) => !node.querySelector(".diff-intraline-add, .diff-intraline-remove"))).toBe(true);
    const malformed = line("+let x = 2;", "add");
    if (malformed.type !== "line") throw new Error("line fixture");
    malformed.prefix = "++";
    const [node] = render([malformed]);
    expect(node.querySelector(".diff-syntax")).toBeNull();
    expect(node.textContent).toBe("+let x = 2;");
  });

  it("keeps binary and combined diff metadata plain", () => {
    const rows: DiffRow[] = [
      { type: "meta", text: "Binary files a/image.png and b/image.png differ" },
      { type: "meta", text: "@@@ -1,2 -1,2 +1,3 @@@" },
    ];
    const nodes = render(rows);
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => (row.type === "meta" ? row.text : "")));
    expect(nodes.every((node) => !node.querySelector(".diff-syntax"))).toBe(true);
  });
});
