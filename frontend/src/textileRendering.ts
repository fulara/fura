import createDOMPurify from "dompurify";
import textile from "textile-js";
import { copyTextToClipboard, mkEl } from "./dom";

const REDMINE_ISSUE_RE = /#(\d+)/g;
const ISSUE_LINK_SKIP_SELECTOR = "a, code, pre, kbd, samp, textarea";

let textileRedmineRootUrl: string | null = null;

function setButtonStatus(button: HTMLButtonElement, text: string, owner: Document, resetText: string): void {
  button.textContent = text;
  (owner.defaultView ?? window).setTimeout(() => {
    button.textContent = resetText;
    button.disabled = false;
  }, 900);
}

function normalizeTextileRedmineRootUrl(rootUrl?: string | null): string | null {
  const trimmed = rootUrl?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function setTextileRedmineRootUrl(rootUrl?: string | null): boolean {
  const next = normalizeTextileRedmineRootUrl(rootUrl);
  if (next === textileRedmineRootUrl) return false;
  textileRedmineRootUrl = next;
  return true;
}

function appendHeader(wrapper: HTMLElement, source: string): void {
  const header = mkEl("div");
  header.className = "textile-header mermaid-header";

  const label = mkEl("span");
  label.className = "textile-label mermaid-label";
  label.textContent = "textile";

  const actions = mkEl("div");
  actions.className = "textile-actions mermaid-actions";

  const copySource = mkEl("button");
  copySource.type = "button";
  copySource.className = "textile-action mermaid-action";
  copySource.textContent = "Copy source";
  copySource.addEventListener("click", async () => {
    copySource.disabled = true;
    const copied = await copyTextToClipboard(source, wrapper.ownerDocument);
    setButtonStatus(copySource, copied ? "Copied" : "Copy unavailable", wrapper.ownerDocument, "Copy source");
  });

  actions.append(copySource);
  header.append(label, actions);
  wrapper.append(header);
}

function appendSourceDetails(wrapper: HTMLElement, source: string): void {
  const details = mkEl("details");
  details.className = "textile-source mermaid-source";
  const summary = mkEl("summary");
  summary.textContent = "Textile source";
  const pre = mkEl("pre");
  const code = mkEl("code");
  code.textContent = source;
  pre.append(code);
  details.append(summary, pre);
  wrapper.append(details);
}

function appendFallbackPre(wrapper: HTMLElement, source: string): void {
  const pre = mkEl("pre");
  const code = mkEl("code");
  code.textContent = source;
  pre.append(code);
  wrapper.append(pre);
}

function linkRedmineIssues(root: HTMLElement): void {
  if (!textileRedmineRootUrl) return;
  const owner = root.ownerDocument;
  const filter = owner.defaultView?.NodeFilter ?? NodeFilter;
  const walker = owner.createTreeWalker(root, filter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current.nodeValue ?? "";
    if (current.nodeType === 3 && /#\d+/.test(text)) {
      const parent = current.parentElement;
      if (parent && !parent.closest(ISSUE_LINK_SKIP_SELECTOR)) textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    const fragment = owner.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(REDMINE_ISSUE_RE)) {
      const issueId = match[1];
      const index = match.index ?? 0;
      if (index > lastIndex) fragment.append(owner.createTextNode(text.slice(lastIndex, index)));
      const link = owner.createElement("a");
      link.href = `${textileRedmineRootUrl}/issues/${issueId}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `#${issueId}`;
      fragment.append(link);
      lastIndex = index + match[0].length;
    }
    if (lastIndex < text.length) fragment.append(owner.createTextNode(text.slice(lastIndex)));
    textNode.replaceWith(fragment);
  }
}

export function renderTextileBlock(source: string): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = "textile-block mermaid-block";

  if (!source.trim()) return wrapper;

  appendHeader(wrapper, source);

  const preview = mkEl("div");
  preview.className = "textile-preview mermaid-preview";
  wrapper.append(preview);

  try {
    const html = textile(source);
    const view = wrapper.ownerDocument.defaultView ?? window;
    const sanitized = createDOMPurify(view).sanitize(html, { USE_PROFILES: { html: true } });
    if (!sanitized.trim()) {
      appendFallbackPre(preview, source);
    } else {
      preview.innerHTML = sanitized;
      linkRedmineIssues(preview);
    }
    appendSourceDetails(wrapper, source);
  } catch {
    wrapper.dataset.textileState = "error";
    preview.classList.add("textile-error", "mermaid-error");
    preview.replaceChildren();
    appendFallbackPre(preview, source);
  }

  return wrapper;
}
