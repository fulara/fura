import hljs from "highlight.js/lib/common";
import { setRenderDocument, mkEl, copyTextToClipboard } from "./dom";
import type { CodeFileComment } from "./codeComments";
import type { CodeFileContent, CodeLocation, CodeStatus, CodeWorkspaceSummary } from "./protocol";

export type CodeReferencesState = {
  path: string;
  locations: CodeLocation[];
};

export type CodeViewerState = {
  activeSessionId: string | null;
  workspace: CodeWorkspaceSummary | null;
  treePath: string;
  entries: Array<{ name: string; path: string; kind: "directory" | "file"; size?: number | null }>;
  file: CodeFileContent | null;
  loadingWorkspace: boolean;
  loadingTree: boolean;
  loadingFile: boolean;
  error: string | null;
  searchOpen: boolean;
  searchBasePath: string;
  searchQuery: string;
  searchResults: Array<{ name: string; path: string; kind: "directory" | "file"; size?: number | null }>;
  searchLoading: boolean;
  searchError: string | null;
  fileComments: CodeFileComment[];
  // rust-analyzer navigation. `navSelection` carries an LSP position (0-based
  // line, UTF-16 character) for the inline definition/references actions.
  navSelection: { line: number; character: number } | null;
  analyzerStatus: CodeStatus | null;
  analyzerMessage: string | null;
  references: CodeReferencesState | null;
  // 1-based line to scroll to and flash after a navigation jump.
  pendingScrollLine: number | null;
};

export type CodeViewerActions = {
  openWorkspace(): void;
  listTree(path: string): void;
  refreshTree(): void;
  openFile(path: string): void;
  openSearch(): void;
  closeSearch(): void;
  updateSearchBasePath(path: string): void;
  updateSearchQuery(query: string): void;
  searchFiles(): void;
  openSearchResult(path: string): void;
  addComment(lineNumber: number, lineText: string): void;
  editComment(comment: CodeFileComment): void;
  deleteComment(comment: CodeFileComment): void;
  previewComments(): void;
  flushComments(): void;
  selectNavPosition(line: number, character: number): void;
  clearNavSelection(): void;
  goToDefinition(line: number, character: number): void;
  findReferences(line: number, character: number): void;
  openReference(location: CodeLocation): void;
  closeReferences(): void;
};

