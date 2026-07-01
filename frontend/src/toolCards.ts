import { appendEventTimestamp, renderEventTimestamp } from "./eventTime";
import { filePathWithIcon } from "./fileTypeIcons";
import { formatTokens, shortPath } from "./format";
import { renderImageAttachment, type RenderableImage } from "./imageRendering";
import { mkEl } from "./dom";
import type {
  AgentProgress,
  TaskResult,
  TodoItem,
  TodoPhase,
  TodoStatus,
  ToolCard,
  TranscriptEntry,
} from "./protocol";

export function renderToolCard(card: ToolCard): HTMLElement {
  if (card.toolName === "todo" || card.toolName === "todo_write") return renderTodoWriteCard(card);
  if (card.toolName === "task") return renderTaskCard(card);
  if (card.toolName === "read") return renderReadToolCard(card);
  if (card.toolName === "grep") return renderGrepToolCard(card);
  const wrapper = mkEl("section");
  wrapper.className = `tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = card.toolName;

  const header = mkEl("div");
  header.className = "tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText(card.toolName, "tool-name"),
    toolHeaderText(toolArgSummary(card.args), "tool-args-summary"),
  );
  appendEventTimestamp(header, card.timestamp);
  wrapper.append(header);

  appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
  appendToolImageGrid(wrapper, toolResultImages(card.partialResult ?? card.result));

  return wrapper;
}

export function renderReadToolCard(card: ToolCard): HTMLElement {
  const result = card.partialResult ?? card.result;
  const images = readToolCardImages(card);
  const isCompact = !card.isError && images.length === 0;
  const wrapper = mkEl("section");
  wrapper.className = `tool-card read-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${isCompact ? "tool-compact" : ""}`;
  wrapper.dataset.toolName = "read";

  const header = mkEl("div");
  header.className = "tool-header read-tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Read", "tool-name"),
    toolHeaderText(readArgSummary(card), "tool-args-summary"),
  );
  appendEventTimestamp(header, card.timestamp);
  wrapper.append(header);

  if (card.isError) {
    appendToolResultBody(wrapper, toolResultText(result));
  }
  appendToolImageGrid(wrapper, images);

  return wrapper;
}

export function renderReadToolGroup(cards: Array<{ kind: "tool" } & ToolCard>): HTMLElement {
  const wrapper = mkEl("section");
  const isActive = cards.some(card => card.isActive);
  wrapper.className = `tool-card read-tool-card read-tool-group ${isActive ? "tool-active" : ""} tool-compact`;
  wrapper.dataset.toolName = "read";

  const header = mkEl("div");
  header.className = "tool-header read-tool-header";
  header.append(
    toolStatusIcon({ ...cards[0], isActive }),
    toolHeaderText("Read", "tool-name"),
    toolHeaderText(`(${cards.length})`, "tool-count"),
  );
  appendEventTimestamp(header, cards[0]?.timestamp);
  wrapper.append(header);

  const list = mkEl("div");
  list.className = "read-tool-list";
  cards.forEach((card, index) => {
    const row = mkEl("div");
    row.className = "read-tool-row";
    const timestamp = renderEventTimestamp(card.timestamp);
    row.append(
      toolHeaderText(index === cards.length - 1 ? "└─" : "├─", "read-tool-connector"),
      toolStatusIcon(card),
      toolHeaderText(readArgSummary(card), "read-tool-path"),
      ...(timestamp ? [timestamp] : []),
    );
    list.append(row);
  });
  wrapper.append(list);

  return wrapper;
}

export function isCompactReadCard(entry: TranscriptEntry | undefined): entry is { kind: "tool" } & ToolCard {
  return entry?.kind === "tool" && entry.toolName === "read" && !entry.isError && readToolCardImages(entry).length === 0;
}

function readToolCardImages(card: ToolCard): RenderableImage[] {
  return toolResultImages(card.partialResult ?? card.result);
}

function readArgSummary(card: ToolCard): string {
  const correctedPath = readSuffixResolution(card)?.to;
  const path = correctedPath ?? stringArg(card.args, "file_path") ?? stringArg(card.args, "path");
  const selection = stringArg(card.args, "sel");
  const suffix = selection ? `:${selection}` : "";
  const summary = path ? `${filePathWithIcon(path, shortPath)}${suffix}` : suffix || "…";
  const correctedFrom = readSuffixResolution(card)?.from;
  return correctedFrom ? `${summary} (corrected from ${shortPath(correctedFrom)})` : summary;
}

function readSuffixResolution(card: ToolCard): { from?: string; to?: string } | undefined {
  const source = isRecord(card.result) ? card.result : card.partialResult;
  if (!isRecord(source) || !isRecord(source.details) || !isRecord(source.details.suffixResolution)) return undefined;
  const { from, to } = source.details.suffixResolution;
  return {
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pathScopeArg(args: Record<string, unknown>): string | undefined {
  const legacyPath = stringArg(args, "path");
  if (legacyPath) return legacyPath;
  const paths = args.paths;
  if (typeof paths === "string" && paths.trim()) return paths;
  if (Array.isArray(paths)) return paths.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return undefined;
}

function renderGrepToolCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card grep-tool-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""} ${card.isError ? "" : "tool-compact"}`;
  wrapper.dataset.toolName = "grep";

  const header = mkEl("div");
  header.className = "tool-header grep-tool-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Grep:", "tool-name"),
    toolHeaderText(grepPatternSummary(card), "grep-pattern"),
    toolHeaderText(grepMetaSummary(card), "tool-args-summary"),
  );
  appendEventTimestamp(header, card.timestamp);
  wrapper.append(header);

  if (card.isError) {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
    return wrapper;
  }

  const collapsed = grepCollapsedSummary(card);
  if (collapsed) {
    const row = mkEl("div");
    row.className = "grep-tool-row";
    row.append(
      toolHeaderText("└─", "grep-tool-connector"),
      toolHeaderText(collapsed, "grep-tool-summary"),
    );
    wrapper.append(row);
  }

  return wrapper;
}

