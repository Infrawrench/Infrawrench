/**
 * The shapes the plugin reads. Those of the Hub and Inference Endpoints come from
 * their documents (`plugingen.json`); `Loose` keeps every field optional, because
 * the Hub omits keys freely and a missing one must never crash a listing. The
 * router and the Inference Catalog are in neither document, so theirs are written
 * out here.
 */
import type { ApiResponse } from "@infrawrench/plugin-base";
import type { components } from "./api-types.endpoints.gen.js";
import type { paths as HubPaths } from "./api-types.hub.gen.js";

/** A response as a mapper may meet it: the same fields, none of them promised. */
export type Loose<T> = T extends readonly (infer Item)[]
  ? Loose<Item>[]
  : T extends object
    ? { [K in keyof T]?: Loose<T[K]> }
    : T;

type HubGet<Path extends keyof HubPaths> = HubPaths[Path] extends { get: infer Op }
  ? ApiResponse<Op>
  : never;
type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export type WhoAmI = Loose<HubGet<"/api/whoami-v2">>;

// ------------------------------------------------------- Inference Endpoints

export type Endpoint = Loose<Schema<"EndpointWithStatus">>;
export type ExactCompute = Schema<"Compute">;
export type Compute = Loose<ExactCompute>;
export type ExactVendors = Schema<"Vendors">;
export type Vendors = Loose<ExactVendors>;
export type VendorQuotas = Schema<"VendorQuotas">;
export type DataPoint = Loose<Schema<"DataPoint">>;
export type HardwareSeries = Loose<Schema<"SeriesHardware">>;
export type AllGraphs = Loose<Schema<"AllGraphs">>;
export type Replicas = Schema<"Replicas">;

// -------------------------------------------------------------------- Hub

export type RepoInfo = HubGet<"/api/models/{namespace}/{repo}">;
export type HardwareFlavor = Loose<HubGet<"/api/spaces/hardware">[number]>;
/** Both a secret and a variable: a secret just never comes back with its value. */
export type SpaceKeyEntry = Loose<HubGet<"/api/spaces/{namespace}/{repo}/variables">[string]>;
export type Job = Loose<HubGet<"/api/jobs/{namespace}/{jobId}">>;
export type ScheduledJob = Loose<HubGet<"/api/scheduled-jobs/{namespace}/{jobId}">>;
export type ServiceAccount = Loose<
  HubGet<"/api/organizations/{name}/service-accounts/{serviceAccountId}">
>;
export type MemberToken = Loose<HubGet<"/api/organizations/{name}/settings/tokens">[number]>;
export type Webhook = Loose<HubGet<"/api/settings/webhooks">[number]>;
export type InferenceUsagePeriod = Loose<
  HubGet<"/api/organizations/{name}/billing/usage/inference">[number]
>;
export type JobsUsage = Loose<HubGet<"/api/settings/billing/usage/jobs">>;

// --------------------------------------------------------------- Not in a document

export interface CatalogList {
  items?: Array<{
    modelName?: string;
    repoId?: string;
    authorName?: string;
    task?: string;
    license?: string;
    recipes?: Array<{ publicId?: string; accelerator?: string; engineType?: string }>;
  }>;
}

export interface RouterModels {
  data?: RouterModel[];
}

export interface RouterModel {
  id?: string;
  created?: number;
  owned_by?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  providers?: Array<{
    provider?: string;
    status?: string;
    context_length?: number;
    pricing?: { input?: number; output?: number };
    supports_tools?: boolean;
    supports_structured_output?: boolean;
    first_token_latency_ms?: number;
    throughput?: number;
  }>;
}
