export type ThinkingVisibilityMode = "auto" | "shown" | "hidden";

export function parseThinkingVisibilityMode(value: string | null): ThinkingVisibilityMode {
  if (value === "shown" || value === "true") return "shown";
  if (value === "hidden") return "hidden";
  return "auto";
}

export function nextThinkingVisibilityMode(mode: ThinkingVisibilityMode): ThinkingVisibilityMode {
  if (mode === "auto") return "shown";
  if (mode === "shown") return "hidden";
  return "auto";
}
