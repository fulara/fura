import hljs from "highlight.js/lib/common";
import { marked, type Token, type Tokens } from "marked";
import { mkEl, mkFrag, mkText } from "./dom";
import type { ContentBlock, TranscriptMessage } from "./protocol";
import type { ThinkingVisibilityMode } from "./uiPreferences";

export function messageText(message: TranscriptMessage): string {
  return message.blocks
    .map(block => {
      if (block.kind === "text") return block.text;
      if (block.kind === "thinking") return `<thinking>\n${block.thinking}\n</thinking>`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function renderMarkdown(text: string): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "markdown-body";

  const tokens = marked.lexer(text.trim());
  for (const token of tokens) {
    const node = renderMarkdownToken(token);
    if (node) wrapper.append(node);
  }

  if (!wrapper.hasChildNodes() && text.trim()) {
    const p = mkEl("p");
    p.textContent = text.trim();
    wrapper.append(p);
  }

  return wrapper;
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

export function renderCodeBlock(lang: string, code: string): HTMLElement {
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
    await navigator.clipboard.writeText(code);
    copyBtn.textContent = "Copied";
    window.setTimeout(() => { copyBtn.textContent = "Copy"; }, 900);
  });

  header.append(langLabel, copyBtn);
  wrapper.append(header);

  const pre = mkEl("pre");
  const codeEl = mkEl("code");
  if (lang && hljs.getLanguage(lang)) {
    codeEl.innerHTML = hljs.highlight(code, { language: lang }).value;
    codeEl.className = `hljs language-${lang}`;
  } else {
    codeEl.innerHTML = hljs.highlightAuto(code).value;
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
