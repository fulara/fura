export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("/") && parts.length > 2) return `…/${parts.slice(-2).join("/")}`;
  return path;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 tokens";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${value}`;
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return `$${value.toFixed(2)}`;
}

export function formatContext(percent: number, windowSize: number): string {
  const pct = percent < 1 ? percent.toFixed(2) : percent.toFixed(1);
  const win = windowSize >= 1_000_000 ? `${(windowSize / 1_000_000).toFixed(1)}M`
    : windowSize >= 1_000 ? `${Math.round(windowSize / 1_000)}K`
    : `${windowSize}`;
  return `${pct}%/${win}`;
}


export function shortId(id: string): string {
  return id.slice(0, 8);
}