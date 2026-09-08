import type { CodeFileContent } from "./protocol";

export type CodeFileComment = {
  id: string;
  root: string;
  fileVersion: number;
  fileText: string;
  path: string;
  lineNumber: number;
  lineText: string;
  text: string;
};

export type CodePreviewDraft = {
  sessionId: string;
  root: string;
  file: CodeFileContent;
  comments: CodeFileComment[];
};

const CODE_COMMENT_CONTEXT_RADIUS = 4;

export function createCodeFileComment(input: {
  id: string;
  root: string;
  file: CodeFileContent;
  lineNumber: number;
  lineText: string;
  text: string;
}): CodeFileComment {
  return {
    id: input.id,
    root: input.root,
    fileVersion: input.file.version,
    fileText: input.file.text,
    path: input.file.path,
    lineNumber: input.lineNumber,
    lineText: codeFileLines(input.file.text)[input.lineNumber - 1] ?? "",
    text: input.text.trim(),
  };
}


export function selectedCodeComments(comments: CodeFileComment[], root: string, file: CodeFileContent): CodeFileComment[] {
  return comments.filter(comment =>
    comment.root === root && comment.path === file.path &&
    comment.fileVersion === file.version && comment.fileText === file.text,
  );
}

export function removeSelectedCodeComments(comments: CodeFileComment[], flushed: CodeFileComment[]): CodeFileComment[] {
  return comments.filter(comment => !flushed.includes(comment));
}

export function codeCommentFileKey(root: string, path: string): string {
  return JSON.stringify([root, path]);
}

export function formatCodeLocation(comment: CodeFileComment): string {
  return `${comment.root.replace(/\/$/u, "")}/${comment.path}:${comment.lineNumber}`;
}

export function buildCodeCommentPrompt(root: string, file: CodeFileContent, comments: CodeFileComment[]): string {
  const lines = codeFileLines(file.text);
  const sortedComments = selectedCodeComments(comments, root, file).sort((left, right) => left.lineNumber - right.lineNumber);
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
    "I reviewed a saved file version in Fura and left comments on specific code lines.",
    `Workspace root: ${root}`,
    `File: ${file.path}`,
    `Reviewed version: ${file.version} (filesystem version; context below is the reviewed content, not a fresh disk read)`,
    "",
    commentSections,
    "",
    "Please address these comments in the specified workspace root, which may differ from your session cwd. Verify the current file against the reviewed context before changing it; line numbers refer to the reviewed version.",
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
