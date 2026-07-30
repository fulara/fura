import katex from "katex";
import "katex/dist/katex.min.css";
import hljs from "highlight.js/lib/common";
import { marked, type Token, type Tokens } from "marked";
import { copyTextToClipboard, mkEl, mkFrag, mkText } from "./dom";
import { appendEventTimestamp } from "./eventTime";
import { imagePlaceholderText, renderImageAttachment } from "./imageRendering";
import { renderMermaidBlock } from "./mermaidRendering";
import { renderTextileBlock } from "./textileRendering";
import type { ContentBlock, TranscriptMessage } from "./protocol";
import {
  commentsForTranscriptLine,
  transcriptReviewLines,
  type TranscriptReviewComment,
  type TranscriptReviewLine,
} from "./transcriptReview";
import type { ThinkingVisibilityMode } from "./uiPreferences";

const INLINE_MATH = /^\$(?!\s)([^$\n]*?\S)\$(?!\d)/;

marked.use({
  extensions: [{
    name: "inlineMath",
    level: "inline",
    start: source => {
      const index = source.indexOf("$");
      return index >= 0 ? index : undefined;
    },
    tokenizer: source => {
      const match = INLINE_MATH.exec(source);
      if (!match) return undefined;
      return { type: "inlineMath", raw: match[0], text: match[1] };
    },
  }],
});

type RenderedMessageState = {
  message: TranscriptMessage;
  signature: string;
};

const renderedMessageState = new WeakMap<HTMLElement, RenderedMessageState>();


export function transcriptMessageRenderCacheKey(
  sessionId: string,
  message: TranscriptMessage,
  index: number,
  variantKey = "",
): string {
  const timestamp = message.timestamp ?? "";
  return `message:${sessionId.length}:${sessionId}:${message.id.length}:${message.id}:${index}:${message.role}:${timestamp}:${variantKey.length}:${variantKey}`;
}

function transcriptMessageRenderSignature(message: TranscriptMessage): string {
  if (message.renderHash) return `hash:${message.renderHash}`;
  return `legacy:${JSON.stringify([
    message.id,
    message.role,
    message.timestamp ?? null,
    message.isNew,
    message.blocks,
  ])}`;
}


