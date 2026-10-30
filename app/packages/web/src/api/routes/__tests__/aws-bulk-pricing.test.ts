import { readFileSync } from "node:fs";

import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { KvPair } from "@/aws-bulk-pricing/kv-rest";
import type { InstanceValue } from "@/aws-bulk-pricing/format";
import { syncAwsBulkPricing } from "@/aws-bulk-pricing/sync";

const mockAuth = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuth(...a),
}));

const { awsBulkPricingRoutes } = await import("@/api/routes/aws-bulk-pricing");

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../aws-bulk-pricing/__tests__/fixtures/${name}`, import.meta.url)),
  );

/** KV as the sync leaves it, from the RDS and EC2 fixture bundles. */
const stored = new Map<string, Uint8Array<ArrayBuffer>>();

beforeAll(async () => {
  const objects: Record<string, Uint8Array | string> = {
    latest: "1790000000",
    "bundle-1790000000.json.xz": fixture("ec2-bundle.json.xz"),
    "rds-latest": "1791000000",
    "rds-bundle-1791000000.json.xz": fixture("rds-bundle.json.xz"),
  };
  await syncAwsBulkPricing(
    {
      async text(key) {
        const value = objects[key];
        return typeof value === "string" ? value : null;
      },
      stream(key) {
        const value = objects[key] as Uint8Array<ArrayBuffer>;
        return new Blob([value]).stream();
      },
    },
    {
      async getJson() {
        return null;
      },
      async putMany(pairs: KvPair[]) {
        for (const { key, value } of pairs) stored.set(key, Uint8Array.from(value));
      },
      async deleteMany() {},
    },
    () => {},
  );
});

/** The Worker's binding: only `get(key, "arrayBuffer")` is used. */
const binding = {
  get: vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? Uint8Array.from(value).buffer : null;
  }),
};

function call(
  path: string,
  headers: Record<string, string> = {},
  env: unknown = { AWS_BULK_PRICING: binding },
) {
  const app = new Hono();
  app.route("/api/v1/aws-bulk-pricing", awsBulkPricingRoutes);
  return app.request(
    `/api/v1/aws-bulk-pricing${path}`,
    { headers: { authorization: "Bearer iwk_live", ...headers } },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_1", organizationId: "org-1", apiKeyId: "key-1" });
});

describe("/api/v1/aws-bulk-pricing", () => {
  it("returns 401 for an unknown credential, without reading KV", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await call("/rds/db.m5.large");
    expect(res.status).toBe(401);
    expect(binding.get).not.toHaveBeenCalled();
  });

  it("lists the platforms that have synced", async () => {
    const res = await call("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: Record<string, unknown>[] };
    expect(body.platforms.map((p) => [p["platform"], p["version"], p["instances"]])).toEqual([
      ["ec2", "1790000000", 1],
      ["rds", "1791000000", 2],
    ]);
    expect(body.platforms[0]).not.toHaveProperty("snapshots");
  });

  it("describes a platform", async () => {
    const res = await call("/rds");
    expect(await res.json()).toMatchObject({
      platform: "rds",
      offer: "AmazonRDS",
      variant_keys: ["databaseEngine", "deploymentOption", "usagetype"],
      snapshots: [1790000000, 1791000000],
      instances: ["db.m5.large", 'db.t2."odd"'],
    });
  });

  it("serves one instance as JSON, compression table first", async () => {
    const res = await call("/rds/db.m5.large");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.has("content-encoding")).toBe(false);
    const text = await res.text();
    expect(text.startsWith('{"compression_table":[')).toBe(true);
    const value = JSON.parse(text) as InstanceValue;
    expect(value).toMatchObject({ platform: "rds", name: "db.m5.large", offer: "AmazonRDS" });
    expect(value.compression_table).not.toContain("Asia Pacific (Tokyo)");
  });

  it("decodes an escaped instance name", async () => {
    const res = await call(`/rds/${encodeURIComponent('db.t2."odd"')}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as InstanceValue).name).toBe('db.t2."odd"');
  });

  it("answers 304 to the ETag it gave", async () => {
    const first = await call("/ec2/m5.large");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await call("/ec2/m5.large", { "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  it.each([
    ["/lightsail", "No such platform"],
    ["/lightsail/x", "No such platform"],
    ["/sagemaker", "This platform has not been synced yet"],
    ["/rds/db.nope", "No such instance"],
  ])("404s %s", async (path, error) => {
    const res = await call(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error });
  });

  describe("on the Node gateway, which has no binding", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("answers 503 when the REST API is not configured", async () => {
      vi.stubEnv("AWS_BULK_PRICING_KV_API_TOKEN", "");
      const res = await call("/rds", {}, null);
      expect(res.status).toBe(503);
    });

    it("reads KV over the REST API when it is", async () => {
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
      vi.stubEnv("AWS_BULK_PRICING_KV_NAMESPACE_ID", "ns");
      vi.stubEnv("AWS_BULK_PRICING_KV_API_TOKEN", "token");
      const fetch = vi.fn(async (url: string) => {
        const key = decodeURIComponent(url.split("/values/")[1]!);
        const value = stored.get(key);
        return value ? new Response(value) : new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetch);

      const res = await call("/ec2/m5.large", {}, null);
      expect(res.status).toBe(200);
      expect(((await res.json()) as InstanceValue).name).toBe("m5.large");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/instance%3Aec2%3Am5.large",
        expect.anything(),
      );
    });
  });
});
