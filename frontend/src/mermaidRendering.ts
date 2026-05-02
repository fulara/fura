import type { Mermaid } from "mermaid";
import { mkEl } from "./dom";

export type MermaidRenderState = {
  source: string;
  svg: string | null;
  error: string | null;
};

const MAX_PNG_DIMENSION = 4096;
const MAX_PNG_PIXELS = 16_777_216;
const DEFAULT_PNG_WIDTH = 1200;
const DEFAULT_PNG_HEIGHT = 800;

let initialized = false;
let nextRenderId = 0;
let mermaidClientPromise: Promise<Mermaid> | null = null;

async function loadMermaidClient(): Promise<Mermaid> {
  mermaidClientPromise ??= import("mermaid").then(module => module.default);
  const mermaid = await mermaidClientPromise;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    initialized = true;
  }
  return mermaid;
}

function nextMermaidId(): string {
  nextRenderId += 1;
  return `fura-mermaid-${nextRenderId}`;
}

function mermaidDownloadName(extension: "svg" | "png"): string {
  return `fura-mermaid-diagram.${extension}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown Mermaid render error.";
}

function setButtonStatus(button: HTMLButtonElement, text: string, owner: Document, resetText: string): void {
  button.textContent = text;
  owner.defaultView?.setTimeout(() => {
    button.disabled = false;
    button.textContent = resetText;
  }, 1200);
}

function downloadBlob(blob: Blob, fileName: string, owner: Document): void {
  const url = URL.createObjectURL(blob);
  const link = owner.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  owner.body.append(link);
  link.click();
  link.remove();
  owner.defaultView?.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function renderMermaidSvg(source: string): Promise<string> {
  const mermaid = await loadMermaidClient();
  const result = await mermaid.render(nextMermaidId(), source);
  return result.svg;
}

export function renderMermaidBlock(source: string): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = "mermaid-block";
  wrapper.dataset.mermaidState = "pending";

  const state: MermaidRenderState = { source, svg: null, error: null };

  const header = mkEl("div");
  header.className = "mermaid-header";

  const label = mkEl("span");
  label.className = "mermaid-label";
  label.textContent = "mermaid";

  const actions = mkEl("div");
  actions.className = "mermaid-actions";

  const copySource = mkEl("button");
  copySource.type = "button";
  copySource.className = "mermaid-action";
  copySource.textContent = "Copy source";
  copySource.addEventListener("click", async () => {
    copySource.disabled = true;
    try {
      await navigator.clipboard.writeText(source);
      setButtonStatus(copySource, "Copied", wrapper.ownerDocument, "Copy source");
    } catch {
      setButtonStatus(copySource, "Copy unavailable", wrapper.ownerDocument, "Copy source");
    }
  });

  const saveSvg = mkEl("button");
  saveSvg.type = "button";
  saveSvg.className = "mermaid-action";
  saveSvg.textContent = "Save SVG";
  saveSvg.disabled = true;
  saveSvg.addEventListener("click", () => {
    if (!state.svg) return;
    saveSvg.disabled = true;
    try {
      downloadBlob(new Blob([state.svg], { type: "image/svg+xml;charset=utf-8" }), mermaidDownloadName("svg"), wrapper.ownerDocument);
      setButtonStatus(saveSvg, "Saved", wrapper.ownerDocument, "Save SVG");
    } catch {
      setButtonStatus(saveSvg, "Save failed", wrapper.ownerDocument, "Save SVG");
    }
  });

  const savePng = mkEl("button");
  savePng.type = "button";
  savePng.className = "mermaid-action";
  savePng.textContent = "Save PNG";
  savePng.disabled = true;
  savePng.addEventListener("click", async () => {
    if (!state.svg) return;
    savePng.disabled = true;
    try {
      const blob = await svgToPngBlob(state.svg, wrapper.ownerDocument);
      downloadBlob(blob, mermaidDownloadName("png"), wrapper.ownerDocument);
      setButtonStatus(savePng, "Saved", wrapper.ownerDocument, "Save PNG");
    } catch {
      setButtonStatus(savePng, "Save failed", wrapper.ownerDocument, "Save PNG");
    }
  });

  actions.append(copySource, saveSvg, savePng);
  header.append(label, actions);

  const preview = mkEl("div");
  preview.className = "mermaid-preview";
  preview.setAttribute("role", "img");
  preview.setAttribute("aria-label", "Mermaid diagram preview");
  preview.textContent = "Rendering Mermaid diagram…";

  const details = mkEl("details");
  details.className = "mermaid-source";
  const summary = mkEl("summary");
  summary.textContent = "Mermaid source";
  const pre = mkEl("pre");
  const code = mkEl("code");
  code.textContent = source;
  pre.append(code);
  details.append(summary, pre);

  wrapper.append(header, preview, details);

  queueMicrotask(() => {
    void renderMermaidSvg(source)
      .then(svg => {
        state.svg = svg;
        wrapper.dataset.mermaidState = "rendered";
        preview.classList.remove("mermaid-error");
        preview.replaceChildren();
        preview.innerHTML = svg;
        saveSvg.disabled = false;
        savePng.disabled = false;
      })
      .catch(error => {
        state.error = errorMessage(error);
        wrapper.dataset.mermaidState = "error";
        preview.classList.add("mermaid-error");
        preview.textContent = `Unable to render Mermaid diagram: ${state.error}`;
      });
  });

  return wrapper;
}

export type SvgCanvasDimensions = {
  width: number;
  height: number;
  scale: number;
};

export function canvasDimensionsForSvg(svg: string): SvgCanvasDimensions {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  if (!svgEl) return { width: DEFAULT_PNG_WIDTH, height: DEFAULT_PNG_HEIGHT, scale: 1 };

  const viewBox = svgEl.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const viewBoxWidth = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : NaN;
  const viewBoxHeight = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[3]) ? viewBox[3] : NaN;
  const attrWidth = parseSvgLength(svgEl.getAttribute("width"));
  const attrHeight = parseSvgLength(svgEl.getAttribute("height"));

  const rawWidth = positiveNumber(viewBoxWidth) ?? positiveNumber(attrWidth) ?? DEFAULT_PNG_WIDTH;
  const rawHeight = positiveNumber(viewBoxHeight) ?? positiveNumber(attrHeight) ?? DEFAULT_PNG_HEIGHT;
  const scale = Math.min(
    1,
    MAX_PNG_DIMENSION / rawWidth,
    MAX_PNG_DIMENSION / rawHeight,
    Math.sqrt(MAX_PNG_PIXELS / (rawWidth * rawHeight)),
  );

  return {
    width: Math.max(1, Math.floor(rawWidth * scale)),
    height: Math.max(1, Math.floor(rawHeight * scale)),
    scale,
  };
}

function parseSvgLength(value: string | null): number {
  if (!value) return NaN;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(value);
  return match ? Number(match[1]) : NaN;
}

function positiveNumber(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function svgToPngBlob(svg: string, owner: Document = document): Promise<Blob> {
  const dimensions = canvasDimensionsForSvg(svg);
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = await loadImage(url, owner);
    const canvas = owner.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is not supported in this browser.");
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string, owner: Document): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const ImageCtor = owner.defaultView?.Image;
    if (!ImageCtor) {
      reject(new Error("Image loading is not supported in this browser."));
      return;
    }
    const image = new ImageCtor();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Rendered SVG could not be loaded for PNG export."));
    image.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas PNG export failed."));
      }
    }, "image/png");
  });
}
