import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Band = z.enum(["elite", "high", "medium", "low"]).openapi("DoraBand", {
  description:
    "The standard DORA performance band: deploys at least daily / weekly / monthly; lead time " +
    "under a day / week / month; change failure rate at most 5% / 10% / 15%; time to restore " +
    "under an hour / day / week. Null when there was nothing to measure.",
});

const DeployStatus = z.enum(["success", "failure", "in_progress", "canceled"]);

const Source = z
  .enum(["infrafile", "plugin", "github", "api", "change_timeline"])
  .openapi("DoraSource", {
    description:
      "Where the change was learned from: an Infrafile run, a synced provider deploy, a GitHub " +
      "deployment, one recorded over this API, or the change timeline.",
  });

const ScopeValue = strict({
  key: z.string().describe("Stable key; what `value` filters by."),
  label: z.string(),
}).openapi("DoraScopeValue");

const Scope = z
  .record(z.string(), ScopeValue.nullable())
  .describe("Dimension id to value; null where the dimension is not known for this change.");

const MetricBase = {
  value: z.number().nullable(),
  band: Band.nullable(),
  sample: z.number().int().describe("How many observations the value rests on."),
};

const Summary = strict({
  deploymentFrequency: strict({
    ...MetricBase,
    deploys: z.number().int(),
    days: z.number(),
  }).describe("`value` is successful production deploys per day."),
  leadTime: strict({
    ...MetricBase,
    p90Hours: z.number().nullable(),
  }).describe("`value` is the median hours from commit to production."),
  changeFailureRate: strict({
    ...MetricBase,
    changes: z.number().int(),
    failures: z.number().int(),
  }).describe("`value` is the share of production changes that failed, 0-1."),
  timeToRestore: strict({
    ...MetricBase,
    restores: z.number().int(),
  }).describe("`value` is the median hours from failure to recovery."),
}).openapi("DoraSummary");

const Settings = strict({
  failureWindowHours: z
    .number()
    .int()
    .describe("Hours after a change in which an incident or rollback counts against it (1-720)."),
  productionEnvironments: z
    .array(z.string())
    .describe("Environment name patterns that count as production; `*` matches anything. 1-50."),
  pipelinePatterns: z
    .array(z.string())
    .describe("CI pipeline names that count as deploys (Buildkite, CircleCI, GitLab...). 0-50."),
  countFailedDeploys: z
    .boolean()
    .describe("Count a production deploy that failed as a failed change."),
  includeResourceChanges: z
    .boolean()
    .describe("Count changes observed by sync (the change timeline) as changes too."),
  digestEnabled: z.boolean().describe("Include the Delivery line in the weekly digest."),
  updatedAt: IsoDateTime.nullable().describe("Null until the settings were first saved."),
}).openapi("DoraSettings");

const SettingsUpdate = strict({
  failureWindowHours: z.number().int().optional(),
  productionEnvironments: z.array(z.string()).optional(),
  pipelinePatterns: z.array(z.string()).optional(),
  countFailedDeploys: z.boolean().optional(),
  includeResourceChanges: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
}).openapi("DoraSettingsUpdate");

const Filter = strict({
  dimension: z.string(),
  value: z.string().nullable(),
}).openapi("DoraScopeFilter");

const Report = strict({
  from: IsoDateTime,
  to: IsoDateTime,
  bucket: z.enum(["day", "week"]),
  filter: Filter.nullable(),
  groupBy: z.string(),
  summary: Summary,
  previous: Summary.describe("The same-length period immediately before `from`."),
  trend: z.array(
    strict({
      start: IsoDateTime,
      deploys: z.number().int(),
      changes: z.number().int(),
      failures: z.number().int(),
      restores: z.number().int(),
      leadTimeMedianHours: z.number().nullable(),
      changeFailureRate: z.number().nullable(),
      restoreMedianHours: z.number().nullable(),
    }),
  ),
  breakdown: z
    .array(strict({ key: z.string().nullable(), label: z.string(), summary: Summary }))
    .describe("The four metrics per value of `groupBy`, busiest first, at most 25 rows."),
  dimensions: z
    .array(strict({ id: z.string(), label: z.string() }))
    .describe("Scope dimensions this server knows: environment, repository, owner, and any added."),
  settings: Settings,
  eventCount: z.number().int().describe("Deploy events of any environment in the window."),
  scopeValues: z
    .record(z.string(), z.array(ScopeValue))
    .describe("Every value each dimension took in the window: what a scope picker offers."),
}).openapi("DoraReport");

const Failure = strict({
  kind: z.enum(["incident", "rollback", "failed_deploy", "reverted"]),
  refId: z.string(),
  title: z.string(),
  at: IsoDateTime,
}).openapi("DoraFailure");

