import { describe, expect, it, vi } from "vitest";

// Catalogue `models` passthrough (Stage 4.1): the picker offers exactly what a
// save will accept — the same provider both read.
vi.mock("../repositories/tool.repo.js", () => ({ toolRepo: { listByWorkspace: async () => [] } }));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/trigger.repo.js", () => ({
  triggerRepo: { listByWorkspace: async () => [] },
}));
vi.mock("./manifest-builder.service.js", () => ({
  manifestBuilderService: { refFingerprints: async () => ({}), refInterfaces: async () => ({}) },
}));
vi.mock("./generation-provider.service.js", () => ({
  resolveGenerationProvider: async () => ({ allowedModels: ["test-model"], model: "test-model" }),
}));

const { flowCatalogueService } = await import("./flow-catalogue.service.js");

describe("catalogue models — the deployment's configured set, served", () => {
  it("passes models and defaultModel through from the generation provider", async () => {
    const cat = await flowCatalogueService.forWorkspace("ws-1");
    expect(cat.models).toEqual(["test-model"]);
    expect(cat.defaultModel).toBe("test-model");
  });
});
