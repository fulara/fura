import type {
  ConflictAgentResult,
  ConflictFileSummary,
  ConflictFileKind,
  ConflictFileBuffer,
  ConflictFileState,
  ConflictMagicWandPreview,
  ConflictRepositorySummary,
} from "./protocol";

export type ConflictResolutionMode = "current" | "incoming" | "currentThenIncoming" | "incomingThenCurrent";

export type DraftConflictRegion = {
  id: string;
  startLine: number;
  separatorLine: number | null;
  endLine: number;
};

export type DraftSelectionState = {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  focused: boolean;
};

export type ConflictResolverState = {
  root: string | null;
  repos: ConflictRepositorySummary[];
  selectedRepoId: string | null;
  selectedPath: string | null;
  file: ConflictFileState | null;
  draftResult: string;
  selectedConflictId: string | null;
  draftDirty: boolean;
  saving: boolean;
  staging: boolean;
  previewingMagicWand: boolean;
  wandPreview: ConflictMagicWandPreview | null;
  requestingAgentAssistance: boolean;
  agentInstructions: string;
  agentResult: ConflictAgentResult | null;
  status: string | null;
  loadingScan: boolean;
  loadingFile: boolean;
  error: string | null;
};

export type ConflictResolverActions = {
  refresh(): void;
  selectFile(repoId: string, path: string): void;
  leave(): void;
  updateResult(text: string, selection: DraftSelectionState): void;
  selectConflict(conflictId: string): void;
  shiftConflict(offset: -1 | 1): void;
  resolveConflict(mode: ConflictResolutionMode): void;
  previewMagicWand(): void;
  applyMagicWandPreview(): void;
  discardMagicWandPreview(): void;
  updateAgentInstructions(text: string): void;
  requestAgentExplain(): void;
  requestAgentProposeConflict(): void;
  requestAgentProposeFile(): void;
  applyAgentResult(): void;
  discardAgentResult(): void;
  saveResult(): void;
  stageResolved(): void;
};

export function renderConflictResolver(
  container: HTMLElement,
  state: ConflictResolverState,
  actions: ConflictResolverActions,
): void {
  const owner = container.ownerDocument;
  const root = owner.createElement("div");
  root.className = "conflict-resolver";

  const sidebar = owner.createElement("aside");
  sidebar.className = "conflict-sidebar";
  sidebar.append(renderSidebarHeader(owner, state, actions));

  const list = owner.createElement("div");
  list.className = "conflict-file-list";
  renderFileList(owner, list, state, actions);
  sidebar.append(list);

  const main = owner.createElement("section");
  main.className = "conflict-main";
  renderMain(owner, main, state, actions);

  root.append(sidebar, main);
  container.replaceChildren(root);
}

export function draftConflictRegions(text: string): DraftConflictRegion[] {
  const regions: DraftConflictRegion[] = [];
  let startLine: number | null = null;
  let separatorLine: number | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    const lineNumber = index + 1;
    if (line.startsWith("<<<<<<<") && startLine === null) {
      startLine = lineNumber;
      separatorLine = null;
      continue;
    }
    if (line.startsWith("=======") && startLine !== null && separatorLine === null) {
      separatorLine = lineNumber;
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      if (startLine !== null) {
        regions.push({
          id: `conflict-${regions.length + 1}`,
          startLine,
          separatorLine,
          endLine: lineNumber,
        });
      }
      startLine = null;
      separatorLine = null;
    }
  }
  return regions;
}

export function containsConflictMarkerLines(text: string): boolean {
  return text.split("\n").some(line =>
    line.startsWith("<<<<<<<")
    || line.startsWith("|||||||")
    || line.startsWith("=======")
    || line.startsWith(">>>>>>>"),
  );
}