const Change = strict({
  id: z.string(),
  type: z.enum(["deploy", "resource_change"]),
  name: z.string(),
  environment: z.string().nullable(),
  repository: z.string().nullable(),
  commitSha: z.string().nullable(),
  at: IsoDateTime,
  status: DeployStatus,
  source: Source,
  pluginId: z.string().nullable(),
  url: z.string().nullable(),
  isRollback: z.boolean(),
  leadTimeHours: z.number().nullable(),
  failure: Failure.nullable(),
  scope: Scope,
}).openapi("DoraChange");

const Restore = strict({
  kind: z.enum(["incident", "rollback"]),
  id: z.string(),
  title: z.string(),
  startedAt: IsoDateTime,
  restoredAt: IsoDateTime,
  hours: z.number(),
  changeId: z.string().nullable(),
}).openapi("DoraRestore");

const DeploymentInput = strict({
  externalId: z
    .string()
    .describe("Your id for the deploy (max 200). Sending it again updates the same deploy."),
  name: z.string().describe("What was deployed, as a person calls it (max 300)."),
  environment: z.string().describe("Environment name, matched against the production patterns."),
  repository: z.string().nullable().optional().describe("`owner/name` or a repository URL."),
  commitSha: z.string().nullable().optional().describe("Hexadecimal, 7-64 characters."),
  commitAt: IsoDateTime.nullable().optional().describe("When the commit was authored, if known."),
  deployedAt: IsoDateTime,
  status: DeployStatus.optional().describe("Defaults to `success`."),
  isRollback: z.boolean().optional(),
  url: z.string().nullable().optional(),
}).openapi("DoraDeploymentInput");

const windowQuery = {
  from: IsoDateTime.optional().describe("Start (inclusive). Defaults to 30 days before `to`."),
  to: IsoDateTime.optional().describe(
    "End (exclusive). Defaults to now. At most 366 days after `from`.",
  ),
  dimension: z.string().optional().describe("Filter to one scope of this dimension."),
  value: z
    .string()
    .optional()
    .describe(
      "The scope key to filter to. Omit it with `dimension` for changes where it is not known.",
    ),
};

export function registerDoraPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["DORA"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dora",
    tags,
    summary: "DORA metrics",
    description:
      "Deployment frequency, lead time for changes, change failure rate and time to restore over " +
      "production, from Infrafile runs, synced provider deploys, GitHub deployments, recorded " +
      "deploys and declared incidents. With the previous period, a trend, and a breakdown.",
    request: {
      params: OrgIdParam,
      query: strict({
        ...windowQuery,
        bucket: z.enum(["day", "week"]).optional().describe("Trend bucket; weeks past 45 days."),
        groupBy: z.string().optional().describe("Breakdown dimension; defaults to `environment`."),
      }),
    },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dora/changes",
    tags,
    summary: "List production changes",
    description:
      "The drill-down: every production change in the window with its lead time and, when it " +
      "failed, what it was blamed for. Newest first, at most 500.",
    request: {
      params: OrgIdParam,
      query: strict({
        ...windowQuery,
        failedOnly: z.enum(["true", "false"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "The changes",
        content: {
          "application/json": {
            schema: strict({ changes: z.array(Change), truncated: z.boolean() }).openapi(
              "DoraChangeList",
            ),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dora/restores",
    tags,
    summary: "List recoveries",
    description:
      "Declared incidents resolved and bad deploys rolled back in the window, newest first, " +
      "at most 500.",
    request: { params: OrgIdParam, query: strict(windowQuery) },
    responses: {
      200: {
        description: "The recoveries",
        content: {
          "application/json": {
            schema: strict({ restores: z.array(Restore) }).openapi("DoraRestoreList"),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/dora/settings",
    tags,
    summary: "Read DORA settings",
    description: "The org singleton; the shipped defaults until first saved.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "The settings", content: { "application/json": { schema: Settings } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/dora/settings",
    tags,
    summary: "Update DORA settings",
    description:
      "Omitted fields keep their value. Patterns are trimmed and de-duplicated. Out-of-range " +
      "values are rejected, not clamped. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The saved settings",
        content: { "application/json": { schema: Settings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/dora/deployments",
    tags,
    summary: "Record a deploy",
    description:
      "For a CI or deploy tool no plugin covers: one call per deploy, from the pipeline's last " +
      "step. Idempotent on `externalId`, so a retried step updates rather than duplicates. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DeploymentInput } } },
    },
    responses: {
      201: {
        description: "Recorded",
        content: {
          "application/json": {
            schema: strict({ id: z.string() }).openapi("DoraDeploymentRecorded"),
          },
        },
      },
      400: ErrorResponses[400],
    },
  });
}
