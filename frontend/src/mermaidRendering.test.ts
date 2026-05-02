import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

import { canvasDimensionsForSvg, renderMermaidBlock, svgToPngBlob } from "./mermaidRendering";
import { renderCodeBlock, renderMarkdown } from "./transcriptView";

async function flushMermaidRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 350));
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mermaidMock.render.mockResolvedValue({
    svg: '<svg viewBox="0 0 100 50" role="img"><g id="diagram"></g></svg>',
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("renderMermaidBlock", () => {
  it("renders Mermaid source locally into an SVG preview", async () => {
    const node = renderMermaidBlock("flowchart TD\n  A --> B");
    document.body.append(node);

    expect(node.className).toBe("mermaid-block");
    expect(node.dataset.mermaidState).toBe("pending");
    expect(node.querySelector(".mermaid-preview")?.textContent).toBe("Rendering Mermaid diagram…");
    expect(node.querySelector(".mermaid-source")?.textContent).toContain("flowchart TD");

    await flushMermaidRender();

    expect(mermaidMock.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.stringMatching(/^fura-mermaid-/), "flowchart TD\n  A --> B", expect.any(HTMLDivElement));
    expect(node.dataset.mermaidState).toBe("rendered");
    expect(node.querySelector(".mermaid-preview svg")?.getAttribute("viewBox")).toBe("0 0 100 50");
    expect(Array.from(node.querySelectorAll<HTMLButtonElement>(".mermaid-action")).map(button => button.textContent)).toEqual([
      "Copy source",
      "Save SVG",
      "Save PNG",
    ]);
    expect(Array.from(node.querySelectorAll<HTMLButtonElement>(".mermaid-action")).slice(1).every(button => !button.disabled)).toBe(true);
  });

  it("surfaces Mermaid render errors without hiding canonical source", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("Parse error on line 2"));

    const node = renderMermaidBlock("flowchart TD\n  A -->");
    document.body.append(node);
    await flushMermaidRender();

    expect(node.dataset.mermaidState).toBe("error");
    expect(node.querySelector(".mermaid-error")?.textContent).toContain("Parse error on line 2");
    expect(node.querySelector(".mermaid-source")?.textContent).toContain("A -->");
    expect(Array.from(node.querySelectorAll<HTMLButtonElement>(".mermaid-action")).slice(1).every(button => button.disabled)).toBe(true);
  });

  it("cleans up Mermaid temporary render containers after errors", async () => {
    mermaidMock.render.mockImplementationOnce((_id: string, _source: string, container: HTMLElement) => {
      container.innerHTML = '<svg class="mermaid-parser-artifact"></svg>';
      return Promise.reject(new Error("Parse error while streaming"));
    });

    const node = renderMermaidBlock("flowchart TD\n  A -->");
    document.body.append(node);
    await flushMermaidRender();

    expect(node.dataset.mermaidState).toBe("error");
    expect(document.querySelector(".mermaid-parser-artifact")).toBeNull();
  });

  it("copies canonical Mermaid source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();

    const node = renderMermaidBlock("flowchart LR\n  Source --> Preview");
    document.body.append(node);
    node.querySelector<HTMLButtonElement>(".mermaid-action")?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("flowchart LR\n  Source --> Preview");
    expect(node.querySelector<HTMLButtonElement>(".mermaid-action")?.textContent).toBe("Copied");
    vi.runAllTimers();
    expect(node.querySelector<HTMLButtonElement>(".mermaid-action")?.textContent).toBe("Copy source");
  });

  it("downloads rendered SVG without using hosted services", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mermaid-svg");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const node = renderMermaidBlock("flowchart TD\n  A --> B");
    document.body.append(node);
    await flushMermaidRender();
    const saveSvg = Array.from(node.querySelectorAll<HTMLButtonElement>(".mermaid-action"))
      .find(button => button.textContent === "Save SVG");
    vi.useFakeTimers();

    saveSvg?.click();

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
    expect(saveSvg?.textContent).toBe("Saved");
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-svg");
  });
});

describe("Mermaid transcript hook", () => {
  it("routes fenced Mermaid code blocks to the Mermaid renderer", () => {
    const node = renderCodeBlock("mermaid", "flowchart TD\n  A --> B");

    expect(node.className).toBe("mermaid-block");
    expect(node.querySelector(".code-block")).toBeNull();
  });

  it("renders Mermaid fences from Markdown transcript text", () => {
    const node = renderMarkdown("Before\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nAfter");

    expect(node.querySelector(".mermaid-block")).not.toBeNull();
    expect(node.textContent).toContain("Before");
    expect(node.textContent).toContain("After");
  });
});

describe("Mermaid PNG export helpers", () => {
  it("uses the SVG viewBox and scales huge diagrams to bounded canvas dimensions", () => {
    expect(canvasDimensionsForSvg('<svg viewBox="0 0 240 120"></svg>')).toEqual({ width: 240, height: 120, scale: 1 });

    const huge = canvasDimensionsForSvg('<svg viewBox="0 0 100000 50000"></svg>');

    expect(huge.width).toBeLessThanOrEqual(4096);
    expect(huge.height).toBeLessThanOrEqual(4096);
    expect(huge.width * huge.height).toBeLessThanOrEqual(16_777_216);
    expect(huge.scale).toBeLessThan(1);
  });

  it("converts rendered SVG to a PNG blob in the local browser", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mermaid-source-svg");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const originalImage = window.Image;
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    Object.defineProperty(window, "Image", { configurable: true, value: TestImage });

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback, type?: string) {
      callback(new Blob(["png"], { type: type ?? "image/png" }));
    });

    const blob = await svgToPngBlob('<svg viewBox="0 0 32 16"></svg>');

    expect(blob.type).toBe("image/png");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(expect.any(TestImage), 0, 0, 32, 16);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mermaid-source-svg");

    Object.defineProperty(window, "Image", { configurable: true, value: originalImage });
  });
});
