import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostDateRange } from "./cost-reports";

const Category = z
  .enum(["cpu", "memory", "gpu", "storage", "network", "control_plane", "compute"])
  .describe(
    "What the money bought. `network` is load balancers; `compute` is CPU and memory together, " +
      "and only appears on rows collected before the two were written apart.",
  )
  .openapi("KubernetesCostCategory");

const EfficiencyFilter = strict({
  dimension: z
    .enum(["account", "region", "tag"])
    .describe(
      "`account` is a Kubernetes cluster (its connected account id). `tag` covers namespace, " +
        "workload, workload_kind, node_pool, capacity_type, instance_type, zone and the " +
        "`k8s_pod_label:`, `k8s_node_label:` and `k8s_pvc_label:` labels.",
    ),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string().max(500)).min(1).max(200),
  tagKey: z.string().min(1).max(300).optional().describe("Required when `dimension` is `tag`."),
}).openapi("KubernetesEfficiencyFilter");

const EfficiencyConfig = strict({
  version: z.literal(1),
  dateRange: CostDateRange,
  granularity: z.enum(["day", "week", "month"]),
  filters: z.array(EfficiencyFilter).max(20),
  groupBy: z.enum(["cluster", "namespace", "workload", "label", "node_pool", "category"]),
  groupByLabelKey: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("The tag key to group by; required exactly when `groupBy` is `label`."),
  categories: z
    .array(Category)
    .max(7)
    .optional()
    .describe("Cost categories to include. Absent or empty is every category."),
  idle: z
    .enum(["separate", "spread"])
    .describe(
      "`separate` keeps idle capacity and cluster overhead as their own rows; `spread` shares " +
        "them across each cluster's groups, per period, in proportion to what each was allocated.",
    ),
  basis: z
    .enum(["total", "allocated"])
    .describe(
      "Efficiency denominator. `total`: used / (total - unmeasured), so idle and overhead count " +
        "against it. `allocated`: used / (used + unused), what workloads reserved only.",
    ),
}).openapi("KubernetesEfficiencyConfig");

const ReportInput = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  config: EfficiencyConfig,
  folderId: z
    .string()
    .nullable()
    .optional()
    .describe("A cost-report folder to file it under; null is the top level."),
}).openapi("KubernetesEfficiencyReportInput");

const Report = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  config: EfficiencyConfig,
  folderId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("KubernetesEfficiencyReport");

const amountShape = {
  total: z.number(),
  used: z.number().describe("Capacity measurably used (and mounted volumes, load balancers)."),
  unused: z.number().describe("Requested but measured unused."),
  unmeasured: z.number().describe("Allocated with no usage data."),
  idle: z.number().describe("Capacity nobody requested, unrequested GPUs, unattached volumes."),
  overhead: z.number().describe("System-reserved node capacity and the control-plane fee."),
  allocated: z.number().describe("used + unused + unmeasured."),
  efficiency: z.number().nullable().describe("0..1 on the report's basis; null when unmeasured."),
  measuredShare: z.number().nullable(),
};

const Figures = strict(amountShape).openapi("KubernetesEfficiencyFigures");
const CategoryFigures = strict({ category: Category, figures: Figures });
const Point = strict({ bucket: z.string(), ...amountShape });

const Row = strict({
  key: z.string(),
  kind: z.enum(["group", "idle", "overhead", "unattributed"]),
  label: z.string(),
  figures: Figures,
  categories: z.array(CategoryFigures),
  points: z.array(Point),
}).openapi("KubernetesEfficiencyRow");

const Result = strict({
  from: z.string(),
  to: z.string(),
  granularity: z.enum(["day", "week", "month"]),
  groupBy: z.enum(["cluster", "namespace", "workload", "label", "node_pool", "category"]),
  groupByLabelKey: z.string().optional(),
  idle: z.enum(["separate", "spread"]),
  basis: z.enum(["total", "allocated"]),
  buckets: z.array(z.string()),
  currencies: z.array(
    strict({
      currency: z.string(),
      totals: Figures,
      categories: z.array(CategoryFigures),
      points: z.array(Point),
      rows: z.array(Row),
    }),
  ),
  includesLegacyRows: z
    .boolean()
    .describe("Some rows predate the resource and usage tags (reported as `compute`, unmeasured)."),
}).openapi("KubernetesEfficiencyResult");

const RunResult = strict({ reportId: Uuid, name: z.string(), result: Result }).openapi(
  "KubernetesEfficiencyRunResult",
);

