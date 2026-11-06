// Compile-time only and imported by nothing: a build error here means a validator
// and the contract type it mirrors have drifted apart. Unknown keys are stripped
// on decode, so a key missing from a validator otherwise disappears silently.
import type {
  DashboardCardSchema,
  DetailViewSchema,
  MetricSeries,
  PeerPaneSchema,
  QueryCostEstimate,
  SchemaNode,
} from "../schema.js";
import type { CreateFieldConfig } from "../create.js";
import type { PluginManifest } from "../manifest.js";
import type { ExpiryFieldRule, FieldDefinition, ResourceTypeDefinition } from "../resource.js";
import type { TerraformExportCapability } from "../terraform.js";
import type { createFieldConfigSchema } from "./create.schema.js";
import type { pluginManifestSchema } from "./manifest.schema.js";
import type { fieldDefinitionSchema, resourceTypeDefinitionSchema } from "./resource.schema.js";
import type {
  dashboardCardSchema,
  detailViewSchema,
  metricSeriesSchema,
  peerPaneSchema,
  queryCostEstimateSchema,
  schemaNodeSchema,
} from "./schema.schema.js";
import type { terraformExportCapabilitySchema } from "./terraform.schema.js";

// `readonly`, and `| undefined` on an optional key, are decode-side details: the
// schemas accept what `.optional()` always accepted.
type Plain<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer E>
    ? Plain<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: Plain<Exclude<T[K], undefined>> }
      : T;

type Exact<A, B> =
  (<G>() => G extends Plain<A> ? 1 : 2) extends <G>() => G extends Plain<B> ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

// The validator narrows `kind` on purpose: see `expiryFieldRuleSchema`.
type DeclarableExpiryRule = Omit<ExpiryFieldRule, "kind"> & {
  kind: Exclude<ExpiryFieldRule["kind"], "lease" | "extended-support">;
};
type DeclarableResourceType = Omit<ResourceTypeDefinition, "expiryFields"> & {
  expiryFields?: DeclarableExpiryRule[];
};

export type ContractChecks = [
  Expect<Exact<typeof pluginManifestSchema.Type, PluginManifest>>,
  Expect<Exact<typeof resourceTypeDefinitionSchema.Type, DeclarableResourceType>>,
  Expect<Exact<typeof fieldDefinitionSchema.Type, FieldDefinition>>,
  Expect<Exact<typeof schemaNodeSchema.Type, SchemaNode>>,
  Expect<Exact<typeof dashboardCardSchema.Type, DashboardCardSchema>>,
  Expect<Exact<typeof detailViewSchema.Type, DetailViewSchema>>,
  Expect<Exact<typeof peerPaneSchema.Type, PeerPaneSchema>>,
  Expect<Exact<typeof metricSeriesSchema.Type, MetricSeries>>,
  Expect<Exact<typeof queryCostEstimateSchema.Type, QueryCostEstimate>>,
  Expect<Exact<typeof createFieldConfigSchema.Type, CreateFieldConfig>>,
  Expect<Exact<typeof terraformExportCapabilitySchema.Type, TerraformExportCapability>>,
];
