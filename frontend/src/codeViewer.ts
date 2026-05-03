import { setRenderDocument, mkEl } from "./dom";
import { renderCodeBlock } from "./transcriptView";
import type { CodeFileContent, CodeTreeEntry, CodeWorkspaceSummary } from "./protocol";

export type CodeViewerState = {
  activeSessionId: string | null;
  workspace: CodeWorkspaceSummary | null;
  treePath: string;
  entries: CodeTreeEntry[];
  file: CodeFileContent | null;
  loadingWorkspace: boolean;
  loadingTree: boolean;
  loadingFile: boolean;
  error: string | null;
};

export type CodeViewerActions = {
  openWorkspace(): void;
  listTree(path: string): void;
  refreshTree(): void;
  openFile(path: string): void;
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
  main.append(renderCodeMain(state));

  root.append(sidebar, main);
  container.append(root);
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
  refresh.disabled = state.loadingWorkspace || !state.activeSessionId;
  refresh.addEventListener("click", actions.openWorkspace);

  header.append(title, refresh);

  if (state.error) {
    const error = mkEl("p");
    error.className = "code-error";
    error.textContent = state.error;
    header.append(error);
  }

  return header;
}

function workspaceMeta(state: CodeViewerState): string {
  if (!state.activeSessionId) return "Select a session to browse files.";
  if (state.loadingWorkspace) return "Opening workspace…";
  if (!state.workspace) return "Open the active session workspace.";
  return state.workspace.statusMessage || state.workspace.root;
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
  entry: CodeTreeEntry,
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

function renderCodeMain(state: CodeViewerState): HTMLElement {
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
  const path = mkEl("code");
  path.textContent = state.file.path;
  const meta = mkEl("span");
  meta.textContent = `${state.file.language || "text"} · ${formatCodeFileSize(state.file.size)} · read-only`;
  title.append(path, meta);

  const copy = mkEl("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.file?.text ?? "");
    copy.textContent = "Copied";
    window.setTimeout(() => { copy.textContent = "Copy"; }, 900);
  });

  header.append(title, copy);
  view.append(header);

  const codeBlock = renderCodeBlock(state.file.language, state.file.text);
  codeBlock.classList.add("code-file-block");
  view.append(codeBlock);
  return view;
}

function renderEmptyMain(text: string): HTMLElement {
  const empty = mkEl("p");
  empty.className = "code-empty code-empty-main";
  empty.textContent = text;
  return empty;
}

function normalizeCodePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}