const TagKeyDescription = strict({
  key: z.string(),
  group: z.enum(["tag", "k8s", "k8s_pod_label", "k8s_node_label", "k8s_pvc_label"]),
  name: z.string(),
});

const Options = strict({
  clusters: z.array(strict({ id: z.string(), name: z.string() })),
  regions: z.array(z.string()),
  namespaces: z.array(z.string()),
  nodePools: z.array(z.string()),
  labelKeys: z.array(
    strict({
      group: z.enum(["tag", "k8s", "k8s_pod_label", "k8s_node_label", "k8s_pvc_label"]),
      keys: z.array(TagKeyDescription),
    }),
  ),
}).openapi("KubernetesEfficiencyOptions");

export function registerKubernetesEfficiencyReportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Kubernetes efficiency reports"];
  const base = "/api/org/{orgId}/k8s-efficiency-reports";
  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });
  const json = (schema: z.ZodType) => ({ content: { "application/json": { schema } } });

  registry.registerPath({
    method: "get",
    path: base,
    tags,
    summary: "List Kubernetes efficiency reports",
    description: "The reports the caller's sharing lets them open, alphabetically.",
    request: { params: OrgIdParam },
    responses: { 200: { description: "Reports", ...json(z.array(Report)) } },
  });
  registry.registerPath({
    method: "post",
    path: base,
    tags,
    summary: "Create a Kubernetes efficiency report",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ReportInput } }, required: true },
    },
    responses: { 200: { description: "Created", ...json(Report) }, 400: ErrorResponses[400] },
  });
  registry.registerPath({
    method: "get",
    path: `${base}/options`,
    tags,
    summary: "Picker options for Kubernetes efficiency reports",
    description:
      "Clusters, regions, namespaces, node pools and label keys present on the org's " +
      "Kubernetes cost rows, narrowed to the caller's cost visibility scope.",
    request: { params: OrgIdParam },
    responses: { 200: { description: "Options", ...json(Options) } },
  });
  registry.registerPath({
    method: "get",
    path: `${base}/values`,
    tags,
    summary: "Values of one label on Kubernetes cost rows",
    request: {
      params: OrgIdParam,
      query: strict({ tagKey: z.string().min(1) }),
    },
    responses: {
      200: { description: "Values", ...json(strict({ values: z.array(z.string()) })) },
      400: ErrorResponses[400],
    },
  });
  registry.registerPath({
    method: "post",
    path: `${base}/query`,
    tags,
    summary: "Run an unsaved Kubernetes efficiency report config",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ config: EfficiencyConfig }) } },
        required: true,
      },
    },
    responses: { 200: { description: "Result", ...json(Result) }, 400: ErrorResponses[400] },
  });
  registry.registerPath({
    method: "get",
    path: `${base}/{id}`,
    tags,
    summary: "Get a Kubernetes efficiency report",
    request: { params: idParam() },
    responses: { 200: { description: "Report", ...json(Report) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "put",
    path: `${base}/{id}`,
    tags,
    summary: "Replace a Kubernetes efficiency report",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: ReportInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", ...json(Report) },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
  registry.registerPath({
    method: "delete",
    path: `${base}/{id}`,
    tags,
    summary: "Delete a Kubernetes efficiency report",
    request: { params: idParam() },
    responses: { 200: { description: "Deleted", ...json(Ok) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "post",
    path: `${base}/{id}/run`,
    tags,
    summary: "Run a Kubernetes efficiency report",
    description:
      "Per row and in total: total, used, requested-but-unused, unmeasured, idle and overhead " +
      "cost, efficiency on the report's basis, a per-category breakdown and a per-period series.",
    request: { params: idParam() },
    responses: { 200: { description: "Result", ...json(RunResult) }, 404: ErrorResponses[404] },
  });
  registry.registerPath({
    method: "get",
    path: `${base}/{id}/export`,
    tags,
    summary: "Export a Kubernetes efficiency report",
    description:
      "One record per row and cost category plus the totals; with `perPeriod`, each row's " +
      "figures per period as well. CSV (RFC 4180) or newline-delimited JSON.",
    request: {
      params: idParam(),
      query: strict({
        format: z.enum(["csv", "ndjson"]).optional(),
        perPeriod: z.enum(["true", "false", "1", "0"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "The export file",
        content: {
          "text/csv": { schema: z.string() },
          "application/x-ndjson": { schema: z.string() },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