export function parentCodePath(path: string): string | null {
  const normalized = normalizeCodePath(path);
  if (!normalized) return null;
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

export function formatCodeFileSize(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderCodeViewer(
  container: HTMLElement,
  state: CodeViewerState,
  actions: CodeViewerActions,
): void {
  setRenderDocument(container.ownerDocument);
  container.replaceChildren();

  const root = mkEl("section");
  root.className = "code-viewer";

  const sidebar = mkEl("aside");
  sidebar.className = "code-sidebar";
  sidebar.append(renderCodeWorkspaceHeader(state, actions), renderCodeTree(state, actions));

  const main = mkEl("main");
  main.className = "code-main";
  main.append(renderCodeMain(state, actions));

  root.append(sidebar, main);
  container.append(root);

  if (state.searchOpen) root.append(renderFileSearchDialog(state, actions));
}

function renderCodeWorkspaceHeader(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const header = mkEl("header");
  header.className = "code-workspace-header";

  const title = mkEl("div");
  title.className = "code-workspace-title";
  const heading = mkEl("strong");
  heading.textContent = "Code";
  const meta = mkEl("span");
  meta.textContent = workspaceMeta(state);
  title.append(heading, meta);

  const refresh = mkEl("button");
  refresh.type = "button";
  refresh.textContent = state.workspace ? "Refresh" : "Open";
  refresh.disabled = state.loadingWorkspace || (!state.activeSessionId && state.workspace?.source !== "reviewWorktree");
  refresh.addEventListener("click", actions.openWorkspace);

  header.append(title, refresh);

  const hint = mkEl("span");
  hint.className = "code-hotkey-hint";
  hint.textContent = "Ctrl+F: search files";
  header.append(hint);

  if (state.error) {
    const error = mkEl("p");
    error.className = "code-error";
    error.textContent = state.error;
    header.append(error);
  }

  return header;
}

function workspaceMeta(state: CodeViewerState): string {
  if (state.loadingWorkspace) return "Opening workspace…";
  if (!state.workspace) {
    return state.activeSessionId ? "Open the active session workspace." : "Select a session or open a review worktree.";
  }
  const source = state.workspace.source === "reviewWorktree" ? "review worktree" : "session";
  const suffix = state.workspace.reviewWorktreeId ? ` · ${state.workspace.reviewWorktreeId.slice(0, 8)}` : "";
  return `${source}${suffix} · ${state.workspace.statusMessage || state.workspace.root}`;
}

function renderCodeTree(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const tree = mkEl("section");
  tree.className = "code-tree";

  const toolbar = mkEl("div");
  toolbar.className = "code-tree-toolbar";

  const path = mkEl("code");
  path.textContent = state.treePath || ".";

  const up = mkEl("button");
  up.type = "button";
  up.textContent = "Up";
  const parent = parentCodePath(state.treePath);
  up.disabled = !state.workspace || parent === null || state.loadingTree;
  up.addEventListener("click", () => {
    if (parent !== null) actions.listTree(parent);
  });

  const refresh = mkEl("button");
  refresh.type = "button";
  refresh.textContent = "Refresh tree";
  refresh.disabled = !state.workspace || state.loadingTree;
  refresh.addEventListener("click", actions.refreshTree);

  const actionsWrap = mkEl("div");
  actionsWrap.className = "code-tree-actions";
  actionsWrap.append(up, refresh);

  toolbar.append(path, actionsWrap);
  tree.append(toolbar);

  if (!state.workspace) {
    const empty = mkEl("p");
    empty.className = "code-empty";
    empty.textContent = state.activeSessionId ? "Open the workspace to list files." : "No session selected.";
    tree.append(empty);
    return tree;
  }

  if (state.loadingTree) {
    const loading = mkEl("p");
    loading.className = "code-empty";
    loading.textContent = "Loading files…";
    tree.append(loading);
    return tree;
  }

  if (state.entries.length === 0) {
    const empty = mkEl("p");
    empty.className = "code-empty";
    empty.textContent = "No visible files.";
    tree.append(empty);
    return tree;
  }

  const list = mkEl("div");
  list.className = "code-tree-list";
  for (const entry of state.entries) {
    list.append(renderTreeEntry(entry, state.file?.path ?? null, actions));
  }
  tree.append(list);
  return tree;
}

function renderTreeEntry(
  entry: CodeViewerState["entries"][number],
  activePath: string | null,
  actions: CodeViewerActions,
): HTMLElement {
  const button = mkEl("button");
  button.type = "button";
  button.className = `code-tree-entry code-tree-entry-${entry.kind}`;
  if (entry.kind === "file" && entry.path === activePath) button.classList.add("active");
  button.addEventListener("click", () => {
    if (entry.kind === "directory") actions.listTree(entry.path);
    else actions.openFile(entry.path);
  });

  const name = mkEl("span");
  name.className = "code-tree-entry-name";
  name.textContent = entry.kind === "directory" ? `${entry.name}/` : entry.name;

  const meta = mkEl("span");
  meta.className = "code-tree-entry-meta";
  meta.textContent = entry.kind === "file" ? formatCodeFileSize(entry.size) : "";

  button.append(name, meta);
  return button;
}

function renderFileSearchDialog(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const overlay = mkEl("div");
  overlay.className = "code-search-overlay";
  overlay.addEventListener("click", event => {
    if (event.target === overlay) actions.closeSearch();
  });

  const dialog = mkEl("section");
  dialog.className = "code-search-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Search files");

  const header = mkEl("header");
  const title = mkEl("strong");
  title.textContent = "Search files";
  const close = mkEl("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", actions.closeSearch);
  header.append(title, close);

  const form = mkEl("form");
  form.className = "code-search-form";
  form.addEventListener("submit", event => {
    event.preventDefault();
    actions.searchFiles();
  });

  const baseLabel = mkEl("label");
  baseLabel.textContent = "Base dir";
  const baseInput = mkEl("input");
  baseInput.id = "codeSearchBasePath";
  baseInput.value = state.searchBasePath;
  baseInput.spellcheck = false;
  baseInput.addEventListener("input", () => actions.updateSearchBasePath(baseInput.value));
  baseLabel.append(baseInput);

  const queryLabel = mkEl("label");
  queryLabel.textContent = "File name/path";
  const queryInput = mkEl("input");
  queryInput.id = "codeSearchQuery";
  queryInput.value = state.searchQuery;
  queryInput.placeholder = "main.rs";
  queryInput.spellcheck = false;
  queryInput.addEventListener("input", () => actions.updateSearchQuery(queryInput.value));
  queryInput.addEventListener("keydown", event => {
    if (event.key === "Escape") actions.closeSearch();
  });
  queryLabel.append(queryInput);

  const submit = mkEl("button");
  submit.type = "submit";
  submit.textContent = state.searchLoading ? "Searching…" : "Search";
  submit.disabled = state.searchLoading || !state.workspace || !state.searchQuery.trim();

  form.append(baseLabel, queryLabel, submit);

  const results = mkEl("div");
  results.className = "code-search-results";
  if (state.searchError) {
    const error = mkEl("p");
    error.className = "code-error";
    error.textContent = state.searchError;
    results.append(error);
  } else if (state.searchLoading) {
    results.append(renderSearchEmpty("Searching…"));
  } else if (!state.searchQuery.trim()) {
    results.append(renderSearchEmpty("Type a file name or path fragment."));
  } else if (state.searchResults.length === 0) {
    results.append(renderSearchEmpty("No matching files."));
  } else {
    for (const entry of state.searchResults) {
      const button = mkEl("button");
      button.type = "button";
      button.className = "code-search-result";
      const path = mkEl("code");
      path.textContent = entry.path;
      const meta = mkEl("span");
      meta.textContent = formatCodeFileSize(entry.size);
      button.append(path, meta);
      button.addEventListener("click", () => actions.openSearchResult(entry.path));
      results.append(button);
    }
  }

  dialog.append(header, form, results);
  overlay.append(dialog);
  window.setTimeout(() => queryInput.focus(), 0);
  return overlay;
}

function renderCodeMain(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const view = mkEl("section");
  view.className = "code-file-view";

  if (!state.activeSessionId) {
    view.append(renderEmptyMain("Select a session to browse its workspace."));
    return view;
  }

  if (state.loadingFile) {
    view.append(renderEmptyMain("Opening file…"));
    return view;
  }

  if (!state.file) {
    view.append(renderEmptyMain("Choose a file from the Code panel."));
    return view;
  }

  const header = mkEl("header");
  header.className = "code-file-header";
  const title = mkEl("div");
  title.className = "code-file-title";
  const path = mkEl("code");
  path.className = "code-file-path";
  path.title = state.file.path;
  path.textContent = state.file.path;
  const meta = mkEl("span");
  const navHint = state.workspace?.rustRoot ? " · click a symbol for definition / references" : "";
  meta.textContent = `${state.file.language || "text"} · ${formatCodeFileSize(state.file.size)} · read-only${navHint}`;
  title.append(path, meta);

  const actionsBar = mkEl("div");
  actionsBar.className = "code-file-actions";

  const preview = mkEl("button");
  preview.type = "button";
  preview.textContent = "Preview comments";
  preview.disabled = state.fileComments.length === 0;
  preview.addEventListener("click", actions.previewComments);

  const flush = mkEl("button");
  flush.type = "button";
  flush.textContent = `Preview & flush (${state.fileComments.length})`;
  flush.disabled = state.fileComments.length === 0;
  flush.addEventListener("click", actions.flushComments);

  const copy = mkEl("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    const owner = copy.ownerDocument;
    const copied = await copyTextToClipboard(state.file?.text ?? "", owner);
    copy.textContent = copied ? "Copied" : "Copy failed";
    (owner.defaultView ?? window).setTimeout(() => { copy.textContent = "Copy"; }, 900);
  });

  actionsBar.append(preview, flush, copy);
  header.append(title, actionsBar);
  view.append(header);

  const status = renderAnalyzerStatus(state);
  if (status) view.append(status);

  const lines = renderCodeLines(state, actions);
  view.append(lines);

  if (state.references) view.append(renderReferencesPanel(state, actions));
  return view;
}

