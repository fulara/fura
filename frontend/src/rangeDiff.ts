import "./rangeDiff.css";

// Match the bridge's raw UTF-8 cap without encoding/copying an unbounded input.
// Keep at most 10,000 lines, 16,384 code points per line and 2,048 DOM runs
// (at most 4,096 span/text nodes). Excess runs use the same text without color;
// excess bytes/lines/line length stop at a prefix and show a truncation notice.
const MAX_BYTES = 256_000;
const MAX_LINES = 10_000;
const MAX_LINE_LENGTH = 16_384;
const MAX_RUNS = 2_048;

interface Style {
  foreground: number;
  background: number;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
}

function isColor(code: number, start: number): boolean {
  return code >= start && code <= start + 7;
}

function applySgr(style: Style, parameters: string): Style {
  // Reject an unfamiliar SGR as a whole: e.g. 38;2;... must not become dim.
  if (parameters.length > 64 || !/^[\d;]*$/.test(parameters)) return style;
  const codes = parameters.split(";").map(value => Number(value || "0"));
  if (!codes.every(code => [0, 1, 2, 7, 22, 27, 39, 49].includes(code)
    || isColor(code, 30) || isColor(code, 40) || isColor(code, 90) || isColor(code, 100))) return style;
  for (const code of codes) {
    if (code === 0) style = { foreground: 0, background: 0, bold: false, dim: false, inverse: false };
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.foreground = 0;
    else if (code === 49) style.background = 0;
    else if (isColor(code, 30) || isColor(code, 90)) style.foreground = code;
    else style.background = code;
  }
  return style;
}

export function renderRangeDiffOutput(container: HTMLElement, output: string, truncated: boolean): void {
  const owner = container.ownerDocument;
  container.classList.add("range-diff-view");
  const pre = owner.createElement("pre");
  pre.className = "range-diff-output";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Git range-diff output");
  container.replaceChildren(pre);

  let end = 0;
  let bytes = 0;
  while (end < output.length) {
    const point = output.codePointAt(end)!;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > MAX_BYTES) break;
    bytes += size;
    end += point > 0xffff ? 2 : 1;
  }
  let clipped = truncated || end < output.length;
  const input = output.slice(0, end);
  let style: Style = { foreground: 0, background: 0, bold: false, dim: false, inverse: false };
  let classes = "";
  let plain = "";
  let line = "";
  let lineLength = 0;
  let lineNumber = 1;
  let plainFallback = false;
  const runs: { text: string; classes: string }[] = [];
  const append = (text: string, runClasses: string) => {
    plain += text;
    if (plainFallback) return;
    const last = runs[runs.length - 1];
    if (last?.classes === runClasses) last.text += text;
    else if (runs.length < MAX_RUNS) runs.push({ text, classes: runClasses });
    else { runs.length = 0; plainFallback = true; }
  };
  const annotate = () => {
    // Native header padding is at most two spaces with the 256-commit limit.
    if (/^ {0,2}\d+: +[\da-f]{4,64} = +\d+: +[\da-f]{4,64}(?: .*|)$/i.test(line)) {
      append(" (no change)", "range-diff-no-change");
    }
  };

  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90
      || code === 0x98 || code === 0x9e || code === 0x9f) {
      const escape = code === 0x1b;
      const kind = escape ? input.charCodeAt(index + 1) : code;
      index += escape ? 2 : 1;
      if (kind === 0x5b || kind === 0x9b) {
        const start = index;
        while (index < input.length && input.charCodeAt(index) >= 0x20 && input.charCodeAt(index) <= 0x3f) index += 1;
        const final = input.charCodeAt(index);
        if (final >= 0x40 && final <= 0x7e) {
          if (final === 0x6d) {
            style = applySgr(style, input.slice(start, index));
            classes = [
              style.foreground ? `range-diff-fg-${style.foreground}` : "",
              style.background ? `range-diff-bg-${style.background}` : "",
              style.bold ? "range-diff-bold" : "",
              style.dim ? "range-diff-dim" : "",
              style.inverse ? "range-diff-inverse" : "",
            ].filter(Boolean).join(" ");
          }
          index += 1;
        }
      } else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f, 0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(kind)) {
        const osc = kind === 0x5d || kind === 0x9d;
        while (index < input.length) {
          const next = input.charCodeAt(index++);
          if (next === 0x9c || (osc && next === 0x07)) break;
          if (next === 0x1b && input[index] === "\\") { index += 1; break; }
        }
      } else if (escape) {
        // Other ESC sequences: optional intermediates followed by one final byte.
        index -= 1;
        while (index < input.length && input.charCodeAt(index) >= 0x20 && input.charCodeAt(index) <= 0x2f) index += 1;
        if (input.charCodeAt(index) >= 0x30 && input.charCodeAt(index) <= 0x7e) index += 1;
      }
      continue;
    }
    if ((code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    if (lineNumber > MAX_LINES || (code !== 10 && lineLength >= MAX_LINE_LENGTH)) {
      clipped = true;
      break;
    }
    if (code === 10) {
      annotate();
      append("\n", "");
      line = "";
      lineLength = 0;
      lineNumber += 1;
      index += 1;
    } else {
      const length = input.codePointAt(index)! > 0xffff ? 2 : 1;
      const text = input.slice(index, index + length);
      append(text, classes);
      line += text;
      lineLength += 1;
      index += length;
    }
  }
  // Do not label a partial final header as a complete unchanged summary.
  if (!clipped) annotate();

  if (plainFallback) pre.append(owner.createTextNode(plain));
  else for (const run of runs) {
    const text = owner.createTextNode(run.text);
    if (!run.classes) pre.append(text);
    else {
      const span = owner.createElement("span");
      span.className = run.classes;
      span.append(text);
      pre.append(span);
    }
  }
  const notice = (className: string, text: string) => {
    const element = owner.createElement("p");
    element.className = `range-diff-notice ${className}`;
    element.setAttribute("role", "status");
    element.textContent = text;
    container.append(element);
  };
  if (clipped) notice("range-diff-truncated", "Range-diff output truncated. Showing a prefix (limits: 256,000 UTF-8 bytes, 10,000 lines, 16,384 characters per line).");
  if (plainFallback) notice("range-diff-plain-fallback", "Color limit reached (2,048 text runs). Output shown as plain text; no text was dropped by the color limit.");
  if (!plain && !clipped) notice("range-diff-empty", "Git returned no range-diff output.");
}