function grepPatternSummary(card: ToolCard): string {
  return truncate(stringArg(card.args, "pattern") ?? "…", 110);
}

function grepMetaSummary(card: ToolCard): string {
  const source = card.partialResult ?? card.result;
  const details = resultDetails(source);
  const parts: string[] = [];

  const matchCount = numberDetail(details, "matchCount");
  const fileCount = numberDetail(details, "fileCount");
  if (matchCount !== undefined) parts.push(formatCount("match", matchCount));
  if (fileCount !== undefined) parts.push(formatCount("file", fileCount));

  const scope = stringDetail(details, "scopePath") ?? pathScopeArg(card.args);
  if (scope) parts.push(`in ${shortPath(scope)}`);
  if (booleanDetail(details, "truncated")) parts.push("truncated");
  if (card.args.case === false || stringArg(card.args, "i") === "true" || card.args.i === true) parts.push("case:insensitive");

  return parts.join(" · ");
}

function grepCollapsedSummary(card: ToolCard): string {
  const source = card.partialResult ?? card.result;
  const details = resultDetails(source);
  const resultText = toolResultText(source);
  const matchCount = numberDetail(details, "matchCount");

  if (matchCount === 0 || resultText.trim() === "No matches found") return "No matches found";
  if (matchCount !== undefined) return `${formatCount("match", matchCount)} collapsed`;

  const lineCount = resultText.split("\n").filter(line => line.trim()).length;
  if (lineCount > 0) return `${formatCount("line", lineCount)} collapsed`;
  return "";
}

