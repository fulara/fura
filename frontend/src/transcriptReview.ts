import { imagePlaceholderText } from "./imageRendering";
import type { ContentBlock, TranscriptMessage } from "./protocol";

export type TranscriptReviewLine = {
  lineNumber: number;
  text: string;
};

export type TranscriptReviewComment = {
  id: string;
  messageId: string;
  role: TranscriptMessage["role"];
  lineNumber: number;
  lineText: string;
  text: string;
};
type TranscriptReviewPromptOptions = {
  subject?: string;
  roleLabel?: string;
  contextDescription?: string;
  closingInstruction?: string;
};

const REVIEW_CONTEXT_RADIUS = 4;

export function transcriptMessageReviewText(message: TranscriptMessage): string {
  return message.blocks
    .map(reviewBlockText)
    .filter(Boolean)
    .join("\n\n");
}

export function transcriptReviewLines(message: TranscriptMessage): TranscriptReviewLine[] {
  const text = transcriptMessageReviewText(message);
  const rawLines = text.length > 0 ? text.split(/\r?\n/) : [""];
  return rawLines.map((line, index) => ({ lineNumber: index + 1, text: line }));
}

export function commentsForTranscriptLine(
  comments: TranscriptReviewComment[],
  line: TranscriptReviewLine,
): TranscriptReviewComment[] {
  return comments.filter(comment => comment.lineNumber === line.lineNumber && comment.lineText === line.text);
}

export function buildTranscriptReviewPrompt(
  message: TranscriptMessage,
  comments: TranscriptReviewComment[],
  options: TranscriptReviewPromptOptions = {},
): string {
  const lines = transcriptReviewLines(message);
  const sortedComments = [...comments].sort((left, right) => left.lineNumber - right.lineNumber);
  const commentSections = sortedComments
    .map((comment, index) => [
      `### Comment ${index + 1}`,
      `Line: ${comment.lineNumber}`,
      `Transcript line: ${comment.lineText || "(blank line)"}`,
      `Comment: ${comment.text}`,
      "",
      "Relevant transcript context:",
      "```text",
      buildTranscriptLineContext(lines, comment),
      "```",
    ].join("\n"))
    .join("\n\n");

  return [
    `I reviewed ${options.subject ?? "a transcript bubble"} in Fura and left comments on specific lines.`,
    `Message id: ${message.id}`,
    `Message role: ${options.roleLabel ?? formatTranscriptRole(message.role)}`,
    "",
    options.contextDescription ?? "Only the context around commented lines is included below; the full transcript is intentionally omitted.",
    "",
    commentSections,
    "",
    options.closingInstruction ?? "Please address these comments. Use the line numbers and quoted transcript context to understand exactly what each comment refers to.",
  ].join("\n");
}

function reviewBlockText(block: ContentBlock): string {
  if (block.kind === "text") return block.text;
  if (block.kind === "image") return imagePlaceholderText(block);
  if (block.kind === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
  return "";
}

function buildTranscriptLineContext(lines: TranscriptReviewLine[], comment: TranscriptReviewComment): string {
  const exactIndex = lines.findIndex(line => line.lineNumber === comment.lineNumber && line.text === comment.lineText);
  const index = exactIndex >= 0 ? exactIndex : lines.findIndex(line => line.lineNumber === comment.lineNumber);
  if (index === -1) return comment.lineText;

  const start = Math.max(0, index - REVIEW_CONTEXT_RADIUS);
  const end = Math.min(lines.length, index + REVIEW_CONTEXT_RADIUS + 1);
  return lines.slice(start, end)
    .map(line => `${line.lineNumber}: ${line.text}`)
    .join("\n");
}

function formatTranscriptRole(role: TranscriptMessage["role"]): string {
  return role === "user" ? "user" : role;
}
