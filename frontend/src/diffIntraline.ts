export type ChangedRange = { start: number; end: number };

type Token = ChangedRange & { text: string; kind: "word" | "space" | "symbol" };
type Match = { before: number; after: number };

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

function tokenize(text: string): Token[] | null {
  if (!segmenter) return null;
  const tokens: Token[] = [];
  let graphemes = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (++graphemes > 256) return null;
    const kind = /^[\p{L}\p{N}\p{M}_]+$/u.test(segment) ? "word" : /^\s+$/u.test(segment) ? "space" : "symbol";
    const previous = tokens[tokens.length - 1];
    if (kind !== "symbol" && previous?.kind === kind) {
      previous.end = index + segment.length;
    } else {
      tokens.push({ text: "", start: index, end: index + segment.length, kind });
    }
  }
  for (const token of tokens) token.text = text.slice(token.start, token.end);
  return tokens;
}

function changedRanges(tokens: readonly Token[], matched: readonly number[]): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let next = 0;
  for (const index of matched) {
    if (next < index) ranges.push({ start: tokens[next].start, end: tokens[index - 1].end });
    next = index + 1;
  }
  if (next < tokens.length) ranges.push({ start: tokens[next].start, end: tokens[tokens.length - 1].end });
  return ranges;
}

/**
 * Conservative word-level LCS; ranges always use original UTF-16 grapheme boundaries.
 * Each input is limited to 2048 code units and 256 graphemes, with at most 65536
 * Uint16 DP cells. Two extremal traces reject ambiguous repeated-token alignments.
 * Require an unchanged word and at least half of the longer source unchanged:
 * unrelated, wholesale, unsupported, or over-budget replacements return null.
 * Words and whitespace runs are atomic; this deliberately does not diff inside words.
 */
export function intralineChanges(
  before: string,
  after: string,
): {
  before: ChangedRange[];
  after: ChangedRange[];
} | null {
  if (before === after || before.length > 2048 || after.length > 2048) return null;
  const left = tokenize(before);
  const right = tokenize(after);
  if (!left || !right) return null;
  const width = right.length + 1;
  const cells = (left.length + 1) * width;
  if (cells > 65536) return null;

  const lengths = new Uint16Array(cells);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        left[i].text === right[j].text
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  if (!lengths[0]) return null;

  // Opposite skip preferences bound all optimal alignments, including repeated
  // equal tokens. Different matched positions mean the highlight is uncertain.
  const trace = (skipBefore: boolean): Match[] => {
    const matches: Match[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length && lengths[i * width + j]) {
      const current = lengths[i * width + j];
      if (skipBefore && lengths[(i + 1) * width + j] === current) {
        i++;
      } else if (!skipBefore && lengths[i * width + j + 1] === current) {
        j++;
      } else if (left[i].text === right[j].text) {
        matches.push({ before: i++, after: j++ });
      } else if (skipBefore) {
        j++;
      } else {
        i++;
      }
    }
    return matches;
  };

  const matches = trace(true);
  const alternative = trace(false);
  if (matches.some((match, index) => match.before !== alternative[index]?.before || match.after !== alternative[index]?.after)) {
    return null;
  }
  let retained = 0;
  let retainedWord = false;
  for (const match of matches) {
    const token = left[match.before];
    retained += token.end - token.start;
    retainedWord ||= token.kind === "word";
  }
  if (!retainedWord || retained * 2 < Math.max(before.length, after.length)) return null;

  return {
    before: changedRanges(
      left,
      matches.map((match) => match.before),
    ),
    after: changedRanges(
      right,
      matches.map((match) => match.after),
    ),
  };
}
