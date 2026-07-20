import { describe, expect, it } from "vitest";
import {
  catalogContainsProposedModel,
  filterCatalogModels,
  formatCatalogModelLabel,
  formatModelContext,
  formatModelSelector,
  formatProposedModelDetails,
  normalizeSelectedProposedModelId,
  proposedModelIdFromName,
  removeProposedModel,
  upsertProposedModel,
  validateProposedModels,
} from "./proposedModels";
import type { ModelSummary, ProposedModelConfig } from "./protocol";

const catalog: ModelSummary[] = [
  { provider: "mock", id: "mock-model", name: "Mock Model", contextWindow: 200000, thinking: false },
  { provider: "mock", id: "mock-reasoner", name: "Mock Reasoner", contextWindow: 1000000, thinking: true },
  { provider: "local", id: "tiny", name: "Tiny Fast Mock", contextWindow: 32000, thinking: false },
];

const proposed: ProposedModelConfig = {
  id: "fast-review",
  name: "Fast review",
  provider: "mock",
  modelId: "mock-reasoner",
  modelName: "Mock Reasoner",
  thinkingLevel: "max",
};

describe("proposed model helpers", () => {
  it("generates stable slug ids and avoids duplicates", () => {
    expect(proposedModelIdFromName("Fast review", [])).toBe("fast-review");
    expect(proposedModelIdFromName("Fast review", ["fast-review"])).toBe("fast-review-2");
    expect(proposedModelIdFromName("!!!", [])).toBe("model");
  });

  it("validates required fields, ids, and duplicate names", () => {
    expect(validateProposedModels([proposed])).toBeNull();
    expect(validateProposedModels([{ ...proposed, id: "Bad Id" }])).toContain("Invalid proposed model id");
    expect(validateProposedModels([{ ...proposed, name: " " }])).toBe("Proposed model name is required.");
    expect(validateProposedModels([proposed, { ...proposed, id: "other" }])).toContain("Duplicate proposed model name");
    expect(validateProposedModels([{ ...proposed, thinkingLevel: "xhigh" }])).toBeNull();
  });

  it("filters and formats runtime catalog models", () => {
    expect(filterCatalogModels(catalog, "reasoner").map(model => model.id)).toEqual(["mock-reasoner"]);
    expect(filterCatalogModels(catalog, "local tiny").map(model => model.id)).toEqual(["tiny"]);
    expect(formatModelSelector(catalog[0])).toBe("mock/mock-model");
    expect(formatModelContext(catalog[0])).toBe("200K context");
    expect(formatCatalogModelLabel(catalog[1])).toBe("Mock Reasoner (mock/mock-reasoner)");
  });

  it("formats proposed model details and detects stale catalog entries", () => {
    expect(formatProposedModelDetails(proposed)).toBe("Mock Reasoner · Max thinking");
    expect(catalogContainsProposedModel(catalog, proposed)).toBe(true);
    expect(catalogContainsProposedModel(catalog, { ...proposed, modelId: "missing" })).toBe(false);
  });

  it("supports add edit remove and selection reset semantics", () => {
    const added = upsertProposedModel([], proposed);
    expect(added).toEqual([proposed]);
    const edited = upsertProposedModel(added, { ...proposed, name: "Edited review" }, proposed.id);
    expect(edited[0]?.name).toBe("Edited review");
    expect(removeProposedModel(edited, proposed.id)).toEqual([]);
    expect(normalizeSelectedProposedModelId("missing", [proposed])).toBe("default");
    expect(normalizeSelectedProposedModelId(proposed.id, [proposed])).toBe(proposed.id);
  });
});
