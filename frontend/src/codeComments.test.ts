import { describe, expect, it } from "vitest";
import {
  buildCodeCommentPrompt,
  createCodeFileComment,
  removeSelectedCodeComments,
  selectedCodeComments,
} from "./codeComments";

describe("code comments", () => {
  const file = {
    path: "src/main.rs",
    language: "rust",
    text: "fn main() {}\nprintln!(\"hi\");\n",
    size: 0,
    version: 1,
  };

  it("creates and filters code comments", () => {
    const comment = createCodeFileComment({
      id: "c1",
      root: "/repoA",
      file,
      lineNumber: 2,
      lineText: "println!(\"hi\");",
      text: "adjust logging",
    });

    expect(selectedCodeComments([comment], "/repoA", file)).toEqual([comment]);
    expect(removeSelectedCodeComments([comment], [comment])).toEqual([]);
  });

  it("identifies the root and reviewed version in prompts", () => {
    const comment = createCodeFileComment({
      id: "c1",
      root: "/repoA",
      file,
      lineNumber: 2,
      lineText: "println!(\"hi\");",
      text: "adjust logging",
    });
    const prompt = buildCodeCommentPrompt("/repoA", file, [comment]);

    expect(prompt).toContain("File: src/main.rs");
    expect(prompt).toContain("Workspace root: /repoA");
    expect(prompt).toContain("Reviewed version: 1");
    expect(prompt).toContain("Location: /repoA/src/main.rs:2");
    expect(prompt).toContain("println!(\"hi\");");
  });

  it("does not mix identical relative paths across roots or changed file content", () => {
    const comment = createCodeFileComment({
      id: "a", root: "/repoA", file, lineNumber: 2, lineText: 'println!("hi");', text: "A_ONLY",
    });
    const changed = { ...file, text: 'fn main() {}\nprintln!("new");\n' };
    expect(selectedCodeComments([comment], "/repoB", file)).toEqual([]);
    expect(selectedCodeComments([comment], "/repoA", changed)).toEqual([]);
    expect(selectedCodeComments([comment], "/repoA", { ...file, version: 2 })).toEqual([]);
    expect(buildCodeCommentPrompt("/repoB", file, [comment])).not.toContain("A_ONLY");
    expect(buildCodeCommentPrompt("/repoA", changed, [comment])).not.toContain("A_ONLY");
    expect(buildCodeCommentPrompt("/repoA", file, [comment])).toContain('2| println!("hi");');
  });

  it("flushes only the previewed comments, retaining later edits and other roots or versions", () => {
    const old = createCodeFileComment({
      id: "old", root: "/repoA", file, lineNumber: 2, lineText: 'println!("hi");', text: "old",
    });
    const other = createCodeFileComment({
      id: "other", root: "/repoB", file, lineNumber: 2, lineText: 'println!("hi");', text: "other",
    });
    const changed = createCodeFileComment({
      id: "new", root: "/repoA", file: { ...file, text: "new content\n" },
      lineNumber: 1, lineText: "new content", text: "new",
    });
    const edited = { ...old, text: "edited after preview" };
    expect(removeSelectedCodeComments([old, other, changed], [old])).toEqual([other, changed]);
    expect(removeSelectedCodeComments([edited, other, changed], [old])).toEqual([edited, other, changed]);
  });
});
