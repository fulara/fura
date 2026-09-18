import type { ClientMessage, ServerMessage } from "./protocol";
import "./diffFilePicker.css";

const lastDirectoryKey = "fura.diff.lastDirectory";
let requestSequence = 0;

export type DiffFilePicker = {
  close(): void;
  handleMessage(message: ServerMessage): void;
};

export function openDiffFilePicker(
  owner: Document,
  initialDirectory: string,
  send: (message: ClientMessage) => boolean,
  onOpen: (file: Extract<ServerMessage, { type: "diffFile.opened" }>) => void,
  onClose: () => void,
): DiffFilePicker {
  const previousFocus = owner.activeElement as HTMLElement | null;
  const dialog = owner.createElement("dialog");
  dialog.className = "diff-file-picker";
  dialog.setAttribute("aria-label", "Open diff");
  const header = owner.createElement("header");
  const title = owner.createElement("strong");
  title.textContent = "Open diff";
  const closeButton = owner.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  header.append(title, closeButton);
  const description = owner.createElement("p");
  description.textContent = "Files on Fura server · Open a patch read-only. Nothing will be applied.";

  const directoryForm = owner.createElement("form");
  directoryForm.className = "diff-file-picker-path";
  const directoryLabel = owner.createElement("label");
  directoryLabel.textContent = "Directory path";
  const directoryInput = owner.createElement("input");
  directoryInput.type = "text";
  directoryInput.autocomplete = "off";
  directoryInput.spellcheck = false;
  directoryInput.value = initialDirectory;
  try {
    directoryInput.value = owner.defaultView?.localStorage.getItem(lastDirectoryKey) || initialDirectory;
  } catch { /* Storage may be unavailable in a popout or private browsing. */ }
  directoryLabel.append(directoryInput);
  const goButton = owner.createElement("button");
  goButton.type = "submit";
  goButton.textContent = "Go";
  const upButton = owner.createElement("button");
  upButton.type = "button";
  upButton.textContent = "Up";
  upButton.disabled = true;
  directoryForm.append(directoryLabel, goButton, upButton);

  const listingPath = owner.createElement("p");
  listingPath.className = "diff-file-picker-location";
  const entries = owner.createElement("ul");
  entries.className = "diff-file-picker-entries";
  entries.setAttribute("aria-label", "Server directories and patch files");
  const listingStatus = owner.createElement("p");
  listingStatus.className = "diff-file-picker-listing-status";
  listingStatus.textContent = "Showing directories and .diff / .patch files. You can type any file path below.";

  const fileForm = owner.createElement("form");
  fileForm.className = "diff-file-picker-path";
  const fileLabel = owner.createElement("label");
  fileLabel.textContent = "File path";
  const fileInput = owner.createElement("input");
  fileInput.type = "text";
  fileInput.autocomplete = "off";
  fileInput.spellcheck = false;
  fileInput.required = true;
  fileInput.placeholder = "Absolute server path to a diff or patch";
  fileLabel.append(fileInput);
  const openButton = owner.createElement("button");
  openButton.type = "submit";
  openButton.textContent = "Open";
  fileForm.append(fileLabel, openButton);
  const status = owner.createElement("p");
  status.className = "diff-file-picker-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  const footer = owner.createElement("footer");
  const cancelButton = owner.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  footer.append(cancelButton);
  dialog.append(header, description, directoryForm, listingPath, entries, listingStatus, fileForm, status, footer);

  let closed = false;
  let parentPath: string | null = null;
  let pending: { requestId: string; type: "diffFile.list" | "diffFile.open"; path: string } | null = null;

  function rememberDirectory(path: string): void {
    try { owner.defaultView?.localStorage.setItem(lastDirectoryKey, path); } catch { /* Browsing still works without storage. */ }
  }

  function showStatus(message: string, error = false): void {
    status.setAttribute("role", error ? "alert" : "status");
    status.classList.toggle("is-error", error);
    status.textContent = message;
  }

  function invalidateRequest(): void {
    if (!pending) return;
    pending = null;
    entries.removeAttribute("aria-busy");
    showStatus("Selection changed. Choose Go to browse or Open to read the file.");
  }

  function request(type: "diffFile.list" | "diffFile.open", path: string): void {
    if (closed) return;
    invalidateRequest();
    const requestId = `diff-file-${Date.now()}-${++requestSequence}`;
    pending = { requestId, type, path };
    entries.setAttribute("aria-busy", String(type === "diffFile.list"));
    showStatus(type === "diffFile.list" ? "Loading server directory…" : "Opening patch…");
    if (!send({ type, requestId, path }) && pending?.requestId === requestId) {
      pending = null;
      entries.removeAttribute("aria-busy");
      showStatus("Disconnected from Fura server. Reconnect, then choose Go or Open to retry.", true);
    }
  }

  function openFile(): void {
    if (!fileInput.value) {
      invalidateRequest();
      showStatus("Choose a patch file or enter its server path, then choose Open.", true);
      fileInput.focus();
      return;
    }
    request("diffFile.open", fileInput.value);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    pending = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    previousFocus?.focus();
    onClose();
  }

  directoryInput.addEventListener("input", invalidateRequest);
  fileInput.addEventListener("input", invalidateRequest);
  directoryForm.addEventListener("submit", event => {
    event.preventDefault();
    request("diffFile.list", directoryInput.value);
  });
  upButton.addEventListener("click", () => {
    if (parentPath !== null) request("diffFile.list", parentPath);
  });
  fileForm.addEventListener("submit", event => {
    event.preventDefault();
    openFile();
  });
  closeButton.addEventListener("click", close);
  cancelButton.addEventListener("click", close);
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", close);
  owner.body.append(dialog);
  dialog.showModal();
  directoryInput.focus();
  request("diffFile.list", directoryInput.value);

  return {
    close,
    handleMessage(message) {
      if (closed || !pending || !("requestId" in message) || message.requestId !== pending.requestId) return;
      if (message.type === "diffFile.error") {
        const action = pending.type === "diffFile.list" ? "Go" : "Open";
        const path = pending.path;
        pending = null;
        entries.removeAttribute("aria-busy");
        showStatus(`${message.message} Path: ${path || "(server default)"}. Check the path or permissions, then choose ${action} to retry.`, true);
      } else if (message.type === "diffFile.listed" && pending.type === "diffFile.list") {
        pending = null;
        entries.removeAttribute("aria-busy");
        parentPath = message.parentPath;
        upButton.disabled = parentPath === null;
        directoryInput.value = message.path;
        fileInput.value = "";
        listingPath.textContent = message.path;
        rememberDirectory(message.path);
        const hadEntryFocus = entries.contains(owner.activeElement);
        entries.replaceChildren();
        for (const entry of message.entries) {
          const item = owner.createElement("li");
          const button = owner.createElement("button");
          button.type = "button";
          button.className = "diff-file-picker-entry";
          button.textContent = entry.isDirectory ? `${entry.name}/` : entry.name;
          button.title = entry.path;
          button.setAttribute("aria-label", `${entry.isDirectory ? "Directory" : "Patch file"}: ${entry.name}`);
          button.addEventListener("click", () => {
            if (entry.isDirectory) {
              request("diffFile.list", entry.path);
            } else {
              invalidateRequest();
              fileInput.value = entry.path;
              for (const selected of entries.querySelectorAll(".is-selected")) selected.classList.remove("is-selected");
              button.classList.add("is-selected");
              showStatus("File selected. Choose Open to read it.");
            }
          });
          if (!entry.isDirectory) button.addEventListener("dblclick", openFile);
          item.append(button);
          entries.append(item);
        }
        listingStatus.textContent = message.truncated
          ? "Directory listing limited to 1,000 entries. More entries may exist; enter a directory or file path directly."
          : "Showing directories and .diff / .patch files. You can type any file path below.";
        showStatus(message.entries.length ? "Choose a directory to browse or a patch file to open." : "No directories or .diff / .patch files in this folder. You can enter a file path below.");
        if (hadEntryFocus) directoryInput.focus();
      } else if (message.type === "diffFile.opened" && pending.type === "diffFile.open") {
        const separator = message.path.includes("/") ? message.path.lastIndexOf("/") : message.path.lastIndexOf("\\");
        if (separator >= 0) {
          const isRoot = separator === 0 || (separator === 2 && message.path[1] === ":");
          rememberDirectory(message.path.slice(0, separator + (isRoot ? 1 : 0)));
        }
        // Finish picker teardown before the caller installs the opened-file view.
        close();
        onOpen(message);
      }
    },
  };
}
