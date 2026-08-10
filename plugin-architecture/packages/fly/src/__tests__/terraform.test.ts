import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { flyTerraformExport } from "../terraform.js";

function volume(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "acc:volume:my-app/vol_1",
    pluginId: "fly",
    resourceTypeId: "volume",
    accountId: "acc",
    displayName: "data",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "my-app/vol_1",
    parentResourceId: "acc:app:my-app",
    createdAt: "",
    updatedAt: "",
  };
}

describe("flyTerraformExport volume", () => {
  it("maps a volume with size and region", () => {
    const result = flyTerraformExport.mapResource(
      volume({
        name: "data",
        appName: "my-app",
        region: "iad",
        sizeGb: 10,
      }),
    );
    expect(result?.resource.type).toBe("fly_volume");
    expect(result?.resource.attributes).toMatchObject({
      app: { kind: "string", value: "my-app" },
      name: { kind: "string", value: "data" },
      region: { kind: "string", value: "iad" },
      size_gb: { kind: "number", value: 10 },
    });
    expect(result?.resource.importId).toBe("my-app/vol_1");
  });
});
