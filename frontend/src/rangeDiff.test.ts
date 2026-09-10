import { describe, expect, it } from "vitest";
import { renderRangeDiffOutput } from "./rangeDiff";

// Captured from Git 2.50.1: unchanged/reordered rebased commits have new OIDs;
// changed inner additions retain green while outer removal/addition is inverse.
const nativeAnsi = [
  "\x1b[32m-:  ------- > 1:  393a29d Upstream advance\x1b[m",
  "\x1b[33m4:  f94bcd0 = 2:  6395c3e Reordered patch\x1b[m",
  "\x1b[33m1:  2538b26 = 3:  4e06cd2 Unchanged café <tag>\x1b[m",
  "\x1b[31m2:  9eae9b0 \x1b[m\x1b[33m!\x1b[m\x1b[32m 4:  5002f7e\x1b[m\x1b[33m Changed patch\x1b[m",
  "    \x1b[7m\x1b[36m@@\x1b[m \x1b[mchanged.rs (new)\x1b[m",
  "    \x1b[32m +let item_13 = 13;\x1b[m",
  "    \x1b[32m +let item_14 = 14;\x1b[m",
  "    \x1b[32m +let item_15 = 15;\x1b[m",
  "    \x1b[7m\x1b[31m-\x1b[m\x1b[2;32m+let choice = 1;\x1b[m",
  "    \x1b[7m\x1b[32m+\x1b[m\x1b[1;32m+let choice = 2;\x1b[m",
  "\x1b[31m3:  e46679d < -:  ------- Removed legacy\x1b[m",
  "\x1b[32m-:  ------- > 5:  12c928a Added contribution\x1b[m",
  "",
].join("\n");
const nativePlain = [
  "-:  ------- > 1:  393a29d Upstream advance",
  "4:  f94bcd0 = 2:  6395c3e Reordered patch",
  "1:  2538b26 = 3:  4e06cd2 Unchanged café <tag>",
  "2:  9eae9b0 ! 4:  5002f7e Changed patch",
  "    @@ changed.rs (new)",
  "     +let item_13 = 13;",
  "     +let item_14 = 14;",
  "     +let item_15 = 15;",
  "    -+let choice = 1;",
  "    ++let choice = 2;",
  "3:  e46679d < -:  ------- Removed legacy",
  "-:  ------- > 5:  12c928a Added contribution",
  "",
].join("\n");

function render(output: string, truncated = false) {
  const container = document.createElement("div");
  renderRangeDiffOutput(container, output, truncated);
  return { container, pre: container.querySelector("pre")! };
}