export function messageText(message: TranscriptMessage): string {
  return message.blocks
    .map(block => {
      if (block.kind === "text") return block.text;
      if (block.kind === "image") return imagePlaceholderText(block);
      if (block.kind === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

type RenderMessageOptions = {
  thinkingVisibilityMode: ThinkingVisibilityMode;
  review?: RenderMessageReviewOptions;
};

type ReviewRenderView = "rendered" | "source";

type RenderMessageReviewOptions = {
  active: boolean;
  comments: TranscriptReviewComment[];
  onStart?(message: TranscriptMessage): void;
  onAddComment?(message: TranscriptMessage, line: TranscriptReviewLine): void;
  onEditComment?(message: TranscriptMessage, comment: TranscriptReviewComment): void;
  onDeleteComment?(message: TranscriptMessage, comment: TranscriptReviewComment): void;
  onCancel?(message: TranscriptMessage): void;
  onFlush?(message: TranscriptMessage): void;
};


function isPendingPromptMessage(message: TranscriptMessage): boolean {
  return message.id.startsWith("__pending_prompt:");
}

function isCommandNoticeMessage(message: TranscriptMessage): boolean {
  return message.id.startsWith("__command_notice:");
}

function messageClassName(message: TranscriptMessage, options: RenderMessageOptions): string {
  return `message ${message.role}${options.review?.active ? " message-reviewing" : ""}${isPendingPromptMessage(message) ? " message-pending-prompt" : ""}${isCommandNoticeMessage(message) ? " message-command-notice" : ""}`;
}

export function renderMessage(message: TranscriptMessage, options: RenderMessageOptions): HTMLElement {
  const article = mkEl("article");
  renderedMessageState.set(article, { message, signature: transcriptMessageRenderSignature(message) });
  article.className = messageClassName(message, options);
  article.dataset.messageId = message.id;

  const header = mkEl("header");
  const heading = mkEl("div");
  heading.className = "message-heading";
  syncMessageHeading(heading, message);
  const actions = mkEl("div");
  actions.className = "message-actions";
  const copy = mkEl("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    const owner = article.ownerDocument;
    const copied = await copyTextToClipboard(messageText(renderedMessageState.get(article)?.message ?? message), owner);
    copy.textContent = copied ? "Copied" : "Copy failed";
    (owner.defaultView ?? window).setTimeout(() => {
      copy.textContent = "Copy";
    }, 900);
  });
  actions.append(copy);
  if (options.review?.onStart) {
    const review = mkEl("button");
    review.type = "button";
    review.className = "message-review-toggle";
    review.textContent = options.review.active ? "Reviewing" : "Review";
    review.setAttribute("aria-pressed", options.review.active ? "true" : "false");
    review.disabled = options.review.active;
    review.addEventListener("click", () => {
      options.review?.onStart?.(renderedMessageState.get(article)?.message ?? message);
    });
    actions.append(review);
  }
  header.append(heading, actions);
  article.append(header);
  appendMessageContent(article, message, options);

  return article;
}

export function updateRenderedMessage(article: HTMLElement, message: TranscriptMessage, options: RenderMessageOptions): HTMLElement {
  const header = article.firstElementChild;
  if (!header || header.tagName !== "HEADER") return renderMessage(message, options);
  const signature = transcriptMessageRenderSignature(message);
  const previous = renderedMessageState.get(article);
  if (previous?.signature === signature) return article;

  renderedMessageState.set(article, { message, signature });
  article.className = messageClassName(message, options);
  article.dataset.messageId = message.id;
  const heading = header.firstElementChild;
  if (heading) syncMessageHeading(heading as HTMLElement, message);
  while (header.nextSibling) header.nextSibling.remove();
  appendMessageContent(article, message, options);
  return article;
}

function syncMessageHeading(heading: HTMLElement, message: TranscriptMessage): void {
  heading.replaceChildren();
  const roleLabel = mkEl("strong");
  roleLabel.textContent = isCommandNoticeMessage(message) ? "Command" : message.role === "user" ? "You" : message.role;
  heading.append(roleLabel);
  appendEventTimestamp(heading, message.timestamp);
  if (isPendingPromptMessage(message)) {
    const pending = mkEl("span");
    pending.className = "message-pending-badge";
    pending.textContent = "sending";
    heading.append(pending);
  }
}



function visibleMessageBlocks(message: TranscriptMessage, options: RenderMessageOptions): Array<{ block: ContentBlock; index: number }> {
  return message.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => options.thinkingVisibilityMode !== "hidden" || block.kind === "text" || block.kind === "image");
}

function appendMessageContent(article: HTMLElement, message: TranscriptMessage, options: RenderMessageOptions): void {
  const visibleBlocks = visibleMessageBlocks(message, options);
  if (visibleBlocks.length === 0) {
    article.hidden = true;
    return;
  }
  article.hidden = false;

  if (options.review?.active) {
    article.append(renderTranscriptReviewBody(message, options.review));
  } else {
    for (const { block, index } of visibleBlocks) {
      article.append(renderBlock(block, message.isNew, message.id, index, {
        thinkingVisibilityMode: options.thinkingVisibilityMode,
      }));
    }
  }
}

function renderTranscriptReviewBody(message: TranscriptMessage, review: RenderMessageReviewOptions): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = "transcript-review-body";
  wrapper.setAttribute("aria-label", "Transcript review lines");

  const reviewText = messageText(message);
  const hasMarkdownPreview = shouldShowMarkdownReviewPreview(reviewText);
  const sourceLines = transcriptReviewLines(message);
  let activeView: ReviewRenderView = hasMarkdownPreview ? "rendered" : "source";

  if (hasMarkdownPreview) {
    wrapper.append(renderReviewViewToggle(activeView, nextView => {
      activeView = nextView;
      syncReviewViewVisibility(wrapper, activeView);
    }));
    wrapper.append(renderMarkdownReviewPreview(message, reviewText, review));
  }

  const list = mkEl("div");
  list.className = "transcript-review-lines";
  list.dataset.reviewView = "source";
  list.hidden = activeView !== "source";
  for (const line of sourceLines) {
    list.append(renderTranscriptReviewLine(message, line, review));
  }
  wrapper.append(list);

  const footer = mkEl("footer");
  footer.className = "transcript-review-footer";
  const status = mkEl("span");
  const commentCount = review.comments.length;
  status.className = "transcript-review-status";
  status.textContent = `${commentCount} comment${commentCount === 1 ? "" : "s"}`;

  const actions = mkEl("div");
  actions.className = "transcript-review-actions";
  const cancel = mkEl("button");
  cancel.type = "button";
  cancel.textContent = "Cancel review";
  cancel.addEventListener("click", () => review.onCancel?.(message));
  const flush = mkEl("button");
  flush.type = "button";
  flush.textContent = "Flush comments";
  flush.disabled = commentCount === 0;
  flush.addEventListener("click", () => review.onFlush?.(message));
  actions.append(cancel, flush);
  footer.append(status, actions);
  wrapper.append(footer);
  return wrapper;
}
function renderReviewViewToggle(
  activeView: ReviewRenderView,
  onChange: (view: ReviewRenderView) => void,
): HTMLElement {
  const controls = mkEl("div");
  controls.className = "transcript-review-view-toggle";
  const rendered = mkEl("button");
  rendered.type = "button";
  rendered.textContent = "Rendered";
  rendered.dataset.reviewView = "rendered";
  rendered.setAttribute("aria-pressed", String(activeView === "rendered"));
  rendered.addEventListener("click", () => {
    onChange("rendered");
    syncReviewToggleButtons(controls, "rendered");
  });
  const source = mkEl("button");
  source.type = "button";
  source.textContent = "Source";
  source.dataset.reviewView = "source";
  source.setAttribute("aria-pressed", String(activeView === "source"));
  source.addEventListener("click", () => {
    onChange("source");
    syncReviewToggleButtons(controls, "source");
  });
  controls.append(rendered, source);
  return controls;
}

function syncReviewToggleButtons(root: ParentNode, activeView: ReviewRenderView): void {
  root.querySelectorAll<HTMLButtonElement>("[data-review-view]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.reviewView === activeView));
  });
}

