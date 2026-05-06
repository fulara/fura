export type DiffFilterFocusSnapshot = {
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
};

export function captureDiffFilterFocus(container: HTMLElement): DiffFilterFocusSnapshot | null {
  const active = container.ownerDocument.activeElement;
  const InputCtor = container.ownerDocument.defaultView?.HTMLInputElement;
  if (!InputCtor || !(active instanceof InputCtor) || !active.classList.contains("diff-filter-input")) return null;
  return {
    focused: true,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
  };
}

export function restoreDiffFilterFocus(container: HTMLElement, snapshot: DiffFilterFocusSnapshot | null): void {
  if (!snapshot?.focused) return;
  const input = container.querySelector<HTMLInputElement>(".diff-filter-input");
  if (!input) return;
  input.focus();
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}
