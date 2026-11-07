import type { components } from "./api-types.gen.js";

/**
 * Payload shapes of the Baseten management API, named from its published OpenAPI
 * document (`https://api.baseten.co/v1/spec`; see `plugingen.json`).
 *
 * Money arrives as `number | string` (the spec's decimal pattern), so every
 * amount goes through `money()` in `mappers.ts` rather than `Number()`.
 */

type Schemas = components["schemas"];

/** `T` where only `Known` is certain to be there. */
type Some<T, Known extends keyof T> = Pick<T, Known> & Partial<Omit<T, Known>>;

export type Decimal = Schemas["DedicatedItemV1"]["subtotal"];

export type BasetenTeam = Schemas["TeamV1"];
export type BasetenInstanceType = Schemas["InstanceTypeV1"];
export type BasetenInstanceTypePrice = Schemas["InstanceTypeWithPriceV1"];
export type BasetenModel = Schemas["ModelV1"];
/** A model as a deployment or environment names it, which may be no more than its id. */
export type BasetenModelRef = Some<Pick<BasetenModel, "id" | "name">, "id">;
export type BasetenAutoscaling = Schemas["AutoscalingSettingsV1"];
export type BasetenDeployment = Schemas["DeploymentV1"];
export type BasetenEnvironment = Schemas["EnvironmentV1"];
/** What a mapper needs of an environment: creating one can answer with no body. */
export type BasetenEnvironmentLike = Some<BasetenEnvironment, "name">;
export type BasetenChain = Schemas["ChainV1"];
export type BasetenSecret = Schemas["SecretV1"];
/** What a mapper needs of a secret: writing one can answer with no body. */
export type BasetenSecretLike = Some<BasetenSecret, "name">;
export type BasetenTrainingJob = Schemas["TrainingJobV1"];
export type BasetenTrainingProject = Schemas["TrainingProjectV1"];
export type BasetenModelApi = Schemas["ModelAPIV1"];
export type BasetenTrainingCapacity = Schemas["GetTrainingGpuCapacityResponseV1"];
export type UpdateEnvironmentBody = Schemas["UpdateEnvironmentRequestV1"];
export type LogLine = Partial<Schemas["LogV1"]>;
export type LogLevel = Schemas["LogLevelV1"];

// ── Billing ─────────────────────────────────────────────────────────────

/** A kind the document does not list yet still bills, so `kind` is open here. */
export type BillableResource = Omit<Schemas["BillableResourceV1"], "kind"> & { kind: string };

type UsageBlock<Block, Item> = Partial<Omit<Block, "breakdown">> & {
  breakdown?: Item[] | null;
};

type DedicatedItem = Some<
  Omit<Schemas["DedicatedItemV1"], "billable_resource" | "daily">,
  "subtotal"
> & {
  billable_resource: BillableResource;
  daily?: Some<Schemas["DailyDedicatedUsageV1"], "date" | "subtotal">[];
};

type TrainingItem = Some<
  Omit<Schemas["TrainingItemV1"], "billable_resource" | "daily">,
  "subtotal"
> & {
  billable_resource: BillableResource;
  daily?: Some<Schemas["DailyTrainingUsageV1"], "date" | "subtotal">[];
};

type ModelApiItem = Some<Omit<Schemas["ModelApiItemV1"], "daily">, "model_name" | "subtotal"> & {
  daily?: Some<Schemas["DailyModelApiUsageV1"], "date" | "subtotal">[];
};

/**
 * A usage summary as the cost conversion reads it. An item's own totals can stand
 * in for its daily rows, so a day holds only what both have.
 */
export interface UsageSummary {
  dedicated_usage?: UsageBlock<Schemas["DedicatedUsageV1"], DedicatedItem> | null;
  training_usage?: UsageBlock<Schemas["TrainingUsageV1"], TrainingItem> | null;
  model_apis_usage?: UsageBlock<Schemas["ModelApisUsageV1"], ModelApiItem> | null;
}

// ── Metrics ─────────────────────────────────────────────────────────────

/** A unit the document does not list yet just gets no label, so `unit_hint` is open here. */
export type MetricDescriptor = Pick<Schemas["MetricDescriptorV1"], "name" | "label_sets"> & {
  unit_hint?: string;
};

/** A metrics response as the parser reads it. */
export interface MetricsResponse {
  metric_descriptors: MetricDescriptor[];
  metric_values: Schemas["GetMetricsResponseV1"]["metric_values"];
}

export type ModelApiUsageResponse = Schemas["ModelApisUsageResponseV1"];
export type TrainingMetricPoint = Schemas["TrainingJobMetricV1"];
