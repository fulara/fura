import { copyTextToClipboard } from "./dom";
import type { GitFileContent } from "./protocol";

export function openCommittedFileView(
  owner: Document,
  repoRoot: string,
  commitOid: string,
  path: string,
  onClose: () => void,
): { close(): void; show(file: GitFileContent | null, error: string | null): void } {
  const previousFocus = owner.activeElement as HTMLElement | null;
  const dialog = owner.createElement("dialog");
  dialog.className = "git-file-dialog";
  dialog.setAttribute("aria-label", "Committed file");
  const header = owner.createElement("header");
  const title = owner.createElement("strong");
  title.textContent = "Committed file · read-only";
  const copy = owner.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy file";
  copy.disabled = true;
  let content: string | null = null;
  copy.addEventListener("click", () => { if (content !== null) void copyTextToClipboard(content, owner); });
  const close = owner.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  header.append(title, copy, close);
  const origin = owner.createElement("p");
  origin.className = "git-file-origin";
  origin.textContent = `${repoRoot}\n${path}\nCommit ${commitOid} — not the current working-tree file`;
  const status = owner.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Loading committed file…";
  const pre = owner.createElement("pre");
  pre.className = "git-file-content";
  dialog.append(header, origin, status, pre);
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose();
    previousFocus?.focus();
  });
  owner.body.append(dialog);
  dialog.showModal();
  return {
    close() { dialog.close(); },
    show(file, error) {
      if (!file) {
        status.setAttribute("role", "alert");
        status.textContent = error || "Committed file is unavailable.";
        return;
      }
      content = file.text;
      copy.disabled = false;
      status.textContent = `Blob ${file.blobOid}`;
      pre.textContent = file.text;
    },
  };
}