function renderCodeLines(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const container = mkEl("div");
  container.className = "code-review-lines";
  const file = state.file;
  if (!file) return container;

  const lines = codeFileLines(file.text);
  for (const [index, lineText] of lines.entries()) {
    const lineNumber = index + 1;
    const lineComments = state.fileComments.filter(comment => comment.lineNumber === lineNumber && comment.lineText === lineText);
    const lineWrap = mkEl("div");
    lineWrap.className = "code-line-wrap";

    const line = mkEl("div");
    line.className = "code-line";

    const commentBtn = mkEl("button");
    commentBtn.type = "button";
    commentBtn.className = `diff-comment-btn ${lineComments.length > 0 ? "has-comments" : ""}`;
    commentBtn.textContent = lineComments.length > 0 ? String(lineComments.length) : "+";
    commentBtn.title = "Comment on this code line";
    commentBtn.addEventListener("click", () => actions.addComment(lineNumber, lineText));

    const gutter = mkEl("span");
    gutter.className = "diff-gutter";
    gutter.textContent = String(lineNumber);

    const content = mkEl("div");
    content.className = "code-line-content";
    const codeEl = mkEl("code");
    const renderText = lineText.length === 0 ? " " : lineText;
    if (file.language && hljs.getLanguage(file.language)) {
      codeEl.innerHTML = hljs.highlight(renderText, { language: file.language }).value;
      codeEl.className = `hljs language-${file.language}`;
    } else {
      codeEl.textContent = renderText;
    }
    content.append(codeEl);
    content.addEventListener("click", event => {
      const position = navPositionFromClick(event, codeEl, index);
      if (position) actions.selectNavPosition(position.line, position.character);
    });

    line.append(commentBtn, gutter, content);
    lineWrap.append(line);

    if (state.navSelection && state.navSelection.line === index) {
      lineWrap.append(renderNavActions(state.navSelection, actions));
    }

    if (state.pendingScrollLine === lineNumber) {
      lineWrap.classList.add("code-line-flash");
      scheduleScrollIntoView(lineWrap);
    }

    if (lineComments.length > 0) {
      const thread = mkEl("div");
      thread.className = "diff-inline-comments code-inline-comments";
      for (const comment of lineComments) {
        thread.append(renderCodeCommentItem(comment, actions));
      }
      lineWrap.append(thread);
    }

    container.append(lineWrap);
  }

  if (state.fileComments.length > 0) {
    const commentsPanel = mkEl("section");
    commentsPanel.className = "diff-comments code-comments";
    const title = mkEl("strong");
    title.textContent = "Comments";
    commentsPanel.append(title);
    for (const comment of state.fileComments) {
      const item = mkEl("article");
      item.className = "diff-comment";
      const loc = mkEl("code");
      loc.textContent = `${comment.path}:${comment.lineNumber}`;
      item.append(loc, renderCodeCommentItem(comment, actions));
      commentsPanel.append(item);
    }
    container.append(commentsPanel);
  }

  return container;
}

