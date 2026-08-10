import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { neonTerraformExport } from "../terraform.js";

function branch(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "acc:neon-branch:p1/b1",
    pluginId: "neon",
    resourceTypeId: "neon-branch",
    accountId: "acc",
    displayName: "main",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "b1",
    parentResourceId: "acc:neon-project:p1",
    createdAt: "",
    updatedAt: "",
  };
}

describe("neonTerraformExport neon-branch", () => {
  it("maps branch with composite import id", () => {
    const result = neonTerraformExport.mapResource(
      branch({
        name: "main",
        projectId: "p1",
      }),
    );
    expect(result?.resource.type).toBe("neon_branch");
    expect(result?.resource.attributes).toMatchObject({
      project_id: { kind: "string", value: "p1" },
      name: { kind: "string", value: "main" },
    });
    expect(result?.resource.importId).toBe("p1/b1");
  });
});
