/**
 * Kubernetes efficiency reports: `/api/org/:orgId/k8s-efficiency-reports`,
 * the endpoint definitions.
 *
 * CRUD, `POST /query` (an unsaved config, for the editor's preview),
 * `POST /:id/run`, `GET /:id/export` (CSV or NDJSON, optionally per period)
 * and the pickers' options. Reads are `costs:read` and writes `costs:write`,
 * the cost report rules: a report is cost data under a name. Request bodies
 * are the shared schemas the editor validates with (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  K8S_EFFICIENCY_BASES,
  K8S_EFFICIENCY_GRANULARITIES,
  K8S_EFFICIENCY_GROUP_BYS,
  K8S_IDLE_MODES,
} from "@infrawrench/client-core";
import {
  KubernetesCostCategory,
  KubernetesEfficiencyConfig,
  KubernetesEfficiencyQuery,
  KubernetesEfficiencyReportInput,
  minLength,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, requiredQuery } from "../../schemas/documented";

export const KubernetesEfficiencyReport = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  config: KubernetesEfficiencyConfig,
  folderId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "KubernetesEfficiencyReport" });

const amountFields = {
  total: Schema.Finite,
  used: Schema.Finite.annotate({
    description: "Capacity measurably used (and mounted volumes, load balancers).",
  }),
  unused: Schema.Finite.annotate({ description: "Requested but measured unused." }),
  unmeasured: Schema.Finite.annotate({ description: "Allocated with no usage data." }),
  idle: Schema.Finite.annotate({
    description: "Capacity nobody requested, unrequested GPUs, unattached volumes.",
  }),
  overhead: Schema.Finite.annotate({
    description: "System-reserved node capacity and the control-plane fee.",
  }),
  allocated: Schema.Finite.annotate({ description: "used + unused + unmeasured." }),
  efficiency: Schema.NullOr(Schema.Finite).annotate({
    description: "0..1 on the report's basis; null when unmeasured.",
  }),
  measuredShare: Schema.NullOr(Schema.Finite),
};

const KubernetesEfficiencyFigures = Schema.Struct(amountFields).annotate({
  identifier: "KubernetesEfficiencyFigures",
});

const CategoryFigures = Schema.Struct({
  category: KubernetesCostCategory,
  figures: KubernetesEfficiencyFigures,
});

const Point = Schema.Struct({ bucket: Schema.String, ...amountFields });

const KubernetesEfficiencyRow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["group", "idle", "overhead", "unattributed"]),
  label: Schema.String,
  figures: KubernetesEfficiencyFigures,
  categories: Schema.Array(CategoryFigures),
  points: Schema.Array(Point),
}).annotate({ identifier: "KubernetesEfficiencyRow" });

export const KubernetesEfficiencyResult = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  granularity: Schema.Literals(K8S_EFFICIENCY_GRANULARITIES),
  groupBy: Schema.Literals(K8S_EFFICIENCY_GROUP_BYS),
  groupByLabelKey: Schema.optionalKey(Schema.String),
  idle: Schema.Literals(K8S_IDLE_MODES),
  basis: Schema.Literals(K8S_EFFICIENCY_BASES),
  buckets: Schema.Array(Schema.String),
  currencies: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      totals: KubernetesEfficiencyFigures,
      categories: Schema.Array(CategoryFigures),
      points: Schema.Array(Point),
      rows: Schema.Array(KubernetesEfficiencyRow),
    }),
  ),
  includesLegacyRows: Schema.Boolean.annotate({
    description:
      "Some rows predate the resource and usage tags (reported as `compute`, unmeasured).",
  }),
}).annotate({ identifier: "KubernetesEfficiencyResult" });

export const KubernetesEfficiencyRunResult = Schema.Struct({
  reportId: Uuid,
  name: Schema.String,
  result: KubernetesEfficiencyResult,
}).annotate({ identifier: "KubernetesEfficiencyRunResult" });

const LabelGroup = Schema.Literals([
  "tag",
  "k8s",
  "k8s_pod_label",
  "k8s_node_label",
  "k8s_pvc_label",
]);

export const KubernetesEfficiencyOptions = Schema.Struct({
  clusters: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  regions: Schema.Array(Schema.String),
  namespaces: Schema.Array(Schema.String),
  nodePools: Schema.Array(Schema.String),
  labelKeys: Schema.Array(
    Schema.Struct({
      group: LabelGroup,
      keys: Schema.Array(
        Schema.Struct({ key: Schema.String, group: LabelGroup, name: Schema.String }),
      ),
    }),
  ),
}).annotate({ identifier: "KubernetesEfficiencyOptions" });

export const KubernetesEfficiencyValues = Schema.Struct({ values: Schema.Array(Schema.String) });

export class KubernetesEfficiencyReportsGroup extends HttpApiGroup.make("k8sEfficiencyReports")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(KubernetesEfficiencyReport),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List Kubernetes efficiency reports")
      .annotate(
        OpenApi.Description,
        "The reports the caller's sharing lets them open, alphabetically.",
      )
      .annotate(SuccessDescription, "Reports"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: KubernetesEfficiencyReportInput,
      success: KubernetesEfficiencyReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid efficiency report")
      .annotate(OpenApi.Summary, "Create a Kubernetes efficiency report")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("options", "/options", {
      params: OrgParams,
      success: KubernetesEfficiencyOptions,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Picker options for Kubernetes efficiency reports")
      .annotate(
        OpenApi.Description,
        "Clusters, regions, namespaces, node pools and label keys present on the org's " +
          "Kubernetes cost rows, narrowed to the caller's cost visibility scope.",
      )
      .annotate(SuccessDescription, "Options"),
    HttpApiEndpoint.get("values", "/values", {
      params: OrgParams,
      // Read raw: a missing or blank key reaches the handler's own 400.
      query: { tagKey: Schema.optionalKey(documentedAs(Schema.String.check(minLength(1)))) },
      success: KubernetesEfficiencyValues,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Values of one label on Kubernetes cost rows")
      .annotate(SuccessDescription, "Values")
      .annotate(OpenApi.Transform, requiredQuery(["tagKey"])),
    HttpApiEndpoint.post("query", "/query", {
      params: OrgParams,
      payload: KubernetesEfficiencyQuery,
      success: KubernetesEfficiencyResult,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(InvalidRequestMessage, "Invalid efficiency query")
      .annotate(OpenApi.Summary, "Run an unsaved Kubernetes efficiency report config")
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: KubernetesEfficiencyReport,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a Kubernetes efficiency report")
      .annotate(SuccessDescription, "Report"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: KubernetesEfficiencyReportInput,
      success: KubernetesEfficiencyReport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(InvalidRequestMessage, "Invalid efficiency report")
      .annotate(OpenApi.Summary, "Replace a Kubernetes efficiency report")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a Kubernetes efficiency report")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("run", "/:id/run", {
      params: OrgIdParams,
      success: KubernetesEfficiencyRunResult,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run a Kubernetes efficiency report")
      .annotate(
        OpenApi.Description,
        "Per row and in total: total, used, requested-but-unused, unmeasured, idle and overhead " +
          "cost, efficiency on the report's basis, a per-category breakdown and a per-period series.",
      )
      .annotate(SuccessDescription, "Result"),
    HttpApiEndpoint.get("export", "/:id/export", {
      params: OrgIdParams,
      // Read raw: an unknown format is the handler's own 400, and `perPeriod`
      // is on only for `true` or `1`.
      query: {
        format: Schema.optionalKey(documentedAs(Schema.Literals(["csv", "ndjson"]))),
        perPeriod: Schema.optionalKey(documentedAs(Schema.Literals(["true", "false", "1", "0"]))),
      },
      success: [
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/x-ndjson" })),
      ],
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Export a Kubernetes efficiency report")
      .annotate(
        OpenApi.Description,
        "One record per row and cost category plus the totals; with `perPeriod`, each row's " +
          "figures per period as well. CSV (RFC 4180) or newline-delimited JSON.",
      )
      .annotate(SuccessDescription, "The export file"),
  )
  .prefix("/api/org/:orgId/k8s-efficiency-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Kubernetes efficiency reports") {}

export class KubernetesEfficiencyReportsApi extends withApiDefaults(
  HttpApi.make("k8sEfficiencyReports").add(KubernetesEfficiencyReportsGroup),
) {}
