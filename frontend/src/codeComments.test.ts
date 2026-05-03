import { describe, expect, it } from "vitest";
import {
  buildCodeCommentPrompt,
  codeCommentFlushEditorText,
  codeCommentPreviewStatus,
  commentsForCodeLine,
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
      file,
      lineNumber: 2,
      lineText: "println!(\"hi\");",
      text: "adjust logging",
    });

    expect(selectedCodeComments([comment], file.path)).toEqual([comment]);
    expect(commentsForCodeLine([comment], file.path, 2, "println!(\"hi\");")).toEqual([comment]);
    expect(removeSelectedCodeComments([comment], file.path)).toEqual([]);
  });

  it("builds prompt and flush labels", () => {
    const comment = createCodeFileComment({
      id: "c1",
      file,
      lineNumber: 2,
      lineText: "println!(\"hi\");",
      text: "adjust logging",
    });
    const prompt = buildCodeCommentPrompt(file, [comment]);

    expect(prompt).toContain("File: src/main.rs");
    expect(prompt).toContain("Location: src/main.rs:2");
    expect(prompt).toContain("println!(\"hi\");");
    expect(codeCommentFlushEditorText(2)).toBe("Flush 2 code comments");
    expect(codeCommentPreviewStatus(1)).toBe("1 comment ready to send");
  });
});