function resultDetails(source: unknown): Record<string, unknown> | undefined {
  return isRecord(source) && isRecord(source.details) ? source.details : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanDetail(details: Record<string, unknown> | undefined, key: string): boolean {
  return details?.[key] === true;
}

function formatCount(noun: string, count: number): string {
  const plural = noun === "match" ? "matches" : `${noun}s`;
  return `${count} ${count === 1 ? noun : plural}`;
}

function appendToolResultBody(wrapper: HTMLElement, resultText: string): void {
  if (!resultText) return;
  const body = mkEl("div");
  body.className = "tool-result-body";
  const pre = mkEl("pre");
  pre.className = "tool-result-text";
  pre.textContent = truncate(resultText, 8000);
  body.append(pre);
  wrapper.append(body);
}

export function renderCurrentTodoCard(phases: TodoPhase[]): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = "tool-card todo-write-card todo-current-card";
  wrapper.dataset.toolName = "todo_write";

  const header = mkEl("div");
  header.className = "tool-header todo-write-header";
  header.append(toolHeaderText("Todos", "tool-name"));
  const tasks = phases.flatMap(phase => phase.tasks);
  const remaining = tasks.filter(todo => todo.status === "pending" || todo.status === "in_progress").length;
  header.append(toolHeaderText(`${remaining} remaining · ${tasks.length} total`, "tool-args-summary"));
  wrapper.append(header);

  const tree = mkEl("div");
  tree.className = "todo-tree";
  for (const phase of phases) tree.append(renderTodoPhase(phase, phases.length > 1));
  wrapper.append(tree);
  return wrapper;
}

function renderTodoWriteCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card todo-write-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "todo_write";

  const header = mkEl("div");
  header.className = "tool-header todo-write-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Todo Write", "tool-name"),
  );
  const phases = todoPhases(card.partialResult ?? card.result);
  const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  header.append(toolHeaderText(`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`, "tool-args-summary"));
  appendEventTimestamp(header, card.timestamp);
  wrapper.append(header);

  if (phases.length > 0) {
    const tree = mkEl("div");
    tree.className = "todo-tree";
    for (const phase of phases) tree.append(renderTodoPhase(phase, phases.length > 1));
    wrapper.append(tree);
  } else {
    appendToolResultBody(wrapper, toolResultText(card.partialResult ?? card.result));
  }

  return wrapper;
}

function renderTodoPhase(phase: TodoPhase, showPhaseName: boolean): HTMLElement {
  const section = mkEl("section");
  section.className = "todo-phase";

  if (showPhaseName) {
    const title = mkEl("div");
    title.className = "todo-phase-title";
    title.textContent = `└─ ${phase.name}`;
    section.append(title);
  }

  const list = mkEl("div");
  list.className = "todo-task-list";
  phase.tasks.forEach((todo, index) => {
    list.append(renderTodoItem(todo, index === 0));
  });
  section.append(list);
  return section;
}

function renderTodoItem(todo: TodoItem, firstInPhase: boolean): HTMLElement {
  const row = mkEl("div");
  row.className = `todo-task todo-${todo.status}`;

  const prefix = mkEl("span");
  prefix.className = "todo-prefix";
  prefix.textContent = firstInPhase ? "└─" : "  ";

  const icon = mkEl("span");
  icon.className = "todo-icon";
  icon.textContent = todoStatusGlyph(todo.status);

  const content = mkEl("span");
  content.className = "todo-content";
  content.textContent = todo.content;

  row.append(prefix, icon, content);

  if (todo.notes && todo.notes.length > 0) {
    const marker = mkEl("span");
    marker.className = "todo-note-marker";
    marker.textContent = `+${todo.notes.length}`;
    row.append(marker);
  }

  if (todo.status === "in_progress" && todo.notes) {
    for (const note of todo.notes) {
      for (const line of note.split("\n")) {
        const details = mkEl("div");
        details.className = "todo-details";
        details.textContent = line;
        row.append(details);
      }
    }
  }

  return row;
}

function todoStatusGlyph(status: TodoStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "→";
    case "abandoned": return "✗";
    default: return "○";
  }
}

