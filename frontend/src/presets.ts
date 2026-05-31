import type { ClientMessage, PresetSummary } from "./protocol";

/**
 * `{param}` placeholder syntax. The body of a preset is the canonical source of
 * truth for which parameters exist; `defaults` only decorates them by name.
 */
const PARAM_PATTERN = /\{([A-Za-z][A-Za-z0-9_-]*)\}/g;

/** Unique parameter names referenced in `body`, in order of first appearance. */
export function parsePresetParams(body: string): string[] {
  const seen = new Set<string>();
  const params: string[] = [];
  for (const match of body.matchAll(PARAM_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      params.push(name);
    }
  }
  return params;
}

/** Replace `{param}` tokens with provided values; unknown tokens are left intact. */
export function substitutePresetParams(body: string, values: Record<string, string>): string {
  return body.replace(PARAM_PATTERN, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
    const value = values[name];
    return value === undefined ? whole : value;
  });
}

/** Slug rule mirrored from the Rust `validate_preset_name` (incl. the 64-char cap). */
export function isValidPresetName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name);
}

/** Normalize free text into a valid preset slug (lowercase, `-`-separated). */
export function presetNameFromInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function findPreset(presets: PresetSummary[], name: string): PresetSummary | undefined {
  return presets.find(preset => preset.name === name);
}

/**
 * A parameter is required only when it has no default. Defaulted parameters are
 * pre-filled and considered satisfied even if the user clears them.
 */
export function requiredParamsFilled(
  params: string[],
  defaults: Record<string, string>,
  values: Record<string, string>,
): boolean {
  return params.every(param => {
    if (Object.prototype.hasOwnProperty.call(defaults, param)) return true;
    const value = values[param];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Keep only non-empty defaults whose key is an actual parameter (no drift). */
export function pruneDefaults(
  params: string[],
  defaults: Record<string, string>,
): Record<string, string> {
  const pruned: Record<string, string> = {};
  for (const param of params) {
    const value = defaults[param];
    if (typeof value === "string" && value.length > 0) pruned[param] = value;
  }
  return pruned;
}

export function buildPresetSaveMessage(
  name: string,
  description: string,
  body: string,
  defaults: Record<string, string>,
): ClientMessage {
  const message: ClientMessage = { type: "preset.save", name, body };
  const trimmedDescription = description.trim();
  if (trimmedDescription) message.description = trimmedDescription;
  if (Object.keys(defaults).length > 0) message.defaults = defaults;
  return message;
}

export type PresetCommandResolution =
  | { kind: "picker" }
  | { kind: "unknown"; name: string; available: string[] }
  | { kind: "run"; preset: PresetSummary }
  | { kind: "params"; preset: PresetSummary };

/**
 * Resolve a `/presets [name]` (or `/preset [name]`) command against the known
 * preset list. Extra arguments after the name are ignored in v1.
 */
export function resolvePresetCommand(
  input: string,
  presets: PresetSummary[],
): PresetCommandResolution {
  const match = input.trim().match(/^\/(?:presets|preset)\b\s*(.*)$/i);
  const rest = match ? match[1].trim() : "";
  if (!rest) return { kind: "picker" };

  const name = rest.split(/\s+/)[0];
  const preset = findPreset(presets, name);
  if (!preset) {
    return { kind: "unknown", name, available: presets.map(entry => entry.name) };
  }
  const params = parsePresetParams(preset.body);
  return params.length === 0 ? { kind: "run", preset } : { kind: "params", preset };
}