function syncReviewViewVisibility(root: ParentNode, activeView: ReviewRenderView): void {
  root.querySelectorAll<HTMLElement>("[data-review-view]").forEach(section => {
    if (!(section instanceof HTMLButtonElement)) {
      section.hidden = section.dataset.reviewView !== activeView;
    }
  });
}


function shouldShowMarkdownReviewPreview(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(^|\n)#{1,6}\s+\S/.test(trimmed)
    || /(^|\n)\s*[-*+]\s+\S/.test(trimmed)
    || /(^|\n)\s*\d+\.\s+\S/.test(trimmed)
    || /(^|\n)```/.test(trimmed)
    || /(^|\n)>\s+\S/.test(trimmed)
    || /\|[^\n]+\|/.test(trimmed);
}

function renderMarkdownReviewPreview(
  message: TranscriptMessage,
  text: string,
  review: RenderMessageReviewOptions,
): HTMLElement {
  const section = mkEl("section");
  section.className = "transcript-review-markdown-preview";
  section.dataset.reviewView = "rendered";
  const title = mkEl("h4");
  title.textContent = "Rendered Markdown review";
  const note = mkEl("p");
  note.textContent = "Use the + buttons here for rendered fragments, or switch to Source for exact line-level comments.";
  section.append(title, note);

  const blocks = mkEl("div");
  blocks.className = "transcript-review-markdown-blocks";
  for (const block of markdownReviewBlocks(text)) {
    const comments = commentsForTranscriptLine(review.comments, block.line);
    const row = mkEl("div");
    row.className = "transcript-review-markdown-block";
    const button = mkEl("button");
    button.type = "button";
    button.className = `transcript-review-comment-btn ${comments.length > 0 ? "has-comments" : ""}`;
    button.textContent = comments.length > 0 ? String(comments.length) : "+";
    button.title = `Comment on rendered Markdown fragment starting at source line ${block.line.lineNumber}`;
    button.addEventListener("click", () => review.onAddComment?.(message, block.line));
    const content = renderMarkdown(block.markdown);
    content.classList.add("transcript-review-markdown-block-content");
    row.append(button, content);
    if (comments.length > 0) row.append(renderReviewCommentThread(message, comments, review));
    blocks.append(row);
  }
  section.append(blocks);
  return section;
}

function markdownReviewBlocks(text: string): Array<{ line: TranscriptReviewLine; markdown: string }> {
  const lines = transcriptReviewLines({ id: "markdown-preview", role: "assistant", blocks: [{ kind: "text", text }], timestamp: null, isNew: false, renderHash: `markdown-preview:${text}` });
  const tokens = marked.lexer(text.trim());
  const blocks: Array<{ line: TranscriptReviewLine; markdown: string }> = [];
  let searchFrom = 0;
  for (const token of tokens) {
    searchFrom = collectMarkdownReviewBlocks(token, text, lines, searchFrom, blocks);
  }
  return blocks;
}

function collectMarkdownReviewBlocks(
  token: Token,
  sourceText: string,
  lines: TranscriptReviewLine[],
  searchFrom: number,
  blocks: Array<{ line: TranscriptReviewLine; markdown: string }>,
): number {
  if (token.type === "space") return searchFrom;
  if (token.type === "list") {
    const list = token as Tokens.List;
    for (const item of list.items) {
      const raw = item.raw?.trimEnd() ?? "";
      if (!raw.trim()) continue;
      searchFrom = pushMarkdownReviewBlock(raw, sourceText, lines, searchFrom, blocks);
    }
    return searchFrom;
  }
  const raw = token.raw?.trimEnd() ?? tokenText(token).trim();
  if (!raw.trim()) return searchFrom;
  return pushMarkdownReviewBlock(raw, sourceText, lines, searchFrom, blocks);
}

function pushMarkdownReviewBlock(
  raw: string,
  sourceText: string,
  lines: TranscriptReviewLine[],
  searchFrom: number,
  blocks: Array<{ line: TranscriptReviewLine; markdown: string }>,
): number {
  const index = sourceText.indexOf(raw, searchFrom);
  const before = index >= 0 ? sourceText.slice(0, index) : sourceText.slice(0, searchFrom);
  const lineNumber = before.split(/\r?\n/).length;
  const line = lines[Math.max(0, Math.min(lines.length - 1, lineNumber - 1))] ?? {
    lineNumber: 1,
    text: raw.split(/\r?\n/)[0] ?? "",
  };
  blocks.push({ line, markdown: raw });
  return index >= 0 ? index + raw.length : searchFrom;
}

function renderTranscriptReviewLine(
  message: TranscriptMessage,
  line: TranscriptReviewLine,
  review: RenderMessageReviewOptions,
): HTMLElement {
  const lineComments = commentsForTranscriptLine(review.comments, line);
  const row = mkEl("div");
  row.className = "transcript-review-line-wrap";

  const lineEl = mkEl("div");
  lineEl.className = "transcript-review-line";
  const commentBtn = mkEl("button");
  commentBtn.type = "button";
  commentBtn.className = `transcript-review-comment-btn ${lineComments.length > 0 ? "has-comments" : ""}`;
  commentBtn.textContent = lineComments.length > 0 ? String(lineComments.length) : "+";
  commentBtn.title = "Comment on this transcript line";
  commentBtn.addEventListener("click", () => review.onAddComment?.(message, line));

  const gutter = mkEl("span");
  gutter.className = "transcript-review-gutter";
  gutter.textContent = String(line.lineNumber);

  const content = mkEl("code");
  content.className = "transcript-review-line-content";
  content.textContent = line.text || " ";
  lineEl.append(commentBtn, gutter, content);
  row.append(lineEl);

  if (lineComments.length > 0) row.append(renderReviewCommentThread(message, lineComments, review));

  return row;
}

function renderReviewCommentThread(
  message: TranscriptMessage,
  comments: TranscriptReviewComment[],
  review: RenderMessageReviewOptions,
  ): HTMLElement {
  const thread = mkEl("div");
  thread.className = "transcript-review-inline-comments";
  for (const comment of comments) {
    const item = mkEl("div");
    item.className = "transcript-review-inline-comment";
    const body = mkEl("span");
    body.textContent = comment.text;
    const actions = mkEl("span");
    actions.className = "review-comment-actions";
    const edit = mkEl("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => review.onEditComment?.(message, comment));
    const remove = mkEl("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => review.onDeleteComment?.(message, comment));
    actions.append(edit, remove);
    item.append(body, actions);
    thread.append(item);
  }
  return thread;
}

export function renderMarkdown(text: string): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "markdown-body";

  appendMarkdownWithRichBlocks(wrapper, text.trim());

  if (!wrapper.hasChildNodes() && text.trim()) {
    const p = mkEl("p");
    p.textContent = text.trim();
    wrapper.append(p);
  }

  return wrapper;
}

// OMP can embed raw regions that Markdown cannot render correctly. `/review`
// wraps unified diffs in `<diff>…</diff>`, while model responses commonly use
// `\[…\]` or `$$…$$` for display math. Extract both before lexing, but leave
// lookalikes inside fenced code blocks untouched.
function appendMarkdownWithRichBlocks(wrapper: HTMLElement, text: string): void {
  const fences = fencedCodeRanges(text);
  const insideFence = (index: number): boolean =>
    fences.some(([start, end]) => index >= start && index < end);
  const richBlock =
    /<diff>\n([\s\S]*?)\n<\/diff>|(?:^|\n)\\\[\s*\n?([\s\S]*?)\n?\s*\\\](?=\n|$)|(?:^|\n)\$\$\s*\n?([\s\S]*?)\n?\s*\$\$(?=\n|$)/g;
  let cursor = 0;
  for (let match = richBlock.exec(text); match; match = richBlock.exec(text)) {
    if (insideFence(match.index)) continue;
    const math = match[2] ?? match[3];
    if (math !== undefined && !math.trim()) continue;
    appendMarkdownTokens(wrapper, text.slice(cursor, match.index));
    wrapper.append(match[1] !== undefined ? renderCodeBlock("diff", match[1]) : renderMath(math, true));
    cursor = richBlock.lastIndex;
  }
  appendMarkdownTokens(wrapper, text.slice(cursor));
}
function renderMath(source: string, displayMode: boolean): HTMLElement {
  const element: HTMLElement = displayMode ? mkEl("div") : mkEl("span");
  element.className = displayMode ? "math-block" : "math-inline";
  katex.render(source.trim(), element, {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });
  return element;
}


// Character ranges of fenced code blocks, in `text`'s own coordinates. This is a
// deliberately small CommonMark-ish line scan rather than a reuse of the Markdown
// lexer: the lexer normalises line endings, which would desync these offsets from
// the raw text the `<diff>` regex runs against.
function fencedCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opener = /^ {0,3}(`{3,}|~{3,})/;
  const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  let offset = 0;
  let open: { fence: string; start: number } | null = null;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1; // account for the split "\n"
    if (!open) {
      const match = opener.exec(line);
      if (match) open = { fence: match[1], start: lineStart };
    } else {
      const match = closer.exec(line);
      if (match && match[1][0] === open.fence[0] && match[1].length >= open.fence.length) {
        ranges.push([open.start, offset]);
        open = null;
      }
    }
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