export function resolveDraftConflict(
  text: string,
  conflictId: string | null,
  mode: ConflictResolutionMode,
): { text: string; resolved: boolean } {
  const regions = draftConflictRegions(text).filter(region => region.separatorLine !== null);
  const region = regions.find(candidate => candidate.id === conflictId) ?? regions[0];
  if (!region || region.separatorLine === null) return { text, resolved: false };

  const lines = text.split("\n");
  const start = region.startLine - 1;
  const separator = region.separatorLine - 1;
  const end = region.endLine - 1;
  const current = lines.slice(start + 1, separator);
  const incoming = lines.slice(separator + 1, end);
  const replacement = mode === "current"
    ? current
    : mode === "incoming"
      ? incoming
      : mode === "currentThenIncoming"
        ? [...current, ...incoming]
        : [...incoming, ...current];
  lines.splice(start, end - start + 1, ...replacement);
  return { text: lines.join("\n"), resolved: true };
}

export function conflictSelectionRange(text: string, conflictId: string | null): { start: number; end: number } | null {
  const region = draftConflictRegions(text).find(candidate => candidate.id === conflictId)
    ?? draftConflictRegions(text)[0]
    ?? null;
  if (!region) return null;
  const lines = text.split("\n");
  let start = 0;
  for (let index = 0; index < region.startLine - 1; index += 1) start += lines[index]?.length ?? 0, start += 1;
  let end = start;
  for (let index = region.startLine - 1; index < region.endLine; index += 1) end += lines[index]?.length ?? 0, end += 1;
  return { start, end: Math.max(start, end - 1) };
}

export type ConflictPreview = {
  id: string;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  current: string;
  incoming: string;
};

export function adjacentConflictId(text: string, conflictId: string | null, offset: -1 | 1): string | null {
  const conflicts = draftConflictRegions(text).filter(region => region.separatorLine !== null);
  if (conflicts.length === 0) return null;
  const currentIndex = Math.max(0, conflicts.findIndex(candidate => candidate.id === conflictId));
  const nextIndex = Math.min(conflicts.length - 1, Math.max(0, currentIndex + offset));
  return conflicts[nextIndex]?.id ?? conflicts[0]?.id ?? null;
}

export function selectedConflictPreview(text: string, conflictId: string | null): ConflictPreview | null {
  const conflicts = draftConflictRegions(text).filter(region => region.separatorLine !== null);
  const index = conflicts.findIndex(candidate => candidate.id === conflictId);
  const region = conflicts[index >= 0 ? index : 0];
  if (!region || region.separatorLine === null) return null;
  const lines = text.split("\n");
  return {
    id: region.id,
    index: index >= 0 ? index + 1 : 1,
    total: conflicts.length,
    startLine: region.startLine,
    endLine: region.endLine,
    current: lines.slice(region.startLine, region.separatorLine - 1).join("\n"),
    incoming: lines.slice(region.separatorLine, region.endLine - 1).join("\n"),
  };
}

function renderSidebarHeader(
  owner: Document,
  state: ConflictResolverState,
  actions: ConflictResolverActions,
): HTMLElement {
  const header = owner.createElement("div");
  header.className = "conflict-sidebar-header";

  const title = owner.createElement("div");
  title.className = "conflict-sidebar-title";
  title.textContent = "Conflict Resolver";

  const meta = owner.createElement("div");
  meta.className = "conflict-sidebar-meta";
  const repo = selectedRepo(state);
  if (state.loadingScan) {
    meta.textContent = state.root ? `Scanning ${state.root}…` : "Scanning repository…";
  } else if (repo) {
    const operation = repo.operation ? `${formatOperation(repo.operation)} · ` : "";
    meta.textContent = `${operation}${repo.files.length} conflicted file${repo.files.length === 1 ? "" : "s"}`;
    meta.title = repo.root;
  } else if (state.root) {
    meta.textContent = state.root;
    meta.title = state.root;
  } else {
    meta.textContent = "Create or select a Conflict Resolver session to start.";
  }

  const actionsRow = owner.createElement("div");
  actionsRow.className = "conflict-sidebar-actions";

  const refresh = owner.createElement("button");
  refresh.type = "button";
  refresh.textContent = state.loadingScan ? "Scanning…" : "Refresh";
  refresh.disabled = state.loadingScan || !state.root;
  refresh.addEventListener("click", actions.refresh);

  const leave = owner.createElement("button");
  leave.type = "button";
  leave.textContent = "Back";
  leave.addEventListener("click", actions.leave);

  actionsRow.append(refresh, leave);
  header.append(title, meta, actionsRow);
  return header;
}

