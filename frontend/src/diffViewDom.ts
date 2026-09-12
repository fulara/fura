export type DiffFilterFocusSnapshot = {
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
};

export function captureDiffFilterFocus(container: HTMLElement): DiffFilterFocusSnapshot | null {
  if (!container.ownerDocument.hasFocus()) return null;
  const active = container.ownerDocument.activeElement;
  const InputCtor = container.ownerDocument.defaultView?.HTMLInputElement;
  if (!InputCtor || !(active instanceof InputCtor) || !container.contains(active) || !active.classList.contains("diff-filter-input")) return null;
  return {
    focused: true,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
  };
}

export function restoreDiffFilterFocus(container: HTMLElement, snapshot: DiffFilterFocusSnapshot | null): void {
  if (!snapshot?.focused || !container.ownerDocument.hasFocus()) return;
  const input = container.querySelector<HTMLInputElement>(".diff-filter-input");
  if (!input) return;
  input.focus({ preventScroll: true });
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

const diffScrollSelectors = [".diffs-main-body", ".diffs-sidebar-scroll", ".git-history-list", ".range-diff-output"];

export type DiffViewScroll = {
  target: string;
  positions: Array<{ selector: string; top: number; left: number }>;
};

export function captureDiffViewScroll(container: HTMLElement): DiffViewScroll | null {
  const target = container.querySelector<HTMLElement>(".diffs-view, .compare-view")?.dataset.reviewTarget;
  if (!target) return null;
  const positions: DiffViewScroll["positions"] = [];
  for (const selector of diffScrollSelectors) {
    const element = container.querySelector<HTMLElement>(selector);
    if (element) positions.push({ selector, top: element.scrollTop, left: element.scrollLeft });
  }
  return { target, positions };
}

export function restoreDiffViewScroll(container: HTMLElement, snapshot: DiffViewScroll | null): void {
  if (!snapshot || container.querySelector<HTMLElement>(".diffs-view, .compare-view")?.dataset.reviewTarget !== snapshot.target) return;
  for (const { selector, top, left } of snapshot.positions) {
    const element = container.querySelector<HTMLElement>(selector);
    if (element) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }
}