function renderNavActions(
  selection: { line: number; character: number },
  actions: CodeViewerActions,
): HTMLElement {
  const bar = mkEl("div");
  bar.className = "code-nav-actions";
  const label = mkEl("span");
  label.className = "code-nav-actions-label";
  label.textContent = `Line ${selection.line + 1}, col ${selection.character + 1}`;

  const definition = mkEl("button");
  definition.type = "button";
  definition.textContent = "Go to definition";
  definition.addEventListener("click", () =>
    actions.goToDefinition(selection.line, selection.character),
  );

  const references = mkEl("button");
  references.type = "button";
  references.textContent = "Find references";
  references.addEventListener("click", () =>
    actions.findReferences(selection.line, selection.character),
  );

  const dismiss = mkEl("button");
  dismiss.type = "button";
  dismiss.className = "code-nav-actions-dismiss";
  dismiss.textContent = "×";
  dismiss.title = "Dismiss";
  dismiss.addEventListener("click", actions.clearNavSelection);

  bar.append(label, definition, references, dismiss);
  return bar;
}

const ANALYZER_STATUS_TEXT: Partial<Record<CodeStatus, string>> = {
  starting: "rust-analyzer is starting…",
  indexing: "rust-analyzer is indexing the workspace…",
  unavailable: "rust-analyzer is unavailable",
  error: "rust-analyzer error",
};

function renderAnalyzerStatus(state: CodeViewerState): HTMLElement | null {
  const status = state.analyzerStatus;
  if (!status || status === "ready") return null;
  if (status === "filesOnly") {
    if (!state.analyzerMessage) return null;
    const info = mkEl("div");
    info.className = "code-analyzer-status code-analyzer-status-info";
    info.textContent = state.analyzerMessage;
    return info;
  }
  const base = ANALYZER_STATUS_TEXT[status];
  if (!base) return null;
  const strip = mkEl("div");
  const severity = status === "unavailable" || status === "error" ? "error" : "busy";
  strip.className = `code-analyzer-status code-analyzer-status-${severity}`;
  strip.textContent = state.analyzerMessage ? `${base}: ${state.analyzerMessage}` : base;
  return strip;
}

