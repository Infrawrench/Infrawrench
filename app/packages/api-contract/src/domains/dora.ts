/**
 * DORA metrics (the Delivery page): `/api/org/:orgId/dora`, the endpoint
 * definitions. The report, its two drill-downs, the org settings singleton,
 * and a way to push in a deploy no plugin covers.
 *
 * Reads take `deployments:read`, the permission the deployment history
 * already uses: the metrics are a view over the same record. The settings
 * decide what counts as production for everyone, so writing them takes
 * `org:settings:write`; recording a deploy takes `deployments:write`.
 *
 * Query strings and write bodies are documented here and checked by hand in
 * the handlers, whose 400s name the field at fault.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";

const DoraBand = Schema.Literals(["elite", "high", "medium", "low"]).annotate({
  identifier: "DoraBand",
  description:
    "The standard DORA performance band: deploys at least daily / weekly / monthly; lead time " +
    "under a day / week / month; change failure rate at most 5% / 10% / 15%; time to restore " +
    "under an hour / day / week. Null when there was nothing to measure.",
});

const DeployStatus = Schema.Literals(["success", "failure", "in_progress", "canceled"]);

const DoraSource = Schema.Literals([
  "infrafile",
  "plugin",
  "github",
  "api",
  "change_timeline",
]).annotate({
  identifier: "DoraSource",
  description:
    "Where the change was learned from: an Infrafile run, a synced provider deploy, a GitHub " +
    "deployment, one recorded over this API, or the change timeline.",
});

const DoraScopeValue = Schema.Struct({
  key: Schema.String.annotate({ description: "Stable key; what `value` filters by." }),
  label: Schema.String,
}).annotate({ identifier: "DoraScopeValue" });

const Scope = Schema.Record(Schema.String, Schema.NullOr(DoraScopeValue)).annotate({
  description: "Dimension id to value; null where the dimension is not known for this change.",
});

const metricBase = {
  value: Schema.NullOr(Schema.Finite),
  band: Schema.NullOr(DoraBand),
  sample: Schema.Int.annotate({ description: "How many observations the value rests on." }),
};

const DoraSummary = Schema.Struct({
  deploymentFrequency: Schema.Struct({
    ...metricBase,
    deploys: Schema.Int,
    days: Schema.Finite,
  }).annotate({ description: "`value` is successful production deploys per day." }),
  leadTime: Schema.Struct({
    ...metricBase,
    p90Hours: Schema.NullOr(Schema.Finite),
  }).annotate({ description: "`value` is the median hours from commit to production." }),
  changeFailureRate: Schema.Struct({
    ...metricBase,
    changes: Schema.Int,
    failures: Schema.Int,
  }).annotate({ description: "`value` is the share of production changes that failed, 0-1." }),
  timeToRestore: Schema.Struct({
    ...metricBase,
    restores: Schema.Int,
  }).annotate({ description: "`value` is the median hours from failure to recovery." }),
}).annotate({ identifier: "DoraSummary" });

export const DoraSettings = Schema.Struct({
  failureWindowHours: Schema.Int.annotate({
    description: "Hours after a change in which an incident or rollback counts against it (1-720).",
  }),
  productionEnvironments: Schema.Array(Schema.String).annotate({
    description: "Environment name patterns that count as production; `*` matches anything. 1-50.",
  }),
  pipelinePatterns: Schema.Array(Schema.String).annotate({
    description: "CI pipeline names that count as deploys (Buildkite, CircleCI, GitLab...). 0-50.",
  }),
  countFailedDeploys: Schema.Boolean.annotate({
    description: "Count a production deploy that failed as a failed change.",
  }),
  includeResourceChanges: Schema.Boolean.annotate({
    description: "Count changes observed by sync (the change timeline) as changes too.",
  }),
  digestEnabled: Schema.Boolean.annotate({
    description: "Include the Delivery line in the weekly digest.",
  }),
  updatedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Null until the settings were first saved.",
  }),
}).annotate({ identifier: "DoraSettings" });

const DoraSettingsUpdate = Schema.Struct({
  failureWindowHours: Schema.optionalKey(Schema.Int),
  productionEnvironments: Schema.optionalKey(Schema.Array(Schema.String)),
  pipelinePatterns: Schema.optionalKey(Schema.Array(Schema.String)),
  countFailedDeploys: Schema.optionalKey(Schema.Boolean),
  includeResourceChanges: Schema.optionalKey(Schema.Boolean),
  digestEnabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "DoraSettingsUpdate" });

const DoraScopeFilter = Schema.Struct({
  dimension: Schema.String,
  value: Schema.NullOr(Schema.String),
}).annotate({ identifier: "DoraScopeFilter" });

export const DoraReport = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  bucket: Schema.Literals(["day", "week"]),
  filter: Schema.NullOr(DoraScopeFilter),
  groupBy: Schema.String,
  summary: DoraSummary,
  previous: DoraSummary.annotate({
    description: "The same-length period immediately before `from`.",
  }),
  trend: Schema.Array(
    Schema.Struct({
      start: IsoDateTime,
      deploys: Schema.Int,
      changes: Schema.Int,
      failures: Schema.Int,
      restores: Schema.Int,
      leadTimeMedianHours: Schema.NullOr(Schema.Finite),
      changeFailureRate: Schema.NullOr(Schema.Finite),
      restoreMedianHours: Schema.NullOr(Schema.Finite),
    }),
  ),
  breakdown: Schema.Array(
    Schema.Struct({
      key: Schema.NullOr(Schema.String),
      label: Schema.String,
      summary: DoraSummary,
    }),
  ).annotate({
    description: "The four metrics per value of `groupBy`, busiest first, at most 25 rows.",
  }),
  dimensions: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })).annotate({
    description:
      "Scope dimensions this server knows: environment, repository, owner, and any added.",
  }),
  settings: DoraSettings,
  eventCount: Schema.Int.annotate({
    description: "Deploy events of any environment in the window.",
  }),
  scopeValues: Schema.Record(Schema.String, Schema.Array(DoraScopeValue)).annotate({
    description: "Every value each dimension took in the window: what a scope picker offers.",
  }),
}).annotate({ identifier: "DoraReport" });

const DoraFailure = Schema.Struct({
  kind: Schema.Literals(["incident", "rollback", "failed_deploy", "reverted"]),
  refId: Schema.String,
  title: Schema.String,
  at: IsoDateTime,
}).annotate({ identifier: "DoraFailure" });

const DoraChange = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["deploy", "resource_change"]),
  name: Schema.String,
  environment: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  at: IsoDateTime,
  status: DeployStatus,
  source: DoraSource,
  pluginId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  isRollback: Schema.Boolean,
  leadTimeHours: Schema.NullOr(Schema.Finite),
  failure: Schema.NullOr(DoraFailure),
  scope: Scope,
}).annotate({ identifier: "DoraChange" });

export const DoraChangeList = Schema.Struct({
  changes: Schema.Array(DoraChange),
  truncated: Schema.Boolean,
}).annotate({ identifier: "DoraChangeList" });

const DoraRestore = Schema.Struct({
  kind: Schema.Literals(["incident", "rollback"]),
  id: Schema.String,
  title: Schema.String,
  startedAt: IsoDateTime,
  restoredAt: IsoDateTime,
  hours: Schema.Finite,
  changeId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "DoraRestore" });

export const DoraRestoreList = Schema.Struct({
  restores: Schema.Array(DoraRestore),
}).annotate({ identifier: "DoraRestoreList" });

const DoraDeploymentInput = Schema.Struct({
  externalId: Schema.String.annotate({
    description: "Your id for the deploy (max 200). Sending it again updates the same deploy.",
  }),
  name: Schema.String.annotate({
    description: "What was deployed, as a person calls it (max 300).",
  }),
  environment: Schema.String.annotate({
    description: "Environment name, matched against the production patterns.",
  }),
  repository: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "`owner/name` or a repository URL." }),
  ),
  commitSha: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({ description: "Hexadecimal, 7-64 characters." }),
  ),
  commitAt: Schema.optionalKey(
    Schema.NullOr(IsoDateTime).annotate({
      description: "When the commit was authored, if known.",
    }),
  ),
  deployedAt: IsoDateTime,
  status: Schema.optionalKey(DeployStatus.annotate({ description: "Defaults to `success`." })),
  isRollback: Schema.optionalKey(Schema.Boolean),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "DoraDeploymentInput" });

export const DoraDeploymentRecorded = Schema.Struct({ id: Schema.String }).annotate({
  identifier: "DoraDeploymentRecorded",
});

/** Read as sent: `from`/`to` are parsed by the handler, which names the bad one. */
const windowQuery = {
  from: Schema.optionalKey(
    documentedAs(
      IsoDateTime.annotate({ description: "Start (inclusive). Defaults to 30 days before `to`." }),
    ),
  ),
  to: Schema.optionalKey(
    documentedAs(
      IsoDateTime.annotate({
        description: "End (exclusive). Defaults to now. At most 366 days after `from`.",
      }),
    ),
  ),
  dimension: Schema.optionalKey(
    Schema.String.annotate({ description: "Filter to one scope of this dimension." }),
  ),
  value: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The scope key to filter to. Omit it with `dimension` for changes where it is not known.",
    }),
  ),
};

