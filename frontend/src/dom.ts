let renderDocument: Document = document;

export function setRenderDocument(owner: Document): void {
  renderDocument = owner;
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
