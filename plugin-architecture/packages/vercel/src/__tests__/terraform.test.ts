import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { vercelTerraformExport } from "../terraform.js";

function project(fields: Record<string, string | number | boolean>): ResourceInstance {
  return {
    id: "acc:vercel-project:prj_1",
    pluginId: "vercel",
    resourceTypeId: "vercel-project",
    accountId: "acc",
    displayName: "my-app",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "prj_1",
    createdAt: "",
    updatedAt: "",
  };
}

describe("vercelTerraformExport vercel-project", () => {
  it("maps a project with framework and region", () => {
    const result = vercelTerraformExport.mapResource(
      project({
        name: "my-app",
        framework: "nextjs",
        serverlessFunctionRegion: "iad1",
      }),
    );
    expect(result?.resource.type).toBe("vercel_project");
    expect(result?.resource.attributes).toMatchObject({
      name: { kind: "string", value: "my-app" },
      framework: { kind: "string", value: "nextjs" },
      serverless_function_region: { kind: "string", value: "iad1" },
    });
    expect(result?.resource.importId).toBe("prj_1");
  });
});