export class DoraGroup extends HttpApiGroup.make("dora")
  .add(
    HttpApiEndpoint.get("report", "/", {
      params: OrgParams,
      query: {
        ...windowQuery,
        bucket: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["day", "week"]).annotate({
              description: "Trend bucket; weeks past 45 days.",
            }),
          ),
        ),
        groupBy: Schema.optionalKey(
          Schema.String.annotate({
            description: "Breakdown dimension; defaults to `environment`.",
          }),
        ),
      },
      success: DoraReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "DORA metrics")
      .annotate(
        OpenApi.Description,
        "Deployment frequency, lead time for changes, change failure rate and time to restore over " +
          "production, from Infrafile runs, synced provider deploys, GitHub deployments, recorded " +
          "deploys and declared incidents. With the previous period, a trend, and a breakdown.",
      )
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.get("changes", "/changes", {
      params: OrgParams,
      query: {
        ...windowQuery,
        // Read as sent: anything but `true` lists every change, as it always did.
        failedOnly: Schema.optionalKey(documentedAs(Schema.Literals(["true", "false"]))),
      },
      success: DoraChangeList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List production changes")
      .annotate(
        OpenApi.Description,
        "The drill-down: every production change in the window with its lead time and, when it " +
          "failed, what it was blamed for. Newest first, at most 500.",
      )
      .annotate(SuccessDescription, "The changes"),
    HttpApiEndpoint.get("restores", "/restores", {
      params: OrgParams,
      query: windowQuery,
      success: DoraRestoreList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "List recoveries")
      .annotate(
        OpenApi.Description,
        "Declared incidents resolved and bad deploys rolled back in the window, newest first, " +
          "at most 500.",
      )
      .annotate(SuccessDescription, "The recoveries"),
    HttpApiEndpoint.get("settings", "/settings", { params: OrgParams, success: DoraSettings })
      .annotate(RequiredPermission, "deployments:read")
      .annotate(OpenApi.Summary, "Read DORA settings")
      .annotate(OpenApi.Description, "The org singleton; the shipped defaults until first saved.")
      .annotate(SuccessDescription, "The settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: DoraSettingsUpdate,
      success: DoraSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update DORA settings")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value. Patterns are trimmed and de-duplicated. Out-of-range " +
          "values are rejected, not clamped. Audit-logged.",
      )
      .annotate(SuccessDescription, "The saved settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("recordDeployment", "/deployments", {
      params: OrgParams,
      payload: DoraDeploymentInput,
      success: DoraDeploymentRecorded.pipe(HttpApiSchema.status(201)),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "deployments:write")
      .annotate(OpenApi.Summary, "Record a deploy")
      .annotate(
        OpenApi.Description,
        "For a CI or deploy tool no plugin covers: one call per deploy, from the pipeline's last " +
          "step. Idempotent on `externalId`, so a retried step updates rather than duplicates. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "Recorded")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/dora")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "DORA") {}

export class DoraApi extends withApiDefaults(HttpApi.make("dora").add(DoraGroup)) {}
