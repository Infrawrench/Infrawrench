/**
 * `/api/v1/aws-bulk-pricing[/<platform>[/<instance>]]`, the endpoint
 * definitions: bulk instance pricing data for every platform the
 * instances-bundler publishes (the AWS platforms, `runpod`, `alibaba`,
 * `azure`, `gcp`, `hetzner`, `hetznerauction`, `ovh`, `ovheco`, `oracle` and
 * `ibm`; the path predates the other clouds), from Workers KV.
 *
 * Deliberately left out of the OpenAPI document: the per-instance value is
 * the bulk-instances SDKs' bundle format, so they are its client, not the
 * generated SDKs. The group is `OpenApi.Exclude` and sends what it always
 * sent. Any credential `authenticateApiRequest` accepts may read it,
 * with no scope, like `/api/v1/whoami`: it is the providers' public price
 * lists. The handlers authenticate (`http/bearer-caller.ts`), and the rest of
 * the prefix is guarded the same way (`http/prefix-guard.ts`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { withApiDefaults } from "../http/api-defaults";

/** The mount; also the prefix every other method and path under it is guarded on. */
export const AWS_BULK_PRICING_PREFIX = "/api/v1/aws-bulk-pricing";

const Platform = { platform: Schema.String } as const;

export class AwsBulkPricingGroup extends HttpApiGroup.make("awsBulkPricing")
  .add(HttpApiEndpoint.get("platforms", "/", { success: Schema.Unknown }))
  // `/<platform>` and `/<platform>/<instance>` in one route: a wildcard also
  // claims the path before it. Everything after the platform is the name, in
  // case one ever has a slash.
  .add(
    HttpApiEndpoint.get("platform", "/:platform/*", { params: Platform, success: Schema.Unknown }),
  )
  .prefix(AWS_BULK_PRICING_PREFIX)
  .annotate(OpenApi.Exclude, true) {}

export class AwsBulkPricingApi extends withApiDefaults(
  HttpApi.make("awsBulkPricing").add(AwsBulkPricingGroup),
) {}
