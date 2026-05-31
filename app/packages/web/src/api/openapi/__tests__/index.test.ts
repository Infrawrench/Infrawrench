import { describe, it, expect, vi } from "vitest";

// Path modules transitively import server-core (permissions resolver → db
// client), which throws at import unless these are set. The spec build never
// actually opens a connection.
process.env["DATABASE_URL"] = "postgres://localhost/test";
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

// The OpenAPI builder enumerates plugin/resource-type ids from the live
// registry. Mock the loader so the spec build is deterministic and offline.
vi.mock("@/plugins/loader", () => ({
  loadPlugins: vi.fn().mockResolvedValue([
    {
      plugin: {
        manifest: { id: "aws", displayName: "AWS" },
        resourceTypes: [
          {
            id: "ec2-instance",
            displayName: "EC2 Instance",
            pluralDisplayName: "EC2 Instances",
            credentialFormats: [{ id: "kubeconfig" }],
          },
        ],
      },
    },
    {
      plugin: {
        manifest: { id: "google-cloud", displayName: "Google Cloud" },
        resourceTypes: [{ id: "gce-instance", displayName: "GCE Instance" }],
      },
    },
  ]),
}));

const { buildOpenApiDocument } = await import("@/api/openapi/index");

describe("buildOpenApiDocument", () => {
  it("produces a 3.1.0 document with security schemes and tags", async () => {
    const doc = await buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Infrawrench API");
    expect(doc.components?.securitySchemes).toHaveProperty("sessionCookie");
    expect(doc.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(doc.tags?.some((t) => t.name === "Sync")).toBe(true);
  });

  it("derives operationIds for every operation", async () => {
    const doc = await buildOpenApiDocument();
    const ops: string[] = [];
    for (const item of Object.values(doc.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const op = (item as Record<string, { operationId?: string }>)[method];
        if (op?.operationId) ops.push(op.operationId);
      }
    }
    expect(ops.length).toBeGreaterThan(0);
    // Every operationId should be camelCase starting with the HTTP verb.
    expect(ops.every((id) => /^(get|post|put|patch|delete)[A-Z]/.test(id))).toBe(true);
  });

  it("injects x-required-permission and a description note for guarded routes", async () => {
    const doc = await buildOpenApiDocument();
    let guardedFound = false;
    for (const item of Object.values(doc.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const op = (item as Record<string, Record<string, unknown> | undefined>)[method];
        if (op && typeof op["x-required-permission"] === "string") {
          guardedFound = true;
          expect(op["description"]).toContain("Requires permission");
        }
      }
    }
    expect(guardedFound).toBe(true);
  });

  it("honours a version override", async () => {
    const doc = await buildOpenApiDocument({ version: "9.9.9" });
    expect(doc.info.version).toBe("9.9.9");
  });

  it("uses custom servers when provided", async () => {
    const doc = await buildOpenApiDocument({ servers: [{ url: "https://example.test" }] });
    expect(doc.servers).toEqual([{ url: "https://example.test" }]);
  });
});
