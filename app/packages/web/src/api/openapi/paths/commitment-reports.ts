import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostDateRange } from "./cost-reports";

const IdParam = strict({ orgId: Uuid, id: Uuid });

const Metric = z
  .enum([
    "coverage",
    "eligibleCoverage",
    "utilization",
    "effectiveSavingsRate",
    "netSavings",
    "onDemandRemainder",
    "commitmentCost",
    "usedCommitmentCost",
    "unusedCommitmentCost",
  ])
  .openapi("CommitmentReportMetric");

const Granularity = z
  .enum(["daily", "weekly", "monthly", "quarterly"])
  .describe(
    "Bucket size. There is no hourly: spend is collected one row per UTC day, so an hourly " +
      "bucket would put each day's spend at midnight. Weeks start on Monday.",
  )
  .openapi("CommitmentReportGranularity");

const GroupBy = z
  .enum(["none", "provider", "commitment_type", "commitment", "service", "account", "region"])
  .describe(
    "`commitment_type` and `commitment` split the commitment side by holding and put uncovered " +
      "usage in its own `__on_demand__` group; covered usage the provider did not tie to a " +
      "commitment (all of AWS, whose Cost Explorer cannot group by commitment) is `__unattributed__`. " +
      "Under those two, each group's coverage is its share of the bucket's whole usage, so the " +
      "groups add up. Instance family is not offered: no collector stores it on cost rows.",
  )
  .openapi("CommitmentReportGroupBy");

const Kind = z.enum(["reservation", "savings_plan", "committed_use"]);

const Filters = strict({
  providers: z.array(z.string()).max(200).optional().describe("Plugin ids: `aws`, `azure`, `gcp`."),
  commitmentTypes: z.array(Kind).max(200).optional(),
  services: z.array(z.string()).max(200).optional(),
  accountIds: z.array(Uuid).max(200).optional(),
  regions: z.array(z.string()).max(200).optional(),
  commitmentIds: z
    .array(z.string())
    .max(200)
    .optional()
    .describe("Provider-native commitment ids, as `GET /commitments/report-options` lists them."),
})
  .describe(
    "Lists AND-compose; values within a list OR. `commitmentTypes` and `commitmentIds` narrow the " +
      "commitment side (covered usage and unused fees) only: uncovered usage stays in, because it " +
      "is the rest of the coverage denominator.",
  )
  .openapi("CommitmentReportFilters");

const Config = strict({
  version: z.literal(1),
  dateRange: CostDateRange,
  granularity: Granularity,
  groupBy: GroupBy,
  filters: Filters,
  metric: Metric.describe("The metric the chart draws. The table always carries every metric."),
}).openapi("CommitmentReportConfig");

const Input = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  config: Config,
  folderId: Uuid.nullable()
    .optional()
    .describe(
      "A report folder (`/cost-report-folders`, shared with cost reports); null is the top level.",
    ),
}).openapi("CommitmentReportInput");

const Report = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  config: Config,
  folderId: Uuid.nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("CommitmentReport");

const Totals = strict({
  covered: z
    .number()
    .describe("Amortized usage the selected commitments covered: the used commitment cost."),
  coveredAll: z.number().describe("Amortized usage any commitment covered."),
  unused: z
    .number()
    .describe(
      "Amortized commitment fees no usage absorbed (only fee rows with a reported amortized amount).",
    ),
  uncovered: z.number().describe("Amortized usage no commitment covered: the on-demand remainder."),
  uncoveredEligible: z
    .number()
    .describe(
      "Uncovered usage in (provider, service, region) cells with any covered usage in the window.",
    ),
  coveredOnDemand: z
    .number()
    .describe(
      "On-demand equivalent of covered usage, summed over rows whose provider reported one.",
    ),
  coveredMeasured: z.number().describe("Amortized amount of those same rows."),
}).openapi("CommitmentReportTotals");

const nullableRatio = (d: string) =>
  z.number().nullable().describe(`${d} Null when the denominator is zero.`);