function renderReferencesPanel(state: CodeViewerState, actions: CodeViewerActions): HTMLElement {
  const references = state.references;
  const panel = mkEl("section");
  panel.className = "code-references";

  const header = mkEl("header");
  header.className = "code-references-header";
  const title = mkEl("strong");
  const count = references ? references.locations.length : 0;
  title.textContent = `References (${count})`;
  const close = mkEl("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", actions.closeReferences);
  header.append(title, close);
  panel.append(header);

  if (!references || references.locations.length === 0) {
    panel.append(renderSearchEmpty("No references found."));
    return panel;
  }

  // Group locations by their containing file, preserving first-seen order.
  const groups = new Map<string, CodeLocation[]>();
  for (const location of references.locations) {
    const key = location.path ?? location.label ?? location.uri ?? "external";
    const bucket = groups.get(key);
    if (bucket) bucket.push(location);
    else groups.set(key, [location]);
  }

  for (const [key, locations] of groups) {
    const group = mkEl("div");
    group.className = "code-references-group";
    const groupTitle = mkEl("code");
    groupTitle.className = "code-references-path";
    groupTitle.textContent = key;
    group.append(groupTitle);

    for (const location of locations) {
      const lineNumber = location.range.start.line + 1;
      if (location.kind === "local" && location.path) {
        const entry = mkEl("button");
        entry.type = "button";
        entry.className = "code-references-entry";
        entry.textContent = `Line ${lineNumber}`;
        entry.addEventListener("click", () => actions.openReference(location));
        group.append(entry);
      } else {
        const entry = mkEl("span");
        entry.className = "code-references-entry code-references-external";
        entry.textContent = `Line ${lineNumber} (external)`;
        group.append(entry);
      }
    }
    panel.append(group);
  }

  return panel;
}

function navPositionFromClick(
  event: MouseEvent,
  codeEl: HTMLElement,
  lineIndex: number,
): { line: number; character: number } | null {
  const doc = codeEl.ownerDocument;
  const view = doc.defaultView;
  // Ignore a click that completes a drag-to-copy on THIS line, but not when the
  // user merely has text selected elsewhere in the app.
  const selection = view?.getSelection();
  if (
    selection &&
    !selection.isCollapsed &&
    ((selection.anchorNode && codeEl.contains(selection.anchorNode)) ||
      (selection.focusNode && codeEl.contains(selection.focusNode)))
  ) {
    return null;
  }
  const caret = caretFromPoint(doc, event.clientX, event.clientY);
  if (!caret || !codeEl.contains(caret.node)) return null;
  return { line: lineIndex, character: utf16ColumnWithin(codeEl, caret.node, caret.offset) };
}

function caretFromPoint(
  doc: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const candidate = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof candidate.caretPositionFromPoint === "function") {
    const position = candidate.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof candidate.caretRangeFromPoint === "function") {
    const range = candidate.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/// Compute the UTF-16 column (LSP `character`) of a caret within a line's
/// `<code>` element. DOM text offsets are already UTF-16 code units, so the
/// length of the text preceding the caret is exactly the column.
export function utf16ColumnWithin(codeEl: HTMLElement, node: Node, offset: number): number {
  const range = codeEl.ownerDocument.createRange();
  range.selectNodeContents(codeEl);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

function scheduleScrollIntoView(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView;
  const run = () => element.scrollIntoView({ block: "center" });
  if (view && typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(run);
  else run();
}

function renderCodeCommentItem(comment: CodeFileComment, actions: CodeViewerActions): HTMLElement {
  const item = mkEl("div");
  item.className = "diff-inline-comment review-comment-item";
  const body = mkEl("span");
  body.textContent = comment.text;
  const controls = mkEl("span");
  controls.className = "review-comment-actions";
  const edit = mkEl("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => actions.editComment(comment));
  const remove = mkEl("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => actions.deleteComment(comment));
  controls.append(edit, remove);
  item.append(body, controls);
  return item;
}

function renderEmptyMain(text: string): HTMLElement {
  const empty = mkEl("p");
  empty.className = "code-empty code-empty-main";
  empty.textContent = text;
  return empty;
}

function renderSearchEmpty(text: string): HTMLElement {
  const empty = mkEl("p");
  empty.className = "code-empty";
  empty.textContent = text;
  return empty;
}

function codeFileLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function normalizeCodePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}
