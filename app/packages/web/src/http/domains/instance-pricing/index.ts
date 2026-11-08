/**
 * `/api/v1/instance-pricing` and its alias `/api/v1/aws-pricing`, the
 * handlers: read-only SQL over the instance pricing warehouse, the ClickHouse
 * database behind instances.infrawrench.com's chat (tables in
 * `server-core/src/aws-pricing-warehouse/schema.ts`, loaded by the bulk
 * pricing sync).
 *
 * Any credential `authenticateApiRequest` accepts may call it, with no scope,
 * like `/api/v1/whoami` and `/api/v1/aws-bulk-pricing`: it is the providers'
 * public price lists. The warehouse token is read-only, which is the real
 * boundary.
 *
 * `POST /api/v1/instance-pricing/query`, and no other route (not even its
 * `aws-pricing` alias), also accepts the key the web and desktop apps ship
 * with (`client-core/src/instance-pricing-key.ts`), so the resource page's
 * pricing panel works with no account: the desktop app runs signed out, and
 * the web SPA's session is a cookie this API does not read here.
 *
 * The MCP and chat tools (`tools/instance-pricing.ts`) call the same helpers.
 */
import { Effect, Predicate } from "effect";
import { HttpServerResponse, type HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { INSTANCE_PRICING_KEY } from "@infrawrench/client-core";
import {
  AWS_PRICING_PREFIX,
  AwsPricingQueryResult,
  AwsPricingSchema,
  INSTANCE_PRICING_PREFIX,
  InstancePricingApi,
} from "@infrawrench/api-contract";
import {
  InstancePricingNotConfiguredError,
  classifyInstancePricingError,
  getInstancePricingSchema,
  instancePricingWarehouse,
  parseInstancePricingQuery,
  runInstancePricingQuery,
} from "../../../services/instance-pricing";
import { asBearerCaller, bearerPrefixGuard } from "../../bearer-caller";
import { rawRequest } from "../../caller-auth";
import { makeDomain } from "../../domain";
import { readJsonOr } from "../../request-body";
import { legacy, legacyTry } from "../../legacy";
import { json } from "../../middleware";
import { guardPrefixes } from "../../prefix-guard";
import { respond } from "../../response";

const unavailable = () =>
  json({ error: "The instance pricing warehouse is not configured on this deployment" }, 503);

const withCacheControl = (value: string) => (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeader(response, "cache-control", value);

const describeSchema = Effect.gen(function* () {
  const schema = yield* legacy(() => getInstancePricingSchema());
  const response = yield* respond(AwsPricingSchema)(schema);
  return withCacheControl("private, max-age=300")(response);
});

/** The warehouse refused, failed or timed out; anything else unexpected stays a defect. */
type QueryOutcome =
  | { readonly ok: true; readonly result: typeof AwsPricingQueryResult.Type }
  | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse };

const runQuery = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (!instancePricingWarehouse()) return unavailable();
    const body = yield* readJsonOr(request, null);
    const parsed = parseInstancePricingQuery(Predicate.isObject(body) ? body : null);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const outcome = yield* legacyTry(
      async (): Promise<QueryOutcome> => ({
        ok: true,
        result: await runInstancePricingQuery(parsed.sql, parsed.maxRows),
      }),
      (error): QueryOutcome => {
        if (error instanceof InstancePricingNotConfiguredError) {
          return { ok: false, response: unavailable() };
        }
        const failure = classifyInstancePricingError(error);
        return { ok: false, response: json({ error: failure.error }, failure.status) };
      },
    ).pipe(Effect.catch((refused) => Effect.succeed(refused)));
    if (!outcome.ok) return outcome.response;
    const response = yield* respond(AwsPricingQueryResult)(outcome.result);
    return withCacheControl("private, no-store")(response);
  });

/** The apps' built-in key, exactly; on the canonical query path only. */
const carriesQueryKey = Effect.map(
  rawRequest,
  (raw) => raw.headers.get("authorization") === `Bearer ${INSTANCE_PRICING_KEY}`,
);

const InstancePricingHandlers = HttpApiBuilder.group(
  InstancePricingApi,
  "instancePricing",
  (handlers) =>
    handlers
      .handleRaw("schema", () => asBearerCaller(() => describeSchema))
      .handleRaw("query", ({ request }) =>
        Effect.gen(function* () {
          if (yield* carriesQueryKey) return yield* runQuery(request);
          return yield* asBearerCaller(() => runQuery(request));
        }),
      )
      .handleRaw("aliasSchema", () => asBearerCaller(() => describeSchema))
      .handleRaw("aliasQuery", ({ request }) => asBearerCaller(() => runQuery(request))),
);

/**
 * Every other method and path under both mounts authenticates first, as the
 * Hono router's `use("*")` did: a 401 without a credential (the apps' key
 * opens nothing there), the 404 with one.
 */
export const instancePricingDomain = guardPrefixes(
  makeDomain("instancePricing", InstancePricingApi, InstancePricingHandlers),
  [INSTANCE_PRICING_PREFIX, AWS_PRICING_PREFIX],
  bearerPrefixGuard,
);