const Metrics = strict({
  coverage: nullableRatio(
    "covered ÷ (coveredAll + uncovered), or the bucket's usage under a commitment grouping.",
  ),
  eligibleCoverage: nullableRatio(
    "covered ÷ (coveredAll + uncoveredEligible): the upper bound of coverage.",
  ),
  utilization: nullableRatio("covered ÷ (covered + unused)."),
  effectiveSavingsRate: nullableRatio(
    "netSavings ÷ (onDemandEquivalent + uncovered). Null also when netSavings is null.",
  ),
  netSavings: z
    .number()
    .nullable()
    .describe(
      "(coveredOnDemand − coveredMeasured) − unused. Null when there was covered usage and none of " +
        "it had a reported on-demand equivalent; covered usage without one counts as saving nothing.",
    ),
  onDemandRemainder: z.number().describe("uncovered."),
  commitmentCost: z.number().describe("covered + unused."),
  usedCommitmentCost: z.number().describe("covered."),
  unusedCommitmentCost: z.number().describe("unused."),
  onDemandEquivalent: z.number().describe("coveredOnDemand + (covered − coveredMeasured)."),
  savingsMeasuredShare: z
    .number()
    .nullable()
    .describe(
      "coveredMeasured ÷ covered: how much of the covered spend the savings figure measured.",
    ),
}).openapi("CommitmentReportMetricValues");

const Point = strict({ bucket: z.string(), totals: Totals, metrics: Metrics }).openapi(
  "CommitmentReportPoint",
);

const Series = strict({
  id: z.string(),
  groupKey: z.string(),
  label: z.string(),
  currency: z.string(),
  points: z.array(Point),
  total: strict({ totals: Totals, metrics: Metrics }),
}).openapi("CommitmentReportSeries");

const Provider = strict({
  pluginId: z.string(),
  displayName: z.string(),
  status: z
    .enum(["measured", "inventory_only"])
    .describe(
      "`inventory_only`: the provider's holdings are collected but its cost rows do not " +
        "distinguish covered usage (GCP today), so it is left out of every metric rather than " +
        "read as 0% covered.",
    ),
  accountCount: z.number().int(),
}).openapi("CommitmentReportProvider");

const resultShape = {
  from: z.string(),
  to: z.string(),
  granularity: Granularity,
  groupBy: GroupBy,
  buckets: z.array(z.string()),
  series: z.array(Series),
  overall: z.array(Series).describe("All groups combined, one series per currency."),
  providers: z.array(Provider),
  notices: z.array(
    z.enum([
      "unused_lumped_monthly",
      "unattributed_commitment_usage",
      "partial_savings_measurement",
      "no_measurable_accounts",
    ]),
  ),
};

const Result = strict(resultShape).openapi("CommitmentReportResult");
const RunResult = strict({ ...resultShape, reportId: Uuid, name: z.string() }).openapi(
  "CommitmentReportRunResult",
);

const Options = strict({
  providers: z.array(
    strict({
      pluginId: z.string(),
      displayName: z.string(),
      status: z.enum(["measured", "inventory_only"]),
    }),
  ),
  accounts: z.array(strict({ id: Uuid, name: z.string(), pluginId: z.string() })),
  services: z.array(z.string()),
  regions: z.array(z.string()),
  commitments: z.array(
    strict({
      commitmentId: z.string(),
      accountId: Uuid,
      pluginId: z.string(),
      kind: Kind,
      description: z.string(),
      state: z.string(),
    }),
  ),
}).openapi("CommitmentReportOptions");

export function registerCommitmentReportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Commitments"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/commitments/report-options",
    tags,
    summary: "Picker values for the commitment report editor",
    description:
      "Providers (with whether their cost rows can measure coverage), accounts, the services " +
      "and regions with usage in the last 180 days, and the commitment inventory. Scoped to " +
      "what the caller may see.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Options", content: { "application/json": { schema: Options } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/commitments/report-query",
    tags,
    summary: "Run an unsaved commitment report config",
    description:
      "Coverage, utilization, savings and commitment cost over time, on the amortized basis. " +
      "See `CommitmentReportMetricValues` for each metric's formula. A read despite the method.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: Config } }, required: true },
    },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Result } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/commitments/reports",
    tags,
    summary: "List saved commitment reports",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Reports", content: { "application/json": { schema: z.array(Report) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/commitments/reports",
    tags,
    summary: "Create a commitment report",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: Input } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/commitments/reports/{id}",
    tags,
    summary: "Get a commitment report",
    request: { params: IdParam },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Report } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/commitments/reports/{id}",
    tags,
    summary: "Replace a commitment report",
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: Input } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/commitments/reports/{id}",
    tags,
    summary: "Delete a commitment report",
    request: { params: IdParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/commitments/reports/{id}/run",
    tags,
    summary: "Run a saved commitment report",
    description: "A relative date range resolves against today on every run.",
    request: { params: IdParam },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: RunResult } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