function appendMarkdownTokens(wrapper: HTMLElement, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const tokens = marked.lexer(trimmed);
  const lastIndex = tokens.length - 1;
  tokens.forEach((token, index) => {
    // The final, still-streaming code fence is re-tokenized on every delta. Render it as
    // plain text until its closing ``` arrives, so we don't re-run syntax highlighting
    // (which is O(n^2) over the message) on a block whose content changes every tick.
    const node = token.type === "code" && index === lastIndex && isUnterminatedFence(token.raw)
      ? renderCodeBlock((token as Tokens.Code).lang ?? "", (token as Tokens.Code).text, { highlight: false })
      : renderMarkdownToken(token);
    if (node) wrapper.append(node);
  });
}

function renderMarkdownToken(token: Token): Node | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      return renderHeading(token as Tokens.Heading);
    case "paragraph":
      return renderParagraph((token as Tokens.Paragraph).tokens ?? []);
    case "code": {
      const code = token as Tokens.Code;
      return renderCodeBlock(code.lang ?? "", code.text);
    }
    case "list":
      return renderList(token as Tokens.List);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote);
    case "hr":
      return mkEl("hr");
    case "table":
      return renderTable(token as Tokens.Table);
    case "html":
      return renderPlainParagraph(token.raw.trim());
    default: {
      const text = tokenText(token).trim();
      return text ? renderPlainParagraph(text) : null;
    }
  }
}

