import { mkEl } from "./dom";

export function renderEventTimestamp(timestamp: number | null | undefined): HTMLTimeElement | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  const time = mkEl("time");
  time.className = "event-timestamp";
  time.dateTime = iso;
  time.title = date.toLocaleString();
  time.textContent = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return time;
}

export function appendEventTimestamp(container: HTMLElement, timestamp: number | null | undefined): void {
  const time = renderEventTimestamp(timestamp);
  if (time) container.append(time);
}
