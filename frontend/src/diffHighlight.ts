import hljs from "highlight.js/lib/common";
import { intralineChanges } from "./diffIntraline";
import type { ChangedRange } from "./diffIntraline";

export type DiffHighlightRow = {
  text: string;
  kind: "add" | "remove" | "context" | "meta";
  prefixLength: number;
  oldPath: string | null;
  newPath: string | null;
};

export type DiffHighlighter = { renderLine(index: number, target: HTMLElement): void };

export const DIFF_HIGHLIGHT_LIMITS = {
  maxRows: 2000,
  maxTextCodeUnits: 100_000,
  maxFragmentCodeUnits: 16_000,
  maxFragmentLines: 500,
  maxLineCodeUnits: 4096,
  maxPathCodeUnits: 4096,
  maxTokenRanges: 4096,
  maxWorkMs: 12,
  cacheBytes: 2 * 1024 * 1024,
} as const;

type SyntaxRange = ChangedRange & { classes: string };
type Decoration = { syntax: SyntaxRange[]; changed: ChangedRange[] };
type Fragment = { start: number; end: number; units: number; plain: boolean; done: boolean; lines: Map<number, Decoration> };
const syntaxCache = new Map<string, { ranges: SyntaxRange[]; bytes: number }>();
let syntaxCacheBytes = 0;

const languages: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  md: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "xml",
  htm: "xml",
  xml: "xml",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
};
// Keep this explicit mapping aligned with src/code.rs::language_for_path. A
// mapped language absent from the existing common bundle still stays plain.
export function diffLanguage(path: string | null): string | null {
  if (!path || path.length > DIFF_HIGHLIGHT_LIMITS.maxPathCodeUnits) return null;
  const name = path.split(/[\\/]/).at(-1)!.toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return available("dockerfile");
  if (name === "justfile") return available("bash");
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return available(languages[extension]);
}

function available(language: string | undefined): string | null {
  return typeof language === "string" && hljs.getLanguage(language) ? language : null;
}

/** Lazy per-fragment decoration. Metadata and path changes are hard context boundaries. */
export function createDiffHighlighter(rows: readonly DiffHighlightRow[], owner: Document): DiffHighlighter {
  const plain: DiffHighlighter = {
    renderLine: (index, target) => {
      target.textContent = rows[index]?.text ?? "";
    },
  };
  if (rows.length > DIFF_HIGHLIGHT_LIMITS.maxRows) return plain;
  let total = 0;
  for (const row of rows) {
    total += row.text.length;
    if (total > DIFF_HIGHLIGHT_LIMITS.maxTextCodeUnits) return plain;
  }
  const fragments: Array<Fragment | undefined> = [];
  let fragment: Fragment | undefined;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.kind === "meta" || !Number.isInteger(row.prefixLength) || row.prefixLength < 0 || row.prefixLength > row.text.length) {
      fragment = undefined;
      continue;
    }
    const previous = rows[index - 1];
    if (!fragment || previous.oldPath !== row.oldPath || previous.newPath !== row.newPath) {
      fragment = { start: index, end: index, units: 0, plain: false, done: false, lines: new Map() };
    }
    fragment.end = index + 1;
    const codeLength = row.text.length - row.prefixLength;
    fragment.units += codeLength + 1;
    fragment.plain ||=
      codeLength > DIFF_HIGHLIGHT_LIMITS.maxLineCodeUnits ||
      fragment.units > DIFF_HIGHLIGHT_LIMITS.maxFragmentCodeUnits ||
      fragment.end - fragment.start > DIFF_HIGHLIGHT_LIMITS.maxFragmentLines;
    fragments[index] = fragment;
  }
  let spentMs = 0;
  function prepare(group: Fragment): void {
    group.done = true;
    if (group.plain || spentMs >= DIFF_HIGHLIGHT_LIMITS.maxWorkMs) return;
    const started = performance.now();
    const deadline = started + DIFF_HIGHLIGHT_LIMITS.maxWorkMs - spentMs;
    try {
      const first = rows[group.start];
      const oldLanguage = diffLanguage(first.oldPath ?? first.newPath);
      const newLanguage = diffLanguage(first.newPath ?? first.oldPath);
      if (!oldLanguage && !newLanguage) return;
      const before: number[] = [],
        after: number[] = [];
      for (let index = group.start; index < group.end; index++) {
        if (rows[index].kind !== "add") before.push(index);
        if (rows[index].kind !== "remove") after.push(index);
      }
      const newSyntax = newLanguage ? decorateSide(after, newLanguage, rows, owner, deadline) : null;
      const oldSyntax = oldLanguage ? decorateSide(before, oldLanguage, rows, owner, deadline) : null;
      for (let index = group.start; index < group.end; index++) {
        const syntax = rows[index].kind === "remove" ? oldSyntax?.get(index) : newSyntax?.get(index);
        if (syntax) group.lines.set(index, { syntax, changed: [] });
      }
      if (!oldSyntax || !newSyntax || oldLanguage !== newLanguage) return;
      for (let index = group.start; index < group.end; ) {
        if (rows[index].kind === "context") {
          index++;
          continue;
        }
        const start = index;
        while (index < group.end && rows[index].kind !== "context") index++;
        // Only one removed/added pair, never index-pair a multi-line edit block.
        if (index - start !== 2 || rows[start].kind !== "remove" || rows[start + 1].kind !== "add") continue;
        if (performance.now() >= deadline) break;
        const change = intralineChanges(
          rows[start].text.slice(rows[start].prefixLength),
          rows[start + 1].text.slice(rows[start + 1].prefixLength),
        );
        if (change) {
          group.lines.get(start)!.changed = change.before;
          group.lines.get(start + 1)!.changed = change.after;
        }
      }
    } finally {
      // A synchronous library call cannot be preempted; strict input limits cap
      // each call, and the measured budget prevents further work this render.
      spentMs += performance.now() - started;
    }
  }
  return {
    renderLine(index, target) {
      const row = rows[index];
      const group = fragments[index];
      if (!row || !group) {
        plain.renderLine(index, target);
        return;
      }
      if (!group.done) prepare(group);
      const decoration = group.lines.get(index);
      if (!decoration) {
        plain.renderLine(index, target);
        return;
      }
      paintLine(target, row, decoration, owner);
    },
  };
}

function decorateSide(
  indices: number[],
  language: string,
  rows: readonly DiffHighlightRow[],
  owner: Document,
  deadline: number,
): Map<number, SyntaxRange[]> | null {
  if (!indices.length || performance.now() >= deadline) return null;
  const code = indices.map((index) => rows[index].text.slice(rows[index].prefixLength)).join("\n");
  const ranges = tokenize(code, language, owner);
  if (!ranges) return null;
  const result = new Map<number, SyntaxRange[]>();
  let offset = 0,
    token = 0;
  for (const index of indices) {
    const length = rows[index].text.length - rows[index].prefixLength;
    while (token < ranges.length && ranges[token].end <= offset) token++;
    const line: SyntaxRange[] = [];
    for (let cursor = token; cursor < ranges.length && ranges[cursor].start < offset + length; cursor++) {
      const range = ranges[cursor];
      line.push({
        start: Math.max(range.start, offset) - offset,
        end: Math.min(range.end, offset + length) - offset,
        classes: range.classes,
      });
    }
    result.set(index, line);
    offset += length + 1;
  }
  return result;
}

function tokenize(code: string, language: string, owner: Document): SyntaxRange[] | null {
  // Full fragment text includes its available multiline context. Old/new sides
  // are tokenized separately; no today's-file lookup or highlighter autodetect.
  const key = `${language.length}:${language}${code}`;
  const cached = syntaxCache.get(key);
  if (cached) {
    syntaxCache.delete(key);
    syntaxCache.set(key, cached);
    return cached.ranges;
  }
  try {
    const template = owner.createElement("template");
    template.innerHTML = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    if (template.content.textContent !== code) return null;
    const ranges: SyntaxRange[] = [];
    let offset = 0;
    const visit = (node: Node, inherited: string, depth: number): boolean => {
      if (depth > 64 || ranges.length > DIFF_HIGHLIGHT_LIMITS.maxTokenRanges) return false;
      if (node.nodeType === 3) {
        const length = node.textContent?.length ?? 0;
        if (length && inherited) ranges.push({ start: offset, end: offset + length, classes: inherited });
        offset += length;
        return true;
      }
      if (node.nodeType !== 1 || (node as Element).tagName !== "SPAN") return false;
      const own = [...(node as Element).classList].filter((name) => /^hljs-[a-z0-9_-]+$/.test(name));
      const classes = [...new Set([...inherited.split(" ").filter(Boolean), ...own])].join(" ");
      return [...node.childNodes].every((child) => visit(child, classes, depth + 1));
    };
    if (![...template.content.childNodes].every((node) => visit(node, "", 0))) return null;
    // Cache contains strings/ranges only, never DOM nodes from a popout document.
    // Charge UTF-16 keys/classes plus a conservative per-range object allowance.
    const bytes = key.length * 2 + ranges.reduce((sum, range) => sum + 96 + range.classes.length * 2, 0);
    if (bytes <= DIFF_HIGHLIGHT_LIMITS.cacheBytes) {
      while (syntaxCacheBytes + bytes > DIFF_HIGHLIGHT_LIMITS.cacheBytes && syntaxCache.size) {
        const oldest = syntaxCache.keys().next().value!;
        syntaxCacheBytes -= syntaxCache.get(oldest)!.bytes;
        syntaxCache.delete(oldest);
      }
      syntaxCache.set(key, { ranges, bytes });
      syntaxCacheBytes += bytes;
    }
    return ranges;
  } catch {
    return null;
  }
}

function paintLine(target: HTMLElement, row: DiffHighlightRow, decoration: Decoration, owner: Document): void {
  target.replaceChildren();
  if (row.prefixLength) {
    const prefix = owner.createElement("span");
    prefix.className = "diff-prefix";
    prefix.textContent = row.text.slice(0, row.prefixLength);
    target.append(prefix);
  }
  const content = owner.createElement("span");
  content.className = "diff-syntax";
  target.append(content);
  const code = row.text.slice(row.prefixLength);
  let offset = 0,
    token = 0,
    change = 0;
  while (offset < code.length) {
    while (token < decoration.syntax.length && decoration.syntax[token].end <= offset) token++;
    while (change < decoration.changed.length && decoration.changed[change].end <= offset) change++;
    const syntax = decoration.syntax[token],
      changed = decoration.changed[change];
    const insideSyntax = syntax && syntax.start <= offset;
    const insideChange = changed && changed.start <= offset;
    const end = Math.min(
      code.length,
      syntax ? (insideSyntax ? syntax.end : syntax.start) : code.length,
      changed ? (insideChange ? changed.end : changed.start) : code.length,
    );
    const classes = [insideSyntax ? syntax.classes : "", insideChange ? `diff-intraline-${row.kind}` : ""].filter(Boolean).join(" ");
    if (classes) {
      const span = owner.createElement("span");
      span.className = classes;
      // Always slice the ORIGINAL source, not parsed HTML or highlighted DOM.
      span.textContent = code.slice(offset, end);
      content.append(span);
    } else content.append(owner.createTextNode(code.slice(offset, end)));
    offset = end;
  }
}