function renderFileList(
  owner: Document,
  list: HTMLElement,
  state: ConflictResolverState,
  actions: ConflictResolverActions,
): void {
  if (state.error) {
    const error = owner.createElement("div");
    error.className = "conflict-error";
    error.textContent = state.error;
    list.append(error);
  }

  if (state.loadingScan && state.repos.length === 0) {
    list.append(emptyState(owner, "Looking for Git conflicts…"));
    return;
  }

  if (state.repos.length === 0) {
    list.append(emptyState(owner, state.root ? "No unresolved conflicts were found for this repository." : "Create or select a Conflict Resolver session to load conflicts."));
    return;
  }

  for (const repo of state.repos) {
    const repoBlock = owner.createElement("section");
    repoBlock.className = "conflict-repo-block";

    const repoTitle = owner.createElement("div");
    repoTitle.className = "conflict-repo-title";
    repoTitle.textContent = repo.root;
    repoBlock.append(repoTitle);

    if (repo.files.length === 0) {
      repoBlock.append(emptyState(owner, "No unresolved conflicts."));
    } else {
      for (const file of repo.files) {
        repoBlock.append(renderFileButton(owner, repo.repoId, file, state, actions));
      }
    }
    list.append(repoBlock);
  }
}

function renderFileButton(
  owner: Document,
  repoId: string,
  file: ConflictFileSummary,
  state: ConflictResolverState,
  actions: ConflictResolverActions,
): HTMLElement {
  const button = owner.createElement("button");
  button.type = "button";
  button.className = "conflict-file-button";
  if (state.selectedRepoId === repoId && state.selectedPath === file.path) {
    button.classList.add("conflict-file-button-active");
  }
  if (!file.supported) button.classList.add("conflict-file-button-unsupported");
  button.disabled = state.loadingFile && state.selectedRepoId === repoId && state.selectedPath === file.path;
  button.addEventListener("click", () => actions.selectFile(repoId, file.path));

  const path = owner.createElement("span");
  path.className = "conflict-file-path";
  path.textContent = file.path;
  const kind = owner.createElement("span");
  kind.className = "conflict-file-kind";
  kind.textContent = `${formatConflictKind(file.kind)}${file.supported ? "" : " · read-only"}`;
  button.append(path, kind);
  return button;
}

function renderMain(owner: Document, main: HTMLElement, state: ConflictResolverState, actions: ConflictResolverActions): void {
  if (state.loadingFile && !state.file) {
    main.append(emptyState(owner, "Loading conflicted file…"));
    return;
  }

  if (!state.file) {
    main.append(emptyState(owner, "Select a conflicted file to inspect base, current branch, incoming change, and conflict result."));
    return;
  }

  const draftConflicts = draftConflictRegions(state.draftResult);
  const selectedConflict = draftConflicts.find(conflict => conflict.id === state.selectedConflictId) ?? draftConflicts[0] ?? null;
  const selectedPreview = selectedConflictPreview(state.draftResult, selectedConflict?.id ?? null);
  const hasMarkers = containsConflictMarkerLines(state.draftResult);
  const manualResolutionSupported = isSupportedConflictKind(state.file.kind);

  const header = owner.createElement("header");
  header.className = "conflict-main-header";
  const titleWrap = owner.createElement("div");
  const title = owner.createElement("div");
  title.className = "conflict-main-title";
  title.textContent = state.file.path;
  const meta = owner.createElement("div");
  meta.className = "conflict-main-meta";
  meta.textContent = `${formatConflictKind(state.file.kind)} · ${draftConflicts.length} conflict block${draftConflicts.length === 1 ? "" : "s"} · version ${state.file.version}`;
  titleWrap.append(title, meta);
  header.append(titleWrap, renderConflictActions(owner, state, draftConflicts, selectedConflict, selectedPreview, hasMarkers, manualResolutionSupported, actions));

  const grid = owner.createElement("div");
  grid.className = "conflict-buffer-grid";
  grid.append(
    renderBuffer(owner, "Current branch", state.file.ours),
    renderBuffer(owner, "Common ancestor", state.file.base),
    renderBuffer(owner, "Incoming change", state.file.theirs),
    renderResultEditor(owner, state, actions, manualResolutionSupported, hasMarkers, selectedPreview),
  );

  main.append(header, grid);
}

