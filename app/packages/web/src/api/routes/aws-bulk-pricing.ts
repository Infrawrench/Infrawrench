import { Hono, type Context } from "hono";
import { authenticateApiRequest } from "@/auth/api-auth";
import { PLATFORMS, instanceKey, platformKey, type PlatformState } from "@/aws-bulk-pricing/format";
import { KvRest } from "@/aws-bulk-pricing/kv-rest";

const app = new Hono();

/**
 * GET /api/v1/aws-bulk-pricing[/<platform>[/<instance>]]: AWS bulk pricing data,
 * from Workers KV (see `aws-bulk-pricing/format.ts` for what is stored and
 * `scripts/sync-aws-bulk-pricing.ts` for how it gets there).
 *
 * - `/`: the platforms synced so far, with version, bundle, sync time and count.
 * - `/<platform>`: that, plus `variant_keys`, `snapshots` and every instance name.
 * - `/<platform>/<instance>`: everything about one instance, in the bundle
 *   encoding, starting with its own `compression_table`.
 *
 * Deliberately left out of the OpenAPI spec: the per-instance value is the
 * bulk-instances SDKs' bundle format, so they are its client, not the
 * generated SDKs. Any credential `authenticateApiRequest` accepts may read it,
 * with no scope, like `/api/v1/whoami`: it is AWS's public price list.
 */

/** The KV calls this needs, on a binding or over the REST API. */
interface PricingStore {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** The binding the web Worker has (`edge/wrangler.jsonc`); absent on Node. */
interface KvBinding {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
}

function store(c: Context): PricingStore | null {
  const binding = (c.env as { AWS_BULK_PRICING?: KvBinding } | undefined)?.AWS_BULK_PRICING;
  if (binding) {
    return {
      get: async (key) => {
        const value = await binding.get(key, "arrayBuffer");
        return value ? new Uint8Array(value) : null;
      },
    };
  }
  // The Node gateway has no binding. It reaches KV over the REST API when
  // configured, and otherwise answers 503: almost every request is served on
  // the edge, so this is for direct gateway traffic and local development.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = process.env.AWS_BULK_PRICING_KV_NAMESPACE_ID;
  const apiToken = process.env.AWS_BULK_PRICING_KV_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) return null;
  return new KvRest({ accountId, namespaceId, apiToken });
}

async function readJson<T>(kv: PricingStore, key: string): Promise<T | null> {
  const bytes = await kv.get(key);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null;
}

app.use("*", async (c, next) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.get("/", async (c) => {
  const kv = store(c);
  if (!kv) return unavailable(c);
  const states = await Promise.all(
    Object.keys(PLATFORMS).map((platform) => readJson<PlatformState>(kv, platformKey(platform))),
  );
  const platforms = states.flatMap((state) => {
    if (!state) return [];
    const { instances, snapshots: _snapshots, ...rest } = state;
    return [{ ...rest, instances: Object.keys(instances).length }];
  });
  return c.json({ platforms }, 200, { "cache-control": "private, max-age=60" });
});

app.get("/:platform", async (c) => {
  const platform = c.req.param("platform");
  if (!(platform in PLATFORMS)) return c.json({ error: "No such platform" }, 404);
  const kv = store(c);
  if (!kv) return unavailable(c);
  const state = await readJson<PlatformState>(kv, platformKey(platform));
  if (!state) return c.json({ error: "This platform has not been synced yet" }, 404);
  return c.json({ ...state, instances: Object.keys(state.instances).sort() }, 200, {
    "cache-control": "private, max-age=60",
  });
});

// Everything after the platform is the name, in case one ever has a slash.
app.get("/:platform/:name{.+}", async (c) => {
  const platform = c.req.param("platform");
  if (!(platform in PLATFORMS)) return c.json({ error: "No such platform" }, 404);
  const kv = store(c);
  if (!kv) return unavailable(c);
  const stored = await kv.get(instanceKey(platform, c.req.param("name")));
  if (!stored) return c.json({ error: "No such instance" }, 404);

  const digest = await crypto.subtle.digest("SHA-256", stored);
  const etag = `"${Buffer.from(digest).toString("hex")}"`;
  const headers = {
    "content-type": "application/json",
    "cache-control": "private, no-cache",
    etag,
  };
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
  // Stored gzipped. Decompressed here rather than passed through with
  // `Content-Encoding`, which the Worker would otherwise encode a second time;
  // Cloudflare compresses the response again for clients that accept it.
  const json = new Blob([stored]).stream().pipeThrough(new DecompressionStream("gzip"));
  return c.body(json, 200, headers);
});

function unavailable(c: Context) {
  return c.json({ error: "AWS bulk pricing data is not available here" }, 503);
}

export { app as awsBulkPricingRoutes };
