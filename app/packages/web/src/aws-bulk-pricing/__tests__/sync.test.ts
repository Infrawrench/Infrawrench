import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  CATALOG_KEY,
  instanceKey,
  platformKey,
  type Catalog,
  type InstanceValue,
  type PlatformState,
} from "../format";
import { KvRest, type KvPair } from "../kv-rest";
import { syncAwsBulkPricing, syncPlatform, type BundleBucket, type PricingKv } from "../sync";
import { RDS_BUNDLE, SPOT_BUNDLE } from "./fixtures/bundles";
import { expandBundle, expandValue } from "./fixtures/expand";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const BUCKET = {
  latest: "1790000000\n",
  "bundle-1790000000.json.xz": fixture("ec2-bundle.json.xz"),
  "rds-latest": "1791000000\n",
  "rds-bundle-1791000000.json.xz": fixture("rds-bundle.json.xz"),
};

function fakeBucket(objects: Record<string, Uint8Array | string>): BundleBucket & {
  streamed: string[];
} {
  const streamed: string[] = [];
  return {
    streamed,
    async text(key) {
      const value = objects[key];
      if (value === undefined) return null;
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    stream(key) {
      streamed.push(key);
      const value = objects[key];
      return new ReadableStream({
        start(controller) {
          if (value === undefined) return controller.error(new Error(`no ${key}`));
          // Small chunks, so decompression and parsing both cross boundaries.
          const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
          for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
          controller.close();
        },
      });
    },
  };
}

function fakeKv(): PricingKv & {
  store: Map<string, KvPair>;
  writes: string[][];
  deletes: string[][];
} {
  const store = new Map<string, KvPair>();
  const writes: string[][] = [];
  const deletes: string[][] = [];
  return {
    store,
    writes,
    deletes,
    async getJson<T>(key: string) {
      const pair = store.get(key);
      return pair ? (JSON.parse(new TextDecoder().decode(pair.value)) as T) : null;
    },
    async putMany(pairs) {
      if (pairs.length > 0) writes.push(pairs.map((p) => p.key));
      for (const pair of pairs) store.set(pair.key, pair);
    },
    async deleteMany(keys) {
      if (keys.length > 0) deletes.push(keys);
      for (const key of keys) store.delete(key);
    },
  };
}

const state = (kv: ReturnType<typeof fakeKv>, platform: string) =>
  JSON.parse(new TextDecoder().decode(kv.store.get(platformKey(platform))!.value)) as PlatformState;

const quiet = () => {};

describe("syncAwsBulkPricing", () => {
  it("writes every instance of every platform with a bundle, then what it synced", async () => {
    const kv = fakeKv();
    const results = await syncAwsBulkPricing(fakeBucket(BUCKET), kv, quiet);

    expect(results).toEqual([
      { platform: "ec2", version: "1790000000", written: 1, deleted: 0 },
      { platform: "rds", version: "1791000000", written: 2, deleted: 0 },
    ]);
    const stored = JSON.parse(
      gunzipSync(kv.store.get(instanceKey("rds", "db.m5.large"))!.value).toString(),
    ) as InstanceValue;
    expect(expandValue(stored)).toEqual(expandBundle(RDS_BUNDLE, "db.m5.large"));

    expect(state(kv, "rds")).toMatchObject({
      platform: "rds",
      offer: "AmazonRDS",
      version: "1791000000",
      bundle: "rds-bundle-1791000000.json.xz",
      snapshots: RDS_BUNDLE.snapshots,
    });
    expect(Object.keys(state(kv, "rds").instances).sort()).toEqual(["db.m5.large", 'db.t2."odd"']);
    expect(state(kv, "ec2").offer).toBe("AmazonEC2");
    // The platform's state is written after its instances, never before.
    expect(kv.writes.map((keys) => keys.at(-1))).toEqual([
      instanceKey("ec2", "m5.large"),
      platformKey("ec2"),
      instanceKey("rds", 'db.t2."odd"'),
      platformKey("rds"),
      CATALOG_KEY,
    ]);
    // Platforms with nothing in the bucket yet are skipped, not failed.
    expect(kv.store.has(platformKey("sagemaker"))).toBe(false);
  });

  it("syncs EC2 spot prices like any other platform, after EC2", async () => {
    const kv = fakeKv();
    const results = await syncAwsBulkPricing(
      fakeBucket({
        ...BUCKET,
        "spot-latest": "1792022400\n",
        "spot-bundle-1792022400.json.xz": fixture("spot-bundle.json.xz"),
      }),
      kv,
      quiet,
    );
    expect(results.map((r) => r.platform)).toEqual(["ec2", "rds", "spot"]);
    const stored = JSON.parse(
      gunzipSync(kv.store.get(instanceKey("spot", "m5.large"))!.value).toString(),
    ) as InstanceValue;
    expect(stored).toMatchObject({ platform: "spot", offer: "AmazonEC2Spot" });
    expect(expandValue(stored)).toEqual(expandBundle(SPOT_BUNDLE, "m5.large"));
    expect(state(kv, "spot")).toMatchObject({
      offer: "AmazonEC2Spot",
      variant_keys: ["operatingSystem"],
      instances: { "m5.large": expect.any(String), "t4g.nano": expect.any(String) },
    });
  });

  it("writes a catalog of every platform's instance names", async () => {
    const kv = fakeKv();
    await syncAwsBulkPricing(fakeBucket(BUCKET), kv, quiet);
    const catalog = JSON.parse(
      new TextDecoder().decode(kv.store.get(CATALOG_KEY)!.value),
    ) as Catalog;
    expect(catalog.platforms).toEqual({
      ec2: {
        version: "1790000000",
        asOf: state(kv, "ec2").snapshots.at(-1) ?? null,
        instances: ["m5.large"],
      },
      rds: {
        version: "1791000000",
        asOf: RDS_BUNDLE.snapshots.at(-1),
        instances: ["db.m5.large", 'db.t2."odd"'],
      },
    });
  });

  it("keeps a failed platform's names in the catalog", async () => {
    const kv = fakeKv();
    await syncAwsBulkPricing(fakeBucket(BUCKET), kv, quiet);
    await expect(
      syncAwsBulkPricing(fakeBucket({ ...BUCKET, latest: "1799999999" }), kv, quiet),
    ).rejects.toThrow(AggregateError);
    const catalog = JSON.parse(
      new TextDecoder().decode(kv.store.get(CATALOG_KEY)!.value),
    ) as Catalog;
    expect(catalog.platforms.ec2?.instances).toEqual(["m5.large"]);
  });

  it("reads only `latest` when nothing has moved", async () => {
    const kv = fakeKv();
    await syncAwsBulkPricing(fakeBucket(BUCKET), kv, quiet);
    kv.writes.length = 0;
    const bucket = fakeBucket(BUCKET);

    expect(await syncAwsBulkPricing(bucket, kv, quiet)).toEqual([]);
    expect(bucket.streamed).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("keeps going after one platform fails, then fails the run", async () => {
    const kv = fakeKv();
    const log = vi.fn();
    await expect(
      syncAwsBulkPricing(fakeBucket({ ...BUCKET, latest: "1799999999" }), kv, log),
    ).rejects.toThrow(AggregateError);
    expect(kv.store.has(platformKey("ec2"))).toBe(false);
    expect(kv.store.has(platformKey("rds"))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^ec2: failed/));
  });
});

describe("syncPlatform", () => {
  it("rewrites only what changed when the version moves, and drops what went", async () => {
    const kv = fakeKv();
    await syncPlatform("rds", fakeBucket(BUCKET), kv, null);
    const previous: PlatformState = {
      ...state(kv, "rds"),
      version: "1790500000",
      instances: { ...state(kv, "rds").instances, 'db.t2."odd"': "stale", "db.gone": "x" },
    };
    kv.writes.length = 0;

    expect(await syncPlatform("rds", fakeBucket(BUCKET), kv, previous)).toEqual({
      platform: "rds",
      version: "1791000000",
      written: 1,
      deleted: 1,
    });
    expect(kv.writes).toEqual([[instanceKey("rds", 'db.t2."odd"')], [platformKey("rds")]]);
    expect(kv.deletes).toEqual([[instanceKey("rds", "db.gone")]]);
  });

  it("refuses a `latest` that does not hold a version", async () => {
    const bucket = fakeBucket({ "rds-latest": "../../x" });
    await expect(syncPlatform("rds", bucket, fakeKv(), null)).rejects.toThrow(/not a version/);
  });

  it("fails on a truncated bundle rather than recording it as synced", async () => {
    const xz = BUCKET["rds-bundle-1791000000.json.xz"];
    const kv = fakeKv();
    const bucket = fakeBucket({ ...BUCKET, "rds-bundle-1791000000.json.xz": xz.slice(0, -20) });
    await expect(syncPlatform("rds", bucket, kv, null)).rejects.toThrow();
    expect(kv.store.has(platformKey("rds"))).toBe(false);
  });
});

describe("KvRest", () => {
  function api(respond: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    });
    const kv = new KvRest({
      accountId: "acct",
      namespaceId: "ns",
      apiToken: "token",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    return { kv, calls };
  }
  const ok = () => Response.json({ success: true, result: { successful_key_count: 1 } });

  it("bulk-writes base64 values with their metadata", async () => {
    const { kv, calls } = api(ok);
    await kv.putMany([{ key: "a:b", value: new Uint8Array([1, 2, 255]), metadata: { hash: "h" } }]);
    expect(calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/bulk",
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual([
      { key: "a:b", value: "AQL/", base64: true, metadata: { hash: "h" } },
    ]);
  });

  it("fails a bulk write Cloudflare only partly took", async () => {
    const { kv } = api(() =>
      Response.json({ success: true, result: { unsuccessful_keys: ["a"] } }),
    );
    await expect(kv.putMany([{ key: "a", value: new Uint8Array() }])).rejects.toThrow(/failed/);
  });

  it("reads a value, escaping the key, and answers null for a missing one", async () => {
    const { kv, calls } = api((url) =>
      url.endsWith("/values/instance%3Aec2%3Am5.large")
        ? new Response('{"x":1}')
        : Response.json({ success: false }, { status: 404 }),
    );
    expect(await kv.getJson("instance:ec2:m5.large")).toEqual({ x: 1 });
    expect(await kv.get("missing")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("throws on an error that is not a 404", async () => {
    const { kv } = api(() => new Response("nope", { status: 403 }));
    await expect(kv.get("a")).rejects.toThrow(/403/);
  });

  it("sends nothing for an empty write or delete", async () => {
    const { kv, calls } = api(ok);
    await kv.putMany([]);
    await kv.deleteMany([]);
    expect(calls).toEqual([]);
  });
});