function renderConflictActions(
  owner: Document,
  state: ConflictResolverState,
  conflicts: DraftConflictRegion[],
  selectedConflict: DraftConflictRegion | null,
  selectedPreview: ConflictPreview | null,
  hasMarkers: boolean,
  manualResolutionSupported: boolean,
  actions: ConflictResolverActions,
): HTMLElement {
  const toolbar = owner.createElement("div");
  toolbar.className = "conflict-action-bar";

  const selector = owner.createElement("select");
  selector.className = "conflict-select";
  selector.disabled = !manualResolutionSupported || conflicts.length === 0 || state.saving || state.staging || state.previewingMagicWand;
  if (conflicts.length === 0) {
    const option = owner.createElement("option");
    option.textContent = hasMarkers ? "Incomplete conflict markers" : "No conflict markers";
    selector.append(option);
  } else {
    for (const conflict of conflicts) {
      const option = owner.createElement("option");
      option.value = conflict.id;
      option.textContent = `${conflict.id} · lines ${conflict.startLine}-${conflict.endLine}`;
      option.selected = conflict.id === selectedConflict?.id;
      selector.append(option);
    }
  }
  selector.addEventListener("change", () => actions.selectConflict(selector.value));

  const draftDirty = state.draftDirty;
  const manualButtonsDisabled = !manualResolutionSupported || conflicts.length === 0 || state.saving || state.staging || state.previewingMagicWand;
  const previewDisabled = !manualResolutionSupported || draftDirty || state.saving || state.staging || state.previewingMagicWand;
  const applyPreviewDisabled = !state.wandPreview || state.saving || state.staging || state.previewingMagicWand;
  const discardPreviewDisabled = !state.wandPreview || state.previewingMagicWand;
  const saveDisabled = !manualResolutionSupported || !draftDirty || state.saving || state.staging || state.previewingMagicWand;
  const stageDisabled = !manualResolutionSupported || draftDirty || hasMarkers || state.saving || state.staging || state.previewingMagicWand;

  const summary = owner.createElement("div");
  summary.className = "conflict-summary";
  summary.textContent = selectedPreview
    ? `Conflict ${selectedPreview.index} of ${selectedPreview.total} · lines ${selectedPreview.startLine}-${selectedPreview.endLine}`
    : hasMarkers ? "Conflict markers remain, but this block is incomplete." : "No conflict markers remain.";

  toolbar.append(
    selector,
    actionButton(owner, "Prev", manualButtonsDisabled, () => actions.shiftConflict(-1)),
    actionButton(owner, "Next", manualButtonsDisabled, () => actions.shiftConflict(1)),
    actionButton(owner, "Use current", manualButtonsDisabled, () => actions.resolveConflict("current")),
    actionButton(owner, "Use incoming", manualButtonsDisabled, () => actions.resolveConflict("incoming")),
    actionButton(owner, "Current + incoming", manualButtonsDisabled, () => actions.resolveConflict("currentThenIncoming")),
    actionButton(owner, "Incoming + current", manualButtonsDisabled, () => actions.resolveConflict("incomingThenCurrent")),
    actionButton(owner, state.previewingMagicWand ? "Previewing…" : "Preview magic wand", previewDisabled, actions.previewMagicWand),
    actionButton(owner, "Apply preview", applyPreviewDisabled, actions.applyMagicWandPreview),
    actionButton(owner, "Discard preview", discardPreviewDisabled, actions.discardMagicWandPreview),
    actionButton(owner, state.saving ? "Saving…" : "Save result", saveDisabled, actions.saveResult, "conflict-primary-action"),
    actionButton(owner, state.staging ? "Staging…" : "Mark resolved", stageDisabled, actions.stageResolved, "conflict-primary-action"),
  );
  const wrapper = owner.createElement("div");
  wrapper.className = "conflict-action-stack";
  wrapper.append(summary, toolbar);
  return wrapper;
}

