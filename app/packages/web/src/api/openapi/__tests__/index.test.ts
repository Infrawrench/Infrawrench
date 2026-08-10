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

// Building the whole spec is genuinely expensive — every path module, every
// schema, and a plugin-enum pass — and it grows with the API. The default 5s
// per-test budget was never sized for several full builds under a loaded
// parallel run.
vi.setConfig({ testTimeout: 30_000 });

const { buildOpenApiDocument, getPublicOpenApiDocument } = await import("@/api/openapi/index");

/**
 * The default document, built once and shared.
 *
 * `buildOpenApiDocument` is uncached by design (the cached reader is
 * `getOpenApiDocument`), so every call rebuilds the spec from scratch. Tests
 * that only read the default document have no reason to pay for that more than
 * once; the ones that depend on options or on environment still build their own.
 */
let sharedDoc: Awaited<ReturnType<typeof buildOpenApiDocument>> | null = null;
async function fullDocument() {
  sharedDoc ??= await buildOpenApiDocument();
  return sharedDoc;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function operations(doc: { paths?: Record<string, unknown> }) {
  const out: Array<{ path: string; method: string; op: Record<string, unknown> }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = (item as Record<string, Record<string, unknown> | undefined>)[method];
      if (op) out.push({ path, method, op });
    }
  }
  return out;
}

describe("buildOpenApiDocument", () => {
  it("produces a 3.1.0 document with security schemes and tags", async () => {
    const doc = await fullDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Infrawrench API");
    expect(doc.components?.securitySchemes).toHaveProperty("sessionCookie");
    expect(doc.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(doc.tags?.some((t) => t.name === "Sync")).toBe(true);
  });

  it("derives operationIds for every operation", async () => {
    const doc = await fullDocument();
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
    const doc = await fullDocument();
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

  it("advertises the deployment's own origin when APP_URL is set", async () => {
    const previous = process.env["APP_URL"];
    process.env["APP_URL"] = "https://app.example.test/";
    try {
      const doc = await buildOpenApiDocument();
      expect(doc.servers).toEqual([
        { url: "https://app.example.test", description: "This deployment" },
      ]);
    } finally {
      if (previous === undefined) delete process.env["APP_URL"];
      else process.env["APP_URL"] = previous;
    }
  });

  it("falls back to localhost only when no origin is configured", async () => {
    const app = process.env["APP_URL"];
    const base = process.env["PUBLIC_BASE_URL"];
    delete process.env["APP_URL"];
    delete process.env["PUBLIC_BASE_URL"];
    try {
      const doc = await buildOpenApiDocument();
      expect(doc.servers).toEqual([{ url: "http://localhost:3000", description: "Local dev" }]);
    } finally {
      if (app !== undefined) process.env["APP_URL"] = app;
      if (base !== undefined) process.env["PUBLIC_BASE_URL"] = base;
    }
  });

  it("marks internal routes with x-internal but keeps them in the full document", async () => {
    const doc = await fullDocument();
    expect(doc.paths?.["/api/admin/organizations"]).toBeDefined();
    expect(doc.paths?.["/api/v1/sync/pull"]).toBeDefined();
    const internal = operations(doc).filter((o) => o.op["x-internal"] === true);
    expect(internal.map((o) => o.path)).toContain("/api/org/{orgId}/ws-token");
    expect(internal.map((o) => o.path)).toContain("/api/push/devices");
  });
});

describe("getPublicOpenApiDocument", () => {
  it("omits every internal route", async () => {
    const pub = await getPublicOpenApiDocument();
    for (const path of [
      "/api/admin/organizations",
      "/api/admin/organizations/{orgId}/complimentary",
      "/api/v1/webhooks/stripe",
      "/api/v1/sync/pull",
      "/api/v1/sync/push",
      "/api/v1/sync/status",
      "/api/auth/sign-in",
      "/api/auth/sign-out",
      "/callback",
      "/api/org/{orgId}/ws-token",
      "/api/push/devices",
      "/api/org/{orgId}/push/preferences",
    ]) {
      expect(pub.paths?.[path], `${path} should be stripped`).toBeUndefined();
    }
    expect(operations(pub).some((o) => o.op["x-internal"])).toBe(false);
  });

  it("keeps the public surface", async () => {
    const pub = await getPublicOpenApiDocument();
    expect(pub.paths?.["/api/org/{orgId}/accounts"]).toBeDefined();
    expect(pub.paths?.["/api/auth/me"]).toBeDefined();
  });

  it("advertises bearer auth only — sessionCookie is dropped", async () => {
    const pub = await getPublicOpenApiDocument();
    expect(pub.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(pub.components?.securitySchemes).not.toHaveProperty("sessionCookie");
    expect(pub.security).toEqual([{ bearerAuth: [] }]);
    const named = JSON.stringify(pub).includes("sessionCookie");
    expect(named).toBe(false);
    // The full document still documents it — the cookie still works.
    const full = await fullDocument();
    expect(full.components?.securitySchemes).toHaveProperty("sessionCookie");
  });

  it("drops tags and schemas only internal routes used", async () => {
    const pub = await getPublicOpenApiDocument();
    const tags = (pub.tags ?? []).map((t) => t.name);
    expect(tags).not.toContain("Admin");
    expect(tags).not.toContain("Sync");
    expect(tags).not.toContain("Push");
    expect(tags).toContain("Accounts");
    expect(pub.components?.schemas).not.toHaveProperty("AdminOrganization");
  });

  it("leaves no dangling $refs after pruning", async () => {
    const pub = await getPublicOpenApiDocument();
    const refs = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") refs.add(value);
        else walk(value);
      }
    };
    walk(pub);
    const components = pub.components as Record<string, Record<string, unknown>> | undefined;
    const dangling = [...refs].filter((ref) => {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
      return !match || components?.[match[1]!]?.[match[2]!] === undefined;
    });
    expect(dangling).toEqual([]);
  });

  it("does not mutate the full document", async () => {
    const pub = await getPublicOpenApiDocument();
    const full = await buildOpenApiDocument();
    expect(pub.paths?.["/api/admin/organizations"]).toBeUndefined();
    expect(full.paths?.["/api/admin/organizations"]).toBeDefined();
  });
});
