/**
 * Names for the slices of Elastic Cloud API responses this plugin reads, from
 * Elastic's published OpenAPI documents through `plugingen.json`:
 * https://www.elastic.co/docs/api/doc/cloud.json (Cloud API),
 * https://www.elastic.co/docs/api/doc/elastic-cloud-serverless.json
 * (Serverless) and https://www.elastic.co/docs/api/doc/cloud-billing.json
 * (Billing).
 */
import type { ApiListItem } from "@infrawrench/plugin-base";
import type { BillingResponse, CloudResponse, ServerlessResponse } from "./api.js";
import type {
  components as CloudComponents,
  operations as CloudOps,
} from "./api-types.cloud.gen.js";
import type { operations as ServerlessOps } from "./api-types.serverless.gen.js";

export { PROJECT_TYPES, type ProjectType } from "./api.js";

/**
 * Every field optional, all the way down, for what a mapper reads: a missing one
 * must degrade to a blank cell rather than a crash, whatever the document says is
 * required, and a deployment that cannot be read in full is built from its listing.
 */
type Loose<T> = T extends readonly (infer Item)[]
  ? Loose<Item>[]
  : T extends object
    ? { [K in keyof T]?: Loose<T[K]> }
    : T;

export type EcOrganization = ApiListItem<CloudOps["list-organizations"], "organizations">;
export type EcTopologyElement = Loose<
  CloudComponents["schemas"]["ElasticsearchClusterTopologyElement"]
>;
export type EcDeployment = Loose<CloudResponse<"get-deployment">>;
export type EcDeploymentListing = ApiListItem<CloudOps["list-deployments"], "deployments">;
export type EcTiers = CloudResponse<"get-deployment-es-resource-tiers">;
export type EcTrafficRule = CloudComponents["schemas"]["TrafficFilterRule"];
export type EcTrafficRuleset = CloudResponse<"get-traffic-filter-ruleset">;
export type EcExtension = CloudResponse<"get-extension">;

type ProjectResponse = ServerlessResponse<
  | "getElasticsearchProject"
  | "getObservabilityProject"
  | "getSecurityProject"
  | "getVectorDBProject"
>;

/** One project of any type. The mapper reads each of these from whichever types have it. */
export type EcProject = Loose<ProjectResponse> & {
  optimized_for?: string;
  product_tier?: string;
  product_types?: Array<{ product_line?: string; product_tier?: string }>;
  search_lake?: { search_power?: number; boost_window?: number };
  endpoints?: { elasticsearch?: string; kibana?: string; apm?: string; ingest?: string };
};

export type EcServerlessRegion = ApiListItem<ServerlessOps["listRegions"], null>;
export type EcServerlessTrafficFilter = ServerlessResponse<"getTrafficFilter">;

/** v1 costs overview (`GET /api/v1/billing/costs/{organization_id}`). */
export type EcCostsOverview = CloudResponse<"get-costs-overview">;

/** v2 `GET .../costs/instances`: one entry per deployment, project or service. */
export type EcInstanceCosts = Loose<BillingResponse<"getCostsByInstancesV2">>;

export type EcChartItems = Loose<BillingResponse<"getChartsV2" | "getChartsByInstanceV2">>;

export type EcBudget = BillingResponse<"getBudgetV1">;
