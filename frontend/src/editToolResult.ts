import type { ToolCard } from "./protocol";

export type EditFile = {
  path: string | null;
  sourcePath?: string;
  operation: string;
  status: "running" | "completed" | "failed" | "unknown" | "preview";
  diff: string;
  error?: string;
};

export function editResultSource(card: ToolCard): unknown {
  return card.isActive ? card.partialResult ?? card.result : card.result ?? card.partialResult;
}

export function hasEditDiff(card: ToolCard): boolean {
  const details = record(record(editResultSource(card))?.details);
  return Boolean(text(details?.diff)) || (Array.isArray(details?.perFileResults)
    && details.perFileResults.some(file => Boolean(text(record(file)?.diff))));
}

// Lexical identity only: never resolve symlinks, recover suffixes, or collapse a
// URI into a local filename. Authoritative result paths win over requested paths.
export function editPathIdentity(path: string | null, cwd?: string | null): string | null {
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("~")) return path;
  const absolute = path.startsWith("/") ? path : cwd?.startsWith("/") ? `${cwd}/${path}` : path;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute.startsWith("/")) parts.push(part);
  }
  return `${absolute.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

export function editFiles(card: ToolCard, cwd?: string | null): { files: EditFile[]; unassignedDiff: string } {
  const details = record(record(editResultSource(card))?.details);
  const requested = requestedFiles(card);
  const perFile = Array.isArray(details?.perFileResults) ? details.perFileResults.map(record).filter(isPresent) : [];
  const aggregate = text(details?.diff) ?? "";
  const defaultStatus = card.isActive ? "running" : card.isError ? "unknown" : details?.applied === false ? "preview" : "completed";
  const fromResult = (item: Record<string, unknown>): EditFile => {
    const path = text(item.path) ?? text(item.resolvedPath) ?? null;
    const sourcePath = text(item.sourcePath);
    const move = text(item.move);
    const error = text(item.displayErrorText) ?? text(item.errorText);
    return {
      path,
      sourcePath,
      operation: sourcePath || move ? "Rename" : operation(item.op, card.toolName),
      status: card.isActive ? "running" : item.isError === true || error ? "failed" : item.isError === false ? "completed" : defaultStatus,
      diff: text(item.diff) ?? "",
      error,
    };
  };
  let files: EditFile[];
  let unassignedDiff = "";
  if (perFile.length) {
    files = perFile.map(fromResult);
    if (aggregate && (perFile.some(file => typeof file.diff !== "string") || !files.some(file => file.diff)
      || perFile.length !== (details?.perFileResults as unknown[]).length)) unassignedDiff = aggregate;
  } else if (details && (text(details.path) || text(details.resolvedPath))) {
    files = [fromResult(details)];
  } else {
    files = requested.map(file => ({ ...file, status: defaultStatus, diff: "" }));
    // Native multi-file details.diff has no file boundaries. Never distribute
    // it by hunk/line number or attach it to the first requested file.
    const singleTarget = text(card.args.path) ?? text(card.args.file_path);
    if (aggregate && singleTarget && files.length === 1 && !/^diff --git .+\n[\s\S]*^diff --git /m.test(aggregate)) files[0].diff = aggregate;
    else unassignedDiff = aggregate;
  }
  if (card.isError && perFile.length) {
    const reported = new Set(files.map(file => editPathIdentity(file.sourcePath ?? file.path, cwd)));
    for (const file of requested) {
      if (!reported.has(editPathIdentity(file.sourcePath ?? file.path, cwd))) {
        files.push({ ...file, status: "unknown", diff: "" });
      }
    }
  }
  return { files, unassignedDiff };
}

function requestedFiles(card: ToolCard): Array<Pick<EditFile, "path" | "sourcePath" | "operation">> {
  const files: Array<Pick<EditFile, "path" | "sourcePath" | "operation">> = [];
  const path = text(card.args.path) ?? text(card.args.file_path);
  if (path) {
    const edits = Array.isArray(card.args.edits) ? card.args.edits.map(record).filter(isPresent) : [];
    const rename = edits.map(edit => text(edit.rename)).find(isPresent);
    files.push({ path: rename ?? path, sourcePath: rename ? path : undefined, operation: rename ? "Rename" : operation(edits[0]?.op, card.toolName) });
  } else {
    // These are grammar headers in OMP's freeform input, not lines from a diff.
    // Replacement bodies have a '+' prefix and cannot become file headers.
    const input = text(card.args.input);
    if (input && /^\s*(?:\*\*\* Begin Patch|\[[^\r\n]+#[\da-f]{4}\])/i.test(input)) {
      for (const rawLine of input.split("\n")) {
        const line = rawLine.trimEnd();
        const hashline = /^\[(.+)#[\da-f]{4}\]$/i.exec(line);
        const patch = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
        if (hashline || patch) {
          files.push({ path: hashline ? unquotePath(hashline[1]) : patch![2], operation: patch?.[1] === "Add" ? "Create" : patch?.[1] === "Delete" ? "Delete" : "Edit" });
        } else if (files.length && (line === "REM" || line.startsWith("MV ") || line.startsWith("*** Move to: "))) {
          const file = files[files.length - 1];
          if (line === "REM") file.operation = "Delete";
          else {
            const destination = line.startsWith("MV ") ? line.slice(3) : line.slice(13);
            file.sourcePath = file.path ?? undefined;
            file.path = unquotePath(destination);
            file.operation = "Rename";
          }
        }
      }
    }
    const details = record(record(editResultSource(card))?.details);
    if (!files.length && card.toolName === "ast_edit" && Array.isArray(details?.files)) {
      for (const file of details.files) if (typeof file === "string") files.push({ path: file, operation: "AST Edit" });
    }
  }
  return files;
}

function unquotePath(value: string): string {
  const path = value.trim();
  return (path.startsWith("\"") && path.endsWith("\"")) || (path.startsWith("'") && path.endsWith("'"))
    ? path.slice(1, -1) : path;
}

function operation(op: unknown, toolName: string): string {
  if (op === "create") return "Create";
  if (op === "delete") return "Delete";
  return toolName === "write" ? "Write" : toolName === "ast_edit" ? "AST Edit" : "Edit";
}

export function editDiffStats(diff: string): { added: number; removed: number; lines: number } {
  let added = 0, removed = 0, lines = 0;
  for (let offset = 0; offset < diff.length;) {
    if (diff[offset] === "+" && !diff.startsWith("+++ ", offset)) added++;
    else if (diff[offset] === "-" && !diff.startsWith("--- ", offset)) removed++;
    lines++;
    const newline = diff.indexOf("\n", offset);
    offset = newline < 0 ? diff.length : newline + 1;
  }
  return { added, removed, lines };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function isPresent<T>(value: T | undefined): value is T { return value !== undefined; }
