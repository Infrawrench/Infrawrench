/** Kubernetes efficiency reports (POST/PUT /k8s-efficiency-reports), as Effect schemas. */
import { Schema } from "effect";
import {
  K8S_COST_CATEGORIES,
  K8S_EFFICIENCY_BASES,
  K8S_EFFICIENCY_FILTER_DIMENSIONS,
  K8S_EFFICIENCY_GRANULARITIES,
  K8S_EFFICIENCY_GROUP_BYS,
  K8S_EFFICIENCY_LIMITS,
  K8S_IDLE_MODES,
  kubernetesEfficiencyConfigProblem,
  type KubernetesEfficiencyConfig as KubernetesEfficiencyConfigContract,
  type KubernetesEfficiencyReportInput as KubernetesEfficiencyReportInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, trimmed } from "./checks";
import type { Decodes } from "./contract";
import { CostDateRange } from "./cost-enums";
import { NonEmptyString } from "./primitives";

const L = K8S_EFFICIENCY_LIMITS;
const LabelKey = Schema.String.check(minLength(1), maxLength(300));

export const KubernetesCostCategory = Schema.Literals(K8S_COST_CATEGORIES).annotate({
  identifier: "KubernetesCostCategory",
  description:
    "What the money bought. `network` is load balancers; `compute` is CPU and memory together, " +
    "and only appears on rows collected before the two were written apart.",
});

export const KubernetesEfficiencyFilter = Schema.Struct({
  dimension: Schema.Literals(K8S_EFFICIENCY_FILTER_DIMENSIONS).annotate({
    description:
      "`account` is a Kubernetes cluster (its connected account id). `tag` covers namespace, " +
      "workload, workload_kind, node_pool, capacity_type, instance_type, zone and the " +
      "`k8s_pod_label:`, `k8s_node_label:` and `k8s_pvc_label:` labels.",
  }),
  op: Schema.Literals(["in", "not_in"]),
  values: Schema.mutable(Schema.Array(Schema.String.check(maxLength(500)))).check(
    minLength(1),
    maxLength(L.maxFilterValues),
  ),
  tagKey: Schema.optionalKey(
    LabelKey.annotate({ description: "Required when `dimension` is `tag`." }),
  ),
}).annotate({ identifier: "KubernetesEfficiencyFilter" });

/**
 * A saved report's config. The cross-field rules (a label key exactly when
 * grouping by label, the window bound) are `kubernetesEfficiencyConfigProblem`,
 * the function both editors and the CLI call.
 */
export const KubernetesEfficiencyConfig = Schema.Struct({
  version: Schema.Literal(1),
  dateRange: CostDateRange,
  granularity: Schema.Literals(K8S_EFFICIENCY_GRANULARITIES),
  filters: Schema.mutable(Schema.Array(KubernetesEfficiencyFilter)).check(maxLength(L.maxFilters)),
  groupBy: Schema.Literals(K8S_EFFICIENCY_GROUP_BYS),
  groupByLabelKey: Schema.optionalKey(
    LabelKey.annotate({
      description: "The tag key to group by; required exactly when `groupBy` is `label`.",
    }),
  ),
  categories: Schema.optionalKey(
    Schema.mutable(Schema.Array(KubernetesCostCategory))
      .check(maxLength(K8S_COST_CATEGORIES.length))
      .annotate({ description: "Cost categories to include. Absent or empty is every category." }),
  ),
  idle: Schema.Literals(K8S_IDLE_MODES).annotate({
    description:
      "`separate` keeps idle capacity and cluster overhead as their own rows; `spread` shares " +
      "them across each cluster's groups, per period, in proportion to what each was allocated.",
  }),
  basis: Schema.Literals(K8S_EFFICIENCY_BASES).annotate({
    description:
      "Efficiency denominator. `total`: used / (total - unmeasured), so idle and overhead count " +
      "against it. `allocated`: used / (used + unused), what workloads reserved only.",
  }),
})
  .check(Schema.makeFilter((config) => kubernetesEfficiencyConfigProblem(config) ?? undefined))
  .annotate({ identifier: "KubernetesEfficiencyConfig" });

export const KubernetesEfficiencyReportInput = Schema.Struct({
  name: trimmed([minLength(1), maxLength(L.maxNameLength)]),
  description: Schema.optionalKey(Schema.String.check(maxLength(L.maxDescriptionLength))),
  config: KubernetesEfficiencyConfig,
  folderId: Schema.optionalKey(
    Schema.NullOr(NonEmptyString).annotate({
      description: "A cost-report folder to file it under; null is the top level.",
    }),
  ),
}).annotate({ identifier: "KubernetesEfficiencyReportInput" });

/** `POST /k8s-efficiency-reports/query`: run an unsaved config. Documented inline. */
export const KubernetesEfficiencyQuery = Schema.Struct({ config: KubernetesEfficiencyConfig });

/**
 * One way only: the contract types `filters` as `CostFilter[]` (any cost
 * dimension and operator), wider than the three dimensions and two operators
 * this accepts. The zod twins' `Exact` checks never held either.
 */
export type KubernetesEfficiencySchemasMatchContract = [
  Decodes<typeof KubernetesEfficiencyConfig.Type, KubernetesEfficiencyConfigContract>,
  Decodes<typeof KubernetesEfficiencyReportInput.Type, KubernetesEfficiencyReportInputContract>,
];
[true, true] satisfies KubernetesEfficiencySchemasMatchContract;