function todoPhases(value: unknown): TodoPhase[] {
  if (!isRecord(value) || !isRecord(value.details) || !Array.isArray(value.details.phases)) return [];
  return value.details.phases.filter(isTodoPhase);
}

function isTodoPhase(value: unknown): value is TodoPhase {
  return isRecord(value)
    && typeof value.name === "string"
    && Array.isArray(value.tasks)
    && value.tasks.every(isTodoItem);
}

function isTodoItem(value: unknown): value is TodoItem {
  return isRecord(value)
    && typeof value.content === "string"
    && isTodoStatus(value.status)
    && (value.notes === undefined || (Array.isArray(value.notes) && value.notes.every(note => typeof note === "string")));
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function renderTaskCard(card: ToolCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `tool-card task-card ${card.isActive ? "tool-active" : ""} ${card.isError ? "tool-error" : ""}`;
  wrapper.dataset.toolName = "task";

  const header = mkEl("div");
  header.className = "tool-header task-header";
  header.append(
    toolStatusIcon(card),
    toolHeaderText("Task:", "task-label"),
    toolHeaderText(String(card.args?.agent ?? card.toolName), "task-agent-name"),
  );
  if (card.intent) header.append(toolHeaderText(card.intent, "task-intent"));
  appendEventTimestamp(header, card.timestamp);
  wrapper.append(header);

  const source = card.partialResult ?? card.result;
  const progress = taskProgress(source);
  const results = taskResults(source);
  const shouldRenderProgress = progress.length > 0 && (card.isActive || results.length === 0);

  if (shouldRenderProgress) {
    const list = mkEl("div");
    list.className = "task-progress";
    for (const agent of progress) list.append(renderTaskAgent(agent));
    wrapper.append(list);
  } else if (results.length > 0) {
    const list = mkEl("div");
    list.className = "task-progress task-results";
    for (let i = 0; i < results.length; i++) list.append(renderTaskResult(results[i], i === results.length - 1));
    wrapper.append(list);
  } else {
    appendToolResultBody(wrapper, toolResultText(source));
  }

  const totals = shouldRenderProgress ? taskProgressTotals(progress) : taskResultTotals(results, source);
  if (totals) {
    const total = mkEl("div");
    total.className = "task-total";
    total.textContent = totals;
    wrapper.append(total);
  }

  return wrapper;
}

function renderTaskAgent(agent: AgentProgress): HTMLElement {
  const row = mkEl("div");
  row.className = `task-agent status-${agent.status}`;

  const main = mkEl("div");
  main.className = "task-agent-main";
  const status = toolHeaderText(taskStatusGlyph(agent.status), "task-agent-status");
  if (agent.status === "running") status.classList.add("is-running");
  main.append(
    status,
    toolHeaderText(formatTaskId(agent.id), "task-agent-id"),
    toolHeaderText(agent.description ?? agent.task, "task-agent-desc"),
  );
  const stats = taskProgressStats(agent);
  if (stats) main.append(toolHeaderText(stats, "task-agent-stats"));
  row.append(main);

  if (agent.lastIntent || agent.currentTool) {
    const activity = mkEl("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${agent.lastIntent ?? `${agent.currentTool} ${agent.currentToolArgs ?? ""}`}`;
    row.append(activity);
  }

  return row;
}

function renderTaskResult(result: TaskResult, isLast: boolean): HTMLElement {
  const resultStatus = taskResultStatus(result);
  const row = mkEl("div");
  row.className = `task-agent task-result status-${resultStatus} ${isLast ? "task-last" : ""}`;

  const main = mkEl("div");
  main.className = "task-agent-main";
  main.append(
    toolHeaderText(taskResultGlyph(result), "task-agent-status"),
    toolHeaderText(formatTaskId(result.id), "task-agent-id"),
    toolHeaderText(result.description ?? result.task, "task-agent-desc"),
    toolHeaderText(taskResultLabel(result), "task-result-badge"),
  );
  const stats = taskResultStats(result);
  if (stats) main.append(toolHeaderText(stats, "task-agent-stats"));
  row.append(main);

  const activityText = result.lastIntent ?? result.abortReason ?? result.error;
  if (activityText) {
    const activity = mkEl("div");
    activity.className = "task-agent-activity";
    activity.textContent = `└─ ${activityText}`;
    row.append(activity);
  }

  const outputLines = taskOutputPreview(result.output);
  if (outputLines.length > 0) {
    const output = mkEl("pre");
    output.className = "task-result-output";
    output.textContent = outputLines.join("\n");
    row.append(output);
  }

  const artifactPath = result.patchPath ?? result.branchName ?? result.outputPath;
  if (artifactPath) {
    const path = mkEl("div");
    path.className = "task-result-path";
    path.textContent = `${result.patchPath ? "Patch" : result.branchName ? "Branch" : "Output"}: ${artifactPath}`;
    row.append(path);
  }

  return row;
}

function toolStatusIcon(card: ToolCard): HTMLElement {
  const span = mkEl("span");
  span.className = "tool-status-icon";
  if (card.isActive) {
    span.classList.add("is-running");
    span.textContent = "⠋";
  } else {
    span.textContent = card.isError ? "✗" : "✓";
  }
  return span;
}

function toolHeaderText(text: string, className: string): HTMLElement {
  const span = mkEl("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function taskProgress(value: unknown): AgentProgress[] {
  if (!isRecord(value)) return [];
  const details = value.details;
  if (!isRecord(details) || !Array.isArray(details.progress)) return [];
  return details.progress.filter(isAgentProgress);
}

function taskResults(value: unknown): TaskResult[] {
  if (!isRecord(value)) return [];
  const details = value.details;
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  return details.results.filter(isTaskResult);
}

function isAgentProgress(value: unknown): value is AgentProgress {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string" && typeof value.task === "string";
}

function isTaskResult(value: unknown): value is TaskResult {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.agent === "string"
    && typeof value.task === "string"
    && typeof value.exitCode === "number";
}

function taskStatusGlyph(status: AgentProgress["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "aborted") return "✗";
  if (status === "running") return "⠋";
  return "·";
}

function taskResultGlyph(result: TaskResult): string {
  if (result.aborted || result.exitCode !== 0) return "✗";
  if (result.error) return "!";
  return "✓";
}

function taskResultStatus(result: TaskResult): "completed" | "failed" | "aborted" | "warning" {
  if (result.aborted) return "aborted";
  if (result.exitCode !== 0) return "failed";
  if (result.error) return "warning";
  return "completed";
}

function taskResultLabel(result: TaskResult): string {
  if (result.aborted) return "aborted";
  if (result.exitCode !== 0) return "failed";
  if (result.error) return "merge failed";
  return "done";
}

function formatTaskId(id: string): string {
  const segments = id.split(".");
  if (segments.length < 2 && !/^\d+-/.test(id)) return id;
  return segments.map(segment => {
    const match = segment.match(/^(\d+)-(.+)$/);
    return match ? `${match[1]} ${match[2]}` : segment;
  }).join(">");
}

function taskProgressStats(agent: AgentProgress): string {
  const parts: string[] = [];
  if ((agent.toolCount ?? 0) > 0) parts.push(`${agent.toolCount} tools`);
  if ((agent.tokens ?? 0) > 0) parts.push(`${formatTokens(agent.tokens)} tokens`);
  if ((agent.durationMs ?? 0) > 0 && agent.status !== "running") parts.push(formatDuration(agent.durationMs));
  return parts.join(" · ");
}

function taskResultStats(result: TaskResult): string {
  const parts: string[] = [];
  if ((result.tokens ?? 0) > 0) parts.push(`${formatTokens(result.tokens ?? 0)} tokens`);
  if ((result.durationMs ?? 0) > 0) parts.push(formatDuration(result.durationMs ?? 0));
  if (result.truncated) parts.push("truncated");
  return parts.join(" · ");
}

function taskOutputPreview(output: string | undefined): string[] {
  if (!output?.trim()) return [];
  const lines = output
    .split("\n")
    .map(line => line.replace(/\t/g, "  ").trimEnd())
    .filter(line => line.trim().length > 0);
  const visible = lines.slice(0, 3);
  if (lines.length > visible.length) visible.push("…");
  return visible;
}

function taskProgressTotals(progress: AgentProgress[]): string {
  if (progress.length === 0) return "";
  const done = progress.filter(p => p.status === "completed").length;
  const failed = progress.filter(p => p.status === "failed" || p.status === "aborted").length;
  const duration = Math.max(...progress.map(p => p.durationMs || 0));
  if (done + failed === 0) return "";
  return `Total: ${done} succeeded${failed ? ` · ${failed} failed` : ""}${duration > 0 ? ` · ${formatDuration(duration)}` : ""}`;
}

function taskResultTotals(results: TaskResult[], source: unknown): string {
  if (results.length === 0) return "";
  const aborted = results.filter(r => r.aborted).length;
  const warnings = results.filter(r => !r.aborted && r.exitCode === 0 && Boolean(r.error)).length;
  const succeeded = results.filter(r => !r.aborted && r.exitCode === 0 && !r.error).length;
  const failed = results.length - aborted - warnings - succeeded;
  const parts: string[] = [];
  if (aborted > 0) parts.push(`${aborted} aborted`);
  if (succeeded > 0) parts.push(`${succeeded} succeeded`);
  if (warnings > 0) parts.push(`${warnings} merge failed`);
  if (failed > 0) parts.push(`${failed} failed`);
  const totalDuration = isRecord(source) && isRecord(source.details) && typeof source.details.totalDurationMs === "number"
    ? source.details.totalDurationMs
    : Math.max(...results.map(r => r.durationMs ?? 0));
  if (totalDuration > 0) parts.push(formatDuration(totalDuration));
  return parts.length > 0 ? `Total: ${parts.join(" · ")}` : "";
}

function toolArgSummary(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path) return filePathWithIcon(path, shortPath);
  for (const key of ["subject", "command", "message", "input", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim(), 70);
  }
  const first = Object.entries(args).find(([, value]) => typeof value === "string");
  return first ? `${first[0]}=${truncate(String(first[1]), 60)}` : "";
}

export function toolResultText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  const content = value.content;
  if (Array.isArray(content)) {
    const text = content.map(item => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
    if (text) return text;
  }
  return "";
}

export function toolResultImages(value: unknown): RenderableImage[] {
  if (!isRecord(value)) return [];
  const images: RenderableImage[] = [];
  collectContentImages(value.content, images);
  if (isRecord(value.details)) collectContentImages(value.details.images, images);
  return images;
}

function collectContentImages(value: unknown, images: RenderableImage[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.type === "string" && item.type !== "image") continue;
    const data = typeof item.data === "string" ? item.data : undefined;
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    if (!data || !mimeType) continue;
    const alt = typeof item.alt === "string" ? item.alt : undefined;
    images.push({ data, mimeType, alt });
  }
}

function appendToolImageGrid(wrapper: HTMLElement, images: RenderableImage[]): void {
  if (images.length === 0) return;
  const grid = mkEl("div");
  grid.className = "tool-image-grid";
  for (const image of images) {
    grid.append(renderImageAttachment(image, "tool-image-thumb"));
  }
  wrapper.append(grid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = 1_000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;
  if (ms < sec) return `${Math.round(ms)}ms`;
  if (ms < min) return `${(ms / sec).toFixed(1)}s`;
  if (ms < hour) {
    const minutes = Math.floor(ms / min);
    const seconds = Math.floor((ms % min) / sec);
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  if (ms < day) {
    const hours = Math.floor(ms / hour);
    const minutes = Math.floor((ms % hour) / min);
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(ms / day);
  const hours = Math.floor((ms % day) / hour);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}