describe("native Git range-diff rendering", () => {
  it("preserves native order and text, annotating only Git's unchanged summaries", () => {
    const { pre } = render(nativeAnsi);
    const expected = nativePlain
      .replace("Reordered patch\n", "Reordered patch (no change)\n")
      .replace("Unchanged café <tag>\n", "Unchanged café <tag> (no change)\n");
    expect(pre.textContent).toBe(expected);
    expect(render(nativePlain).pre.textContent).toBe(expected);
    expect(pre.querySelectorAll(".range-diff-no-change")).toHaveLength(2);
    expect(pre.querySelectorAll("a, button, img, tag")).toHaveLength(0);
  });

  it("keeps inverse outer diff prefixes separate from dim/bold inner additions", () => {
    const { pre } = render(nativeAnsi);
    const removed = pre.querySelector(".range-diff-inverse.range-diff-fg-31")!;
    const added = pre.querySelector(".range-diff-inverse.range-diff-fg-32")!;
    expect(removed.textContent).toBe("-");
    expect(removed.nextSibling?.textContent).toBe("+let choice = 1;");
    expect(pre.querySelector(".range-diff-dim.range-diff-fg-32")?.textContent).toBe("+let choice = 1;");
    expect(added.textContent).toBe("+");
    expect(pre.querySelector(".range-diff-bold.range-diff-fg-32")?.textContent).toBe("+let choice = 2;");
    expect(pre.querySelector(".range-diff-inverse.range-diff-fg-36")?.textContent).toBe("@@");
  });

  it("does not interpret unfamiliar output or indented commit/body text", () => {
    const unfamiliar = "Future range format → café 😀\n\t<em>not HTML</em>\n"
      + "    1:  abcdef0 = 2:  fedcba0 quoted subject\n"
      + "    +1:  abcdef0 = 2:  fedcba0 source text\n"
      + "1:  unknown = 2:  unknown new format\n"
      + "1:  abcdef0 ! 2:  fedcba0 changed\n"
      + "-:  ------- > 3:  abcdef0 added\n"
      + "2:  abcdef0 < -:  ------- removed\n";
    const { pre } = render(unfamiliar);
    expect(pre.textContent).toBe(unfamiliar);
    expect(pre.querySelectorAll("span, em")).toHaveLength(0);
    expect(render("1:  abcdef0 = 2:  fedcba0 subject").pre.textContent)
      .toBe("1:  abcdef0 = 2:  fedcba0 subject (no change)");
  });

  it("labels padded native summaries without interpreting four-space body text", () => {
    const text = "  1:  abcdef0 = 120:  fedcba0 reordered\n"
      + "120:  abcdef0 =   1:  fedcba0 unchanged\n"
      + "    1:  abcdef0 = 2:  fedcba0 quoted body\n";
    expect(render(text).pre.textContent).toBe(
      "  1:  abcdef0 = 120:  fedcba0 reordered (no change)\n"
      + "120:  abcdef0 =   1:  fedcba0 unchanged (no change)\n"
      + "    1:  abcdef0 = 2:  fedcba0 quoted body\n",
    );
  });

  it("allows only fixed SGR styles and honors individual and complete resets", () => {
    const { pre } = render("\x1b[1;2;31;44;7mA\x1b[22;27;39;49mB\x1b[91;104mC\x1b[0mD"
      + "\x1b[38;2;31;44;7mE\x1b[8mF\x1b[4mG\x1b[31:1mH");
    expect(pre.textContent).toBe("ABCDEFGH");
    const spans = pre.querySelectorAll("span");
    expect(spans).toHaveLength(2);
    expect(spans[0].classList.contains("range-diff-bold")).toBe(true);
    expect(spans[0].classList.contains("range-diff-dim")).toBe(true);
    expect(spans[0].classList.contains("range-diff-inverse")).toBe(true);
    expect(spans[0].classList.contains("range-diff-bg-44")).toBe(true);
    expect(spans[1].textContent).toBe("C");
    expect(spans[1].classList.contains("range-diff-fg-91")).toBe(true);
    expect(spans[1].classList.contains("range-diff-bg-104")).toBe(true);
  });

  it("keeps hostile markup literal while removing terminal actions and controls", () => {
    const { container, pre } = render("café 😀\t<img src=x onerror=alert(1)>\n"
      + "\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x1b\\"
      + "\x1b[2J\x1b[1;1H\x1b[?25l\x1bPprivate payload\x1b\\"
      + "\x1b_private APC\x1b\\\x1b^private PM\x1b\\\x1bXprivate SOS\x1b\\"
      + "\x9d0;private title\x9c\x90private DCS\x9c\x9b2K"
      + "\x00\x08\x0d\x7f\x85\x1b(Bdone\n");
    expect(pre.textContent).toBe("café 😀\t<img src=x onerror=alert(1)>\nclickdone\n");
    expect(container.querySelectorAll("img, a, script, button, iframe")).toHaveLength(0);
    expect(render("safe\x1b]8;;unterminated URL").pre.textContent).toBe("safe");
    expect(render("safe\x1bPunterminated payload").pre.textContent).toBe("safe");
    expect(render("safe\x1b[31;").pre.textContent).toBe("safe");
    expect(render("before\x1b\nafter").pre.textContent).toBe("before\nafter");
  });

  it("distinguishes empty output from truncated empty output and replaces old notices", () => {
    const { container, pre } = render("");
    expect(pre.textContent).toBe("");
    expect(container.querySelector(".range-diff-empty")).not.toBeNull();
    renderRangeDiffOutput(container, "", true);
    expect(container.querySelector(".range-diff-empty")).toBeNull();
    expect(container.querySelector(".range-diff-truncated")).not.toBeNull();
    renderRangeDiffOutput(container, "new result", false);
    expect(container.querySelector("pre")?.textContent).toBe("new result");
    expect(container.querySelector(".range-diff-notice")).toBeNull();
  });

  it("caps raw UTF-8 before processing and does not split supplementary Unicode", () => {
    const input = (`${"café😀".repeat(1_000)}\n`).repeat(30);
    const { container, pre } = render(input);
    expect(input.startsWith(pre.textContent!)).toBe(true);
    expect(new TextEncoder().encode(pre.textContent!).length).toBeLessThanOrEqual(256_000);
    expect(pre.textContent).not.toMatch(/[\ud800-\udbff]$/u);
    expect(container.querySelector(".range-diff-truncated")).not.toBeNull();
  });

  it("bounds lines and long lines with an explicit prefix notice", () => {
    const lines = render("x\n".repeat(10_001));
    expect(lines.pre.textContent).toBe("x\n".repeat(10_000));
    expect(lines.container.querySelector(".range-diff-truncated")).not.toBeNull();
    const longLine = render(`${"😀".repeat(16_385)}\nnot reached`);
    expect(longLine.pre.textContent).toBe("😀".repeat(16_384));
    expect(longLine.container.querySelector(".range-diff-truncated")).not.toBeNull();
    const boundary = `${"x".repeat(16_384)}\nend`;
    const complete = render(boundary);
    expect(complete.pre.textContent).toBe(boundary);
    expect(complete.container.querySelector(".range-diff-truncated")).toBeNull();
  });

  it("falls back to complete plain text rather than dropping text at the span cap", () => {
    const { container, pre } = render("\x1b[31ma\x1b[32mb".repeat(2_000));
    expect(pre.textContent).toBe("ab".repeat(2_000));
    expect(pre.querySelectorAll("span")).toHaveLength(0);
    expect(container.querySelector(".range-diff-plain-fallback")).not.toBeNull();
    expect(container.querySelector(".range-diff-truncated")).toBeNull();
  });
});
