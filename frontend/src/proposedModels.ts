import type { ModelSummary, ProposedModelConfig, ProposedThinkingLevel } from "./protocol";

export const PROPOSED_THINKING_LEVELS: ProposedThinkingLevel[] = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export function proposedModelIdFromName(name: string, existingIds: Iterable<string> = []): string {
  const used = new Set(Array.from(existingIds));
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "model";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function isValidProposedModelId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function validateProposedModels(models: ProposedModelConfig[]): string | null {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const model of models) {
    if (!isValidProposedModelId(model.id)) return `Invalid proposed model id: ${model.id}`;
    const name = model.name.trim();
    if (!name) return "Proposed model name is required.";
    if (!model.provider.trim()) return `Provider is required for ${name}.`;
    if (!model.modelId.trim()) return `Model id is required for ${name}.`;
    if (!PROPOSED_THINKING_LEVELS.includes(model.thinkingLevel)) return `Invalid thinking level for ${name}.`;
    if (ids.has(model.id)) return `Duplicate proposed model id: ${model.id}`;
    ids.add(model.id);
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) return `Duplicate proposed model name: ${name}`;
    names.add(normalizedName);
  }
  return null;
}

export function normalizeModelQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function modelSearchText(model: ModelSummary): string {
  return [model.provider, model.id, model.name ?? ""].join(" ");
}

export function filterCatalogModels(models: ModelSummary[], query: string): ModelSummary[] {
  const normalizedQuery = normalizeModelQuery(query);
  if (!normalizedQuery) return models;
  return models.filter(model => normalizeModelQuery(modelSearchText(model)).includes(normalizedQuery));
}

export function formatModelSelector(model: ModelSummary): string {
  return `${model.provider}/${model.id}`;
}

export function formatModelContext(model: ModelSummary): string | null {
  if (!model.contextWindow) return null;
  if (model.contextWindow >= 1_000_000) return `${(model.contextWindow / 1_000_000).toFixed(1)}M context`;
  if (model.contextWindow >= 1_000) return `${Math.round(model.contextWindow / 1_000)}K context`;
  return `${model.contextWindow} context`;
}

export function formatCatalogModelLabel(model: ModelSummary): string {
  return model.name ? `${model.name} (${formatModelSelector(model)})` : formatModelSelector(model);
}

export function formatProposedModelDetails(model: ProposedModelConfig): string {
  const realModel = model.modelName?.trim() || `${model.provider}/${model.modelId}`;
  const thinking = model.thinkingLevel === "default" ? "Default thinking" : `${capitalize(model.thinkingLevel)} thinking`;
  return `${realModel} · ${thinking}`;
}

export function catalogContainsProposedModel(catalog: ModelSummary[], model: ProposedModelConfig): boolean {
  return catalog.some(entry => entry.provider === model.provider && entry.id === model.modelId);
}

export function removeProposedModel(models: ProposedModelConfig[], id: string): ProposedModelConfig[] {
  return models.filter(model => model.id !== id);
}

export function upsertProposedModel(
  models: ProposedModelConfig[],
  next: ProposedModelConfig,
  editingId?: string | null,
): ProposedModelConfig[] {
  if (!editingId) return [...models, next];
  return models.map(model => model.id === editingId ? next : model);
}

export function normalizeSelectedProposedModelId(
  selectedId: string | null | undefined,
  models: ProposedModelConfig[],
): string {
  if (!selectedId || selectedId === "default") return "default";
  return models.some(model => model.id === selectedId) ? selectedId : "default";
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
