import type { ThinkingVisibilityMode } from "./protocol";

export type { ThinkingVisibilityMode };

export function parseToolVisibility(value: unknown): boolean {
  if (value === false || value === "false") return false;
  return true;
}

export function parseThinkingVisibilityMode(value: unknown): ThinkingVisibilityMode {
  if (value === "shown" || value === "true") return "shown";
  if (value === "hidden") return "hidden";
  return "auto";
}

export function nextThinkingVisibilityMode(mode: ThinkingVisibilityMode): ThinkingVisibilityMode {
  if (mode === "auto") return "shown";
  if (mode === "shown") return "hidden";
  return "auto";
}
