import type { CodeFileContent } from "./protocol";

export type CodeFileComment = {
  id: string;
  path: string;
  lineNumber: number;
  lineText: string;
  text: string;
};

export type CodePreviewDraft = {
  sessionId: string;
  file: CodeFileContent;
  comments: CodeFileComment[];
};

const CODE_COMMENT_CONTEXT_RADIUS = 4;

export function createCodeFileComment(input: {
  id: string;
  file: CodeFileContent;
  lineNumber: number;
  lineText: string;
  text: string;
}): CodeFileComment {
  return {
    id: input.id,
    path: input.file.path,
    lineNumber: input.lineNumber,
    lineText: input.lineText,
    text: input.text.trim(),
  };
}

export function commentsForCodeLine(
  comments: CodeFileComment[],
  path: string,
  lineNumber: number,
  lineText: string,
): CodeFileComment[] {
  return comments.filter(comment => (
    comment.path === path &&
    comment.lineNumber === lineNumber &&
    comment.lineText === lineText
  ));
}

export function selectedCodeComments(comments: CodeFileComment[], path: string): CodeFileComment[] {
  return comments.filter(comment => comment.path === path);
}

export function removeSelectedCodeComments(comments: CodeFileComment[], path: string): CodeFileComment[] {
  return comments.filter(comment => comment.path !== path);
}

export function formatCodeLocation(comment: CodeFileComment): string {
  return `${comment.path}:${comment.lineNumber}`;
}

export function buildCodeCommentPrompt(file: CodeFileContent, comments: CodeFileComment[]): string {
  const lines = codeFileLines(file.text);
  const sortedComments = [...comments].sort((left, right) => left.lineNumber - right.lineNumber);
  const commentSections = sortedComments
    .map((comment, index) => [
      `### Comment ${index + 1}`,
      `Location: ${formatCodeLocation(comment)}`,
      `Code line: ${comment.lineText}`,
      `Comment: ${comment.text}`,
      "",
      "Relevant code context:",
      `\`\`\`${file.language || "text"}`,
      buildCodeCommentContext(lines, comment),
      "\`\`\`",
    ].join("\n"))
    .join("\n\n");

  return [
    "I reviewed the current file content in Fura and left comments on specific code lines.",
    `File: ${file.path}`,
    "",
    commentSections,
    "",
    "Please address these comments. Use the file path and line number metadata to locate each comment precisely.",
  ].join("\n");
}

export function codeCommentFlushEditorText(count: number): string {
  return `Flush ${count} code comment${count === 1 ? "" : "s"}`;
}

export function codeCommentPreviewStatus(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"} ready to send`;
}

function buildCodeCommentContext(lines: string[], comment: CodeFileComment): string {
  const targetIndex = Math.max(0, comment.lineNumber - 1);
  const start = Math.max(0, targetIndex - CODE_COMMENT_CONTEXT_RADIUS);
  const end = Math.min(lines.length, targetIndex + CODE_COMMENT_CONTEXT_RADIUS + 1);
  const context: string[] = [];
  for (let index = start; index < end; index += 1) {
    const text = lines[index] ?? "";
    context.push(`${String(index + 1).padStart(4, " ")}| ${text}`);
  }
  return context.join("\n");
}

function codeFileLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