function actionButton(owner: Document, label: string, disabled: boolean, onClick: () => void, className?: string): HTMLButtonElement {
  const button = owner.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  if (className) button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

function renderBuffer(
  owner: Document,
  fallbackTitle: string,
  buffer: ConflictFileBuffer | null | undefined,
): HTMLElement {
  const section = owner.createElement("section");
  section.className = "conflict-buffer";

  const header = owner.createElement("div");
  header.className = "conflict-buffer-header";
  const title = owner.createElement("span");
  title.textContent = buffer?.label ?? fallbackTitle;
  const meta = owner.createElement("span");
  meta.className = "conflict-buffer-meta";
  meta.textContent = buffer ? `${buffer.language} · ${formatBytes(buffer.size)}` : "unavailable";
  header.append(title, meta);

  const body = owner.createElement("pre");
  body.className = "conflict-buffer-body";
  const code = owner.createElement("code");
  code.textContent = buffer?.text ?? "This side is unavailable for this conflict type.";
  body.append(code);

  section.append(header, body);
  return section;
}

function renderResultEditor(
  owner: Document,
  state: ConflictResolverState,
  actions: ConflictResolverActions,
  manualResolutionSupported: boolean,
  hasMarkers: boolean,
  selectedPreview: ConflictPreview | null,
): HTMLElement {
  const section = owner.createElement("section");
  section.className = "conflict-buffer conflict-buffer-result";

  const header = owner.createElement("div");
  header.className = "conflict-buffer-header";
  const title = owner.createElement("span");
  title.textContent = state.file?.result?.label ?? "Conflict result";
  const meta = owner.createElement("span");
  meta.className = "conflict-buffer-meta";
  meta.textContent = state.draftDirty ? "edited, not saved" : "saved";
  header.append(title, meta);

  const textarea = owner.createElement("textarea");
  textarea.className = "conflict-result-editor";
  textarea.spellcheck = false;
  textarea.value = state.draftResult;
  textarea.disabled = !manualResolutionSupported || state.saving || state.staging || state.previewingMagicWand;
  textarea.addEventListener("input", () => actions.updateResult(textarea.value, {
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    scrollTop: textarea.scrollTop,
    focused: owner.activeElement === textarea,
  }));

  const status = owner.createElement("div");
  status.className = "conflict-result-status";
  status.textContent = manualResolutionSupported
    ? state.status ?? "Edit the conflict result, save it, then mark resolved when no conflict markers remain."
    : "This conflict type is currently read-only in Fura. Inspect here, resolve outside, then rescan.";

  const preview = renderConflictPreview(owner, selectedPreview, manualResolutionSupported);
  const wandPreview = renderMagicWandPreview(owner, state, manualResolutionSupported);
  const agentPanel = renderAgentPanel(owner, state, manualResolutionSupported, hasMarkers, selectedPreview, actions);
  section.append(header, wandPreview, agentPanel, preview, textarea, status);
  return section;
}

function renderMagicWandPreview(
  owner: Document,
  state: ConflictResolverState,
  manualResolutionSupported: boolean,
): HTMLElement {
  const panel = owner.createElement("div");
  panel.className = "conflict-magic-wand-preview";
  if (!manualResolutionSupported) {
    panel.textContent = "Magic wand preview is unavailable for this conflict type.";
    return panel;
  }
  if (state.previewingMagicWand) {
    panel.textContent = "Building deterministic magic wand preview…";
    return panel;
  }
  if (!state.wandPreview) {
    panel.textContent = state.draftDirty
      ? "Save or discard draft edits before previewing the magic wand."
      : "Preview the magic wand to try safe deterministic conflict-resolution rules on the saved file.";
    return panel;
  }
  const heading = owner.createElement("div");
  heading.className = "conflict-magic-wand-heading";
  heading.textContent = "Magic wand preview";
  const meta = owner.createElement("div");
  meta.className = "conflict-magic-wand-meta";
  meta.textContent = state.wandPreview.summary;
  const list = owner.createElement("ul");
  list.className = "conflict-magic-wand-rules";
  for (const rule of state.wandPreview.rules) {
    const item = owner.createElement("li");
    item.textContent = `${rule.conflictId}: ${formatMagicWandRule(rule.rule)} — ${rule.summary}`;
    list.append(item);
  }
  const body = owner.createElement("pre");
  body.className = "conflict-magic-wand-body";
  body.textContent = state.wandPreview.content;
  panel.append(heading, meta, list, body);
  return panel;
}

function renderAgentPanel(
  owner: Document,
  state: ConflictResolverState,
  manualResolutionSupported: boolean,
  hasMarkers: boolean,
  selectedPreview: ConflictPreview | null,
  actions: ConflictResolverActions,
): HTMLElement {
  const panel = owner.createElement("div");
  panel.className = "conflict-agent-panel";
  if (!manualResolutionSupported) {
    panel.textContent = "Agent assistance is unavailable for this conflict type.";
    return panel;
  }
  const heading = owner.createElement("div");
  heading.className = "conflict-agent-heading";
  heading.textContent = "Agent assistance";
  const meta = owner.createElement("div");
  meta.className = "conflict-agent-meta";
  meta.textContent = "Agent assistance runs in this Conflict Resolver session and returns preview-first explanations or proposals.";
  const textarea = owner.createElement("textarea");
  textarea.className = "conflict-agent-instructions";
  textarea.spellcheck = false;
  textarea.placeholder = "Optional extra instructions for the agent";
  textarea.value = state.agentInstructions;
  textarea.disabled = state.saving || state.staging || state.requestingAgentAssistance;
  textarea.addEventListener("input", () => actions.updateAgentInstructions(textarea.value));
  const actionsRow = owner.createElement("div");
  actionsRow.className = "conflict-agent-actions";
  const explainDisabled = !hasMarkers || !selectedPreview || state.draftDirty || state.saving || state.staging || state.requestingAgentAssistance;
  const proposeConflictDisabled = explainDisabled;
  const proposeFileDisabled = !hasMarkers || state.draftDirty || state.saving || state.staging || state.requestingAgentAssistance;
  const applyDisabled = !state.agentResult?.content || state.saving || state.staging || state.requestingAgentAssistance;
  const discardDisabled = !state.agentResult || state.requestingAgentAssistance;
  actionsRow.append(
    actionButton(owner, state.requestingAgentAssistance ? "Requesting…" : "Explain conflict", explainDisabled, actions.requestAgentExplain),
    actionButton(owner, "Propose conflict", proposeConflictDisabled, actions.requestAgentProposeConflict),
    actionButton(owner, "Propose file", proposeFileDisabled, actions.requestAgentProposeFile),
    actionButton(owner, "Apply agent result", applyDisabled, actions.applyAgentResult),
    actionButton(owner, "Discard agent result", discardDisabled, actions.discardAgentResult),
  );
  panel.append(heading, meta, textarea, actionsRow);
  if (state.requestingAgentAssistance) {
    const status = owner.createElement("div");
    status.className = "conflict-agent-result";
    status.textContent = "Waiting for conflict-resolution agent assistance…";
    panel.append(status);
    return panel;
  }
  if (!state.agentResult) {
    const empty = owner.createElement("div");
    empty.className = "conflict-agent-result";
    empty.textContent = state.draftDirty
      ? "Save or discard draft edits before asking the agent."
      : selectedPreview
        ? "Ask the agent to explain the selected conflict or propose a selected-conflict/file preview."
        : "Select a complete conflict block to ask the agent about it.";
    panel.append(empty);
    return panel;
  }
  const result = owner.createElement("div");
  result.className = "conflict-agent-result";
  const resultMeta = owner.createElement("div");
  resultMeta.className = "conflict-agent-result-meta";
  resultMeta.textContent = `${state.agentResult.mode === "explain" ? "Explanation" : "Proposal"} · ${state.agentResult.scope === "selectedConflict" ? "selected conflict" : "file"} · ${formatConflictAgentRisk(state.agentResult.risk)} risk`;
  const summary = owner.createElement("div");
  summary.className = "conflict-agent-result-summary";
  summary.textContent = state.agentResult.summary;
  const explanation = owner.createElement("pre");
  explanation.className = "conflict-agent-result-body";
  explanation.textContent = state.agentResult.explanation;
  result.append(resultMeta, summary, explanation);
  if (state.agentResult.content != null) {
    const content = owner.createElement("pre");
    content.className = "conflict-agent-result-body";
    content.textContent = state.agentResult.content;
    result.append(content);
  }
  panel.append(result);
  return panel;
}

function renderConflictPreview(
  owner: Document,
  preview: ConflictPreview | null,
  manualResolutionSupported: boolean,
): HTMLElement {
  const panel = owner.createElement("div");
  panel.className = "conflict-preview";
  if (!manualResolutionSupported) {
    panel.textContent = "Manual conflict actions are disabled for this conflict type.";
    return panel;
  }
  if (!preview) {
    panel.textContent = "Select a complete conflict block to compare current and incoming text.";
    return panel;
  }
  const heading = owner.createElement("div");
  heading.className = "conflict-preview-heading";
  heading.textContent = `Focused conflict ${preview.index}/${preview.total}`;
  const columns = owner.createElement("div");
  columns.className = "conflict-preview-columns";
  columns.append(
    renderConflictPreviewColumn(owner, "Current branch chunk", preview.current),
    renderConflictPreviewColumn(owner, "Incoming change chunk", preview.incoming),
  );
  panel.append(heading, columns);
  return panel;
}

function renderConflictPreviewColumn(owner: Document, titleText: string, text: string): HTMLElement {
  const column = owner.createElement("section");
  column.className = "conflict-preview-column";
  const title = owner.createElement("div");
  title.className = "conflict-preview-title";
  title.textContent = titleText;
  const body = owner.createElement("pre");
  body.className = "conflict-preview-body";
  body.textContent = text || "(empty)";
  column.append(title, body);
  return column;
}

function formatConflictAgentRisk(risk: ConflictAgentResult["risk"]): string {
  switch (risk) {
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    default: return risk;
  }
}

function formatMagicWandRule(rule: string): string {
  switch (rule) {
    case "identicalSides": return "Identical sides";
    case "importListUnion": return "Import list union";
    case "linewiseIndependentEdits": return "Linewise independent edits";
    case "sameLineNonOverlappingEdits": return "Same-line non-overlap";
    default: return rule;
  }
}

function isSupportedConflictKind(kind: ConflictFileKind): boolean {
  return kind === "bothModified" || kind === "addAdd";
}

function selectedRepo(state: ConflictResolverState): ConflictRepositorySummary | null {
  return state.repos.find(repo => repo.repoId === state.selectedRepoId) ?? state.repos[0] ?? null;
}

function emptyState(owner: Document, text: string): HTMLElement {
  const empty = owner.createElement("div");
  empty.className = "conflict-empty";
  empty.textContent = text;
  return empty;
}

function formatOperation(operation: string): string {
  switch (operation) {
    case "merge": return "Merge";
    case "rebase": return "Rebase";
    case "cherryPick": return "Cherry-pick";
    case "revert": return "Revert";
    default: return operation;
  }
}

function formatConflictKind(kind: string): string {
  switch (kind) {
    case "bothModified": return "Both modified";
    case "addAdd": return "Added by both";
    case "deleteModify": return "Deleted/modified";
    case "renameModify": return "Renamed/modified";
    case "renameDelete": return "Renamed/deleted";
    case "bothDeleted": return "Deleted by both";
    default: return "Unknown";
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
