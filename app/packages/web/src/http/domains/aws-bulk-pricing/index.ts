/**
 * `/api/v1/aws-bulk-pricing`, the handlers (see `aws-bulk-pricing/format.ts`
 * for what is stored and `scripts/sync-aws-bulk-pricing.ts` for how it gets
 * there).
 *
 * - `/`: the platforms synced so far, with version, bundle, sync time and count.
 * - `/<platform>`: that, plus `variant_keys`, `snapshots` and every instance name.
 * - `/<platform>/<instance>`: everything about one instance, in the bundle
 *   encoding, starting with its own `compression_table`.
 *
 * On the edge the data is the Worker's `AWS_BULK_PRICING` KV binding, read
 * from the `Invocation` service. The Node gateway has no binding and reaches
 * KV over the REST API when configured, and otherwise answers 503.
 */
import { Effect, Option, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  PLATFORMS,
  instanceKey,
  platformKey,
  type PlatformState,
} from "../../../aws-bulk-pricing/format";
import { KvRest } from "../../../aws-bulk-pricing/kv-rest";
import { asBearerCaller, bearerPrefixGuard } from "../../bearer-caller";
import { rawRequest } from "../../caller-auth";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { json } from "../../middleware";
import { guardPrefixes } from "../../prefix-guard";
import { respond } from "../../response";
import { Invocation } from "../../server";
import { AWS_BULK_PRICING_PREFIX, AwsBulkPricingApi } from "./api";

/** The KV calls this needs, on a binding or over the REST API. */
interface PricingStore {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** The Worker's `AWS_BULK_PRICING` binding (`edge/wrangler.jsonc`), when `env` carries one. */
function bindingStore(env: unknown): PricingStore | null {
  if (!Predicate.hasProperty(env, "AWS_BULK_PRICING")) return null;
  const binding = env.AWS_BULK_PRICING;
  if (!Predicate.hasProperty(binding, "get") || !Predicate.isFunction(binding.get)) return null;
  const get = binding.get;
  return {
    get: async (key) => {
      const value: unknown = await get.call(binding, key, "arrayBuffer");
      return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
    },
  };
}

/** Where this invocation reads pricing from, or null when it has nowhere to. */
const pricingStore = Effect.gen(function* () {
  const invocation = yield* Effect.serviceOption(Invocation);
  const binding = bindingStore(Option.getOrUndefined(invocation)?.env);
  if (binding) return binding;
  // Almost every request is served on the edge, so this is for direct gateway
  // traffic and local development.
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const namespaceId = process.env["AWS_BULK_PRICING_KV_NAMESPACE_ID"];
  const apiToken = process.env["AWS_BULK_PRICING_KV_API_TOKEN"];
  if (!accountId || !namespaceId || !apiToken) return null;
  const rest: PricingStore = new KvRest({ accountId, namespaceId, apiToken });
  return rest;
});

/** A stored platform state: written by our own sync, so its `instances` map is the check. */
const isPlatformState = (value: unknown): value is PlatformState =>
  Predicate.hasProperty(value, "instances") && Predicate.isObject(value.instances);

async function readState(kv: PricingStore, platform: string): Promise<PlatformState | null> {
  const bytes = await kv.get(platformKey(platform));
  if (!bytes) return null;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return isPlatformState(parsed) ? parsed : null;
}

const unavailable = () => json({ error: "Bulk pricing data is not available here" }, 503);
const notFound = (error: string) => json({ error }, 404);

const withCacheControl = (value: string) => (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeader(response, "cache-control", value);

/** `/<platform>`: its state, with every instance name rather than their hashes. */
const platform = Effect.fnUntraced(function* (platform: string) {
  if (!(platform in PLATFORMS)) return notFound("No such platform");
  const kv = yield* pricingStore;
  if (!kv) return unavailable();
  const state = yield* legacy(() => readState(kv, platform));
  if (!state) return notFound("This platform has not been synced yet");
  const response = yield* respond(Schema.Unknown)({
    ...state,
    instances: Object.keys(state.instances).sort(),
  });
  return withCacheControl("private, max-age=60")(response);
});

/** `/<platform>/<instance>`: the stored value, decompressed, with an ETag. */
const instance = Effect.fnUntraced(function* (platform: string, name: string) {
  if (!(platform in PLATFORMS)) return notFound("No such platform");
  const kv = yield* pricingStore;
  if (!kv) return unavailable();
  const stored = yield* legacy(() => kv.get(instanceKey(platform, name)));
  if (!stored) return notFound("No such instance");

  const digest = yield* legacy(() => crypto.subtle.digest("SHA-256", stored));
  const etag = `"${Buffer.from(digest).toString("hex")}"`;
  const headers = {
    "content-type": "application/json",
    "cache-control": "private, no-cache",
    etag,
  };
  const raw = yield* rawRequest;
  if (raw.headers.get("if-none-match") === etag) {
    return HttpServerResponse.fromWeb(new Response(null, { status: 304, headers }));
  }
  // Stored gzipped. Decompressed here rather than passed through with
  // `Content-Encoding`, which the Worker would otherwise encode a second
  // time; Cloudflare compresses the response again for clients that accept it.
  const body = new Blob([stored]).stream().pipeThrough(new DecompressionStream("gzip"));
  return HttpServerResponse.fromWeb(new Response(body, { status: 200, headers }));
});

const AwsBulkPricingHandlers = HttpApiBuilder.group(
  AwsBulkPricingApi,
  "awsBulkPricing",
  (handlers) =>
    handlers
      .handleRaw("platforms", () =>
        asBearerCaller(() =>
          Effect.gen(function* () {
            const kv = yield* pricingStore;
            if (!kv) return unavailable();
            const states = yield* legacy(() =>
              Promise.all(Object.keys(PLATFORMS).map((p) => readState(kv, p))),
            );
            const platforms = states.flatMap((state) => {
              if (!state) return [];
              const { instances, snapshots: _snapshots, ...rest } = state;
              return [{ ...rest, instances: Object.keys(instances).length }];
            });
            const response = yield* respond(Schema.Unknown)({ platforms });
            return withCacheControl("private, max-age=60")(response);
          }),
        ),
      )
      .handleRaw("platform", ({ params }) =>
        asBearerCaller(() =>
          Effect.gen(function* () {
            const route = yield* HttpRouter.RouteContext;
            const name = route.params["*"];
            return yield* name ? instance(params.platform, name) : platform(params.platform);
          }),
        ),
      ),
);

/**
 * GET routes everything under the mount; every other method there
 * authenticates first, as the Hono router's `use("*")` did: a 401 without a
 * credential, the 404 with one.
 */
export const awsBulkPricingDomain = guardPrefixes(
  makeDomain("awsBulkPricing", AwsBulkPricingApi, AwsBulkPricingHandlers),
  [AWS_BULK_PRICING_PREFIX],
  bearerPrefixGuard,
  ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
);
