let renderDocument: Document = document;

export function setRenderDocument(owner: Document): void {
  renderDocument = owner;
}

/**
 * Copy `text` to the clipboard, resilient to the failure modes that made the GUI
 * copy buttons intermittently do nothing:
 *  - Panels popped out into a separate window render their nodes in that window's
 *    document. Calling the main window's `navigator.clipboard` while the popout
 *    holds focus rejects with "Document is not focused", so the click silently
 *    failed. We resolve the clipboard from the owning document's window instead.
 *  - Transient focus loss and non-secure contexts: we fall back to the
 *    synchronous `execCommand("copy")` path and never let a rejection escape
 *    unhandled.
 * Returns whether the text reached the clipboard.
 */
export async function copyTextToClipboard(text: string, owner: Document = document): Promise<boolean> {
  const view = owner.defaultView ?? window;
  const clipboard = view.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (unfocused document, popout, non-secure context).
    }
  }
  return legacyCopyText(text, owner);
}

function legacyCopyText(text: string, owner: Document): boolean {
  if (typeof owner.execCommand !== "function" || !owner.body) return false;
  const active = owner.activeElement as HTMLElement | null;
  const selection = owner.getSelection ? owner.getSelection() : null;
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];

  const textarea = owner.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;";
  owner.body.append(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = owner.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();
  if (selection) {
    selection.removeAllRanges();
    for (const range of savedRanges) selection.addRange(range);
  }
  active?.focus?.();
  return copied;
}

export function mkEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return renderDocument.createElement(tag);
}

export function mkText(text: string): Text {
  return renderDocument.createTextNode(text);
}

export function mkFrag(): DocumentFragment {
  return renderDocument.createDocumentFragment();
}

export function reconcileChildren(container: HTMLElement, desiredNodes: readonly Node[]): void {
  let cursor = container.firstChild;
  for (const node of desiredNodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

export function requireElement<T extends HTMLElement>(id: string, owner: Document = document): T {
  const element = owner.getElementById(id);
  if (!element) {
    throw new Error(`#${id} missing`);
  }
  return element as T;
}