function renderHeading(token: Tokens.Heading): HTMLElement {
  const depth = Math.min(Math.max(token.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const heading = mkEl(`h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
  heading.append(renderInlineTokens(token.tokens));
  return heading;
}

function renderParagraph(tokens: Token[]): HTMLParagraphElement {
  const p = mkEl("p");
  p.append(renderInlineTokens(tokens));
  return p;
}

function renderPlainParagraph(text: string): HTMLParagraphElement {
  const p = mkEl("p");
  p.textContent = text;
  return p;
}


function renderList(token: Tokens.List): HTMLOListElement | HTMLUListElement {
  if (token.ordered) {
    const list = mkEl("ol");
    if (typeof token.start === "number" && token.start !== 1) {
      list.start = token.start;
    }
    for (const item of token.items) {
      list.append(renderListItem(item));
    }
    return list;
  }

  const list = mkEl("ul");
  for (const item of token.items) {
    list.append(renderListItem(item));
  }
  return list;
}

function renderListItem(item: Tokens.ListItem): HTMLLIElement {
  const li = mkEl("li");
  if (item.task) {
    const checkbox = mkEl("input");
    checkbox.type = "checkbox";
    checkbox.disabled = true;
    checkbox.checked = Boolean(item.checked);
    li.append(checkbox, " ");
  }

  const tokens = item.tokens;
  for (const token of tokens) {
    if (token.type === "text") {
      li.append(renderInlineTokens(token.tokens ?? [token]));
      continue;
    }
    if (token.type === "paragraph") {
      const p = renderParagraph((token as Tokens.Paragraph).tokens ?? []);
      if (tokens.length === 1 || item.task) {
        li.append(...Array.from(p.childNodes));
      } else {
        li.append(p);
      }
      continue;
    }
    const node = renderMarkdownToken(token);
    if (node) li.append(node);
  }

  return li;
}

function renderBlockquote(token: Tokens.Blockquote): HTMLQuoteElement {
  const quote = mkEl("blockquote");
  for (const child of token.tokens) {
    const node = renderMarkdownToken(child);
    if (node) quote.append(node);
  }
  return quote;
}

function renderTable(token: Tokens.Table): HTMLTableElement {
  const table = mkEl("table");
  const thead = mkEl("thead");
  const headerRow = mkEl("tr");
  token.header.forEach((cell, index) => {
    const th = mkEl("th");
    setTableCellAlignment(th, token.align[index]);
    th.append(renderInlineTokens(cell.tokens));
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = mkEl("tbody");
  for (const row of token.rows) {
    const tr = mkEl("tr");
    row.forEach((cell, index) => {
      const td = mkEl("td");
      setTableCellAlignment(td, token.align[index]);
      td.append(renderInlineTokens(cell.tokens));
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);

  return table;
}

function setTableCellAlignment(cell: HTMLTableCellElement, align: Tokens.TableCell["align"] | undefined): void {
  if (align) cell.style.textAlign = align;
}

function renderInlineTokens(tokens: Token[]): DocumentFragment {
  const fragment = mkFrag();
  for (const token of tokens) {
    fragment.append(renderInlineToken(token));
  }
  return fragment;
}

function renderInlineToken(token: Token): Node {
  if (token.type === "inlineMath") {
    return renderMath((token as Tokens.Generic).text, false);
  }

  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) return renderInlineTokens(text.tokens);
      return mkText(text.text);
    }
    case "strong":
      return wrapInline("strong", (token as Tokens.Strong).tokens ?? []);
    case "em":
      return wrapInline("em", (token as Tokens.Em).tokens ?? []);
    case "del":
      return wrapInline("del", (token as Tokens.Del).tokens ?? []);
    case "codespan": {
      const code = mkEl("code");
      code.textContent = (token as Tokens.Codespan).text;
      return code;
    }
    case "link":
      return renderLink(token as Tokens.Link);
    case "br":
      return mkEl("br");
    case "html":
      return mkText(token.raw);
    default:
      return mkText(tokenText(token));
  }
}

function wrapInline(tagName: "strong" | "em" | "del", tokens: Token[]): HTMLElement {
  const el = mkEl(tagName);
  el.append(renderInlineTokens(tokens));
  return el;
}

function renderLink(token: Tokens.Link): HTMLElement {
  const href = safeHref(token.href);
  const el = href ? mkEl("a") : mkEl("span");
  el.append(renderInlineTokens(token.tokens));
  if (href && el instanceof HTMLAnchorElement) {
    el.href = href;
    el.target = "_blank";
    el.rel = "noreferrer noopener";
    if (token.title) el.title = token.title;
  }
  return el;
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function tokenText(token: Token): string {
  if ("text" in token && typeof token.text === "string") return token.text;
  if ("raw" in token && typeof token.raw === "string") return token.raw;
  return "";
}

type RenderCodeBlockOptions = { highlight?: boolean };

const HIGHLIGHT_CACHE_LIMIT = 200;
const highlightCache = new Map<string, { html: string; className: string }>();

// Syntax highlighting dominates transcript render cost, and the streaming reconciler
// rebuilds a message's whole body on every delta. Memoize by (lang, code) so already
// settled code blocks are re-highlighted at most once instead of on every tick. LRU by
// reinsertion: blocks read each tick stay warm; transient (growing-block) keys age out.
function highlightToHtml(lang: string, code: string): { html: string; className: string } {
  // Length-prefix `lang` so the separator can never be ambiguous when either field
  // itself contains U+0000 (no aliasing between distinct (lang, code) pairs).
  const key = `${lang.length}\u0000${lang}${code}`;
  const cached = highlightCache.get(key);
  if (cached) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  const result = lang && hljs.getLanguage(lang)
    ? { html: hljs.highlight(code, { language: lang }).value, className: `hljs language-${lang}` }
    : { html: hljs.highlightAuto(code).value, className: "hljs" };
  highlightCache.set(key, result);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return result;
}

// A fenced block with no closing ``` yet is still streaming. An unterminated fence
// always consumes the rest of the input, so it can only ever be the last token.
function isUnterminatedFence(raw: string): boolean {
  const opening = raw.match(/^(`{3,}|~{3,})/);
  if (!opening) return false; // indented code block: complete by construction
  const trimmed = raw.replace(/\s+$/, "");
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return true; // only the opening fence typed so far
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  // A closing fence must be the same marker and at least as long as the opener.
  const closing = opening[1][0] === "`" ? /^`+$/ : /^~+$/;
  return !(closing.test(lastLine) && lastLine.length >= opening[1].length);
}

export function renderCodeBlock(lang: string, code: string, options: RenderCodeBlockOptions = {}): HTMLElement {
  const highlight = options.highlight ?? true;
  if (highlight && lang.trim().toLowerCase() === "mermaid") {
    return renderMermaidBlock(code);
  }
  if (highlight && lang.trim().toLowerCase() === "textile") {
    return renderTextileBlock(code);
  }

  const wrapper = mkEl("div");
  wrapper.className = "code-block";

  const header = mkEl("div");
  header.className = "code-block-header";

  const langLabel = mkEl("span");
  langLabel.className = "code-lang";
  langLabel.textContent = lang || "text";

  const copyBtn = mkEl("button");
  copyBtn.type = "button";
  copyBtn.className = "code-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    const owner = wrapper.ownerDocument;
    const copied = await copyTextToClipboard(code, owner);
    copyBtn.textContent = copied ? "Copied" : "Copy failed";
    (owner.defaultView ?? window).setTimeout(() => { copyBtn.textContent = "Copy"; }, 900);
  });

  header.append(langLabel, copyBtn);
  wrapper.append(header);

  const pre = mkEl("pre");
  const codeEl = mkEl("code");
  if (highlight) {
    const { html, className } = highlightToHtml(lang, code);
    codeEl.innerHTML = html;
    codeEl.className = className;
  } else {
    // Plain until the fence closes; keep the hljs surface so only token colors change later.
    codeEl.textContent = code;
    codeEl.className = "hljs";
  }
  pre.append(codeEl);
  wrapper.append(pre);
  return wrapper;
}

type RenderBlockOptions = {
  thinkingVisibilityMode: ThinkingVisibilityMode;
};

export function renderBlock(
  block: ContentBlock,
  isNew: boolean,
  messageId: string,
  blockIndex: number,
  options: RenderBlockOptions,
): HTMLElement {
  if (block.kind === "text") {
    const wrapper = mkEl("div");
    wrapper.className = "text-block";
    wrapper.dataset.messageId = messageId;
    wrapper.dataset.blockIndex = String(blockIndex);
    wrapper.dataset.blockKind = "text";
    wrapper.append(renderMarkdown(block.text));
    return wrapper;
  }

  if (block.kind === "image") {
    const wrapper = renderImageAttachment(block, "image-block");
    wrapper.dataset.messageId = messageId;
    wrapper.dataset.blockIndex = String(blockIndex);
    wrapper.dataset.blockKind = "image";
    return wrapper;
  }

  if (block.kind === "thinking") {
    const details = mkEl("details");
    details.className = "thinking-block";
    details.dataset.messageId = messageId;
    details.dataset.blockIndex = String(blockIndex);
    details.dataset.blockKind = "thinking";
    // The frontend visibility mode is UI-only; OMP still keeps the complete transcript.
    details.open = options.thinkingVisibilityMode === "shown" || isNew;

    const summary = mkEl("summary");
    summary.className = "thinking-label";
    summary.textContent = "Thinking…";
    details.append(summary);

    const pre = mkEl("pre");
    pre.className = "thinking-content";
    pre.textContent = block.thinking;
    details.append(pre);

    return details;
  }

  // redactedthinking — show static label, no data
  const span = mkEl("p");
  span.className = "thinking-label thinking-redacted";
  span.dataset.messageId = messageId;
  span.dataset.blockIndex = String(blockIndex);
  span.dataset.blockKind = "redactedthinking";
  span.textContent = "Thinking… (redacted by provider)";
  return span;
}
