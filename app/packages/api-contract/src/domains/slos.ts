/**
 * Service-level objectives: `/api/org/:orgId/slos`, the endpoint definitions.
 *
 * Permissions follow the probes stance: reads are `resources:read`, writes
 * `resources:write`. Starting a freeze takes `freezes:write`, because the SLO
 * page is only where the suggestion is made: freezing the org is the same
 * decision wherever the button lives.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

const SliKind = Schema.Literals([
  "probe_availability",
  "probe_latency",
  "metric_threshold",
]).annotate({
  description:
    "Where the SLI comes from: a synthetic probe's success ratio, the share of a probe's " +
    "checks at or under a latency threshold, or the share of minutes a resource's metric " +
    "series satisfies a comparison.",
});

const Comparator = Schema.Literals(["<", "<=", ">", ">="]).annotate({
  description: "`metric_threshold` only: a minute is good when `value <comparator> threshold`.",
});

const SloStatus = Schema.Literals([
  "exhausted",
  "fast_burn",
  "slow_burn",
  "ok",
  "unknown",
]).annotate({
  description:
    "Worst true thing first: `exhausted` (no budget left), `fast_burn` (a page-severity " +
    "burn-rate pair is firing), `slow_burn` (the ticket pair), `ok`, or `unknown` (no data in " +
    "the window, never evaluated, or disabled).",
});

const BurnAlert = Schema.Literals(["none", "slow", "fast"]).annotate({
  description: "The alert level the evaluator last settled on.",
});

const TargetPercent = Schema.Finite.annotate({
  description: "Objective as a percentage, at least 50 and at most 99.999.",
  examples: [99.9],
});

const WindowDays = Schema.Literals([7, 28, 30]).annotate({
  description: "Rolling window in days.",
  examples: [30],
});

const BurnRates = Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)).annotate({
  description:
    "Burn rate per window (`5m`, `30m`, `1h`, `6h`, `3d`); 1 is exactly on budget, null " +
    "where the window held no events.",
});

const sourceFields = {
  sliKind: SliKind,
  probeId: Schema.NullOr(Uuid).annotate({
    description: "`probe_*`: the synthetic probe the SLI is read from.",
  }),
  latencyThresholdMs: Schema.NullOr(Schema.Int).annotate({
    description: "`probe_latency`: a check is good at or under this many ms (1-60000).",
  }),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "`metric_threshold`: the synced resource reporting the series.",
  }),
  metricKey: Schema.NullOr(Schema.String).annotate({
    description: '`metric_threshold`: the series label as the resource reports it, e.g. "CPU %".',
  }),
  comparator: Schema.NullOr(Comparator),
  threshold: Schema.NullOr(Schema.Finite).annotate({
    description: "`metric_threshold`: the comparison's right side.",
  }),
};

const settingFields = {
  name: Schema.String.annotate({
    description: "Unique in the organization; at most 120 characters.",
  }),
  description: Schema.NullOr(Schema.String).annotate({ description: "At most 500 characters." }),
  targetPercent: TargetPercent,
  windowDays: WindowDays,
  alertsEnabled: Schema.Boolean.annotate({
    description: "Route burn-rate and exhaustion alerts through the org's alert routing rules.",
  }),
  suggestFreeze: Schema.Boolean.annotate({
    description: "When the budget runs out, the alert and the page suggest a change freeze.",
  }),
  enabled: Schema.Boolean,
};

export const Slo = Schema.Struct({
  id: Uuid,
  ...settingFields,
  ...sourceFields,
  probeName: Schema.NullOr(Schema.String).annotate({
    description: "The probe's name; null when it was deleted.",
  }),
  resourceName: Schema.NullOr(Schema.String).annotate({
    description: "The resource's name; null when it is gone.",
  }),
  accountId: Schema.NullOr(Uuid),
  pluginId: Schema.NullOr(PluginId),
  resourceTypeId: Schema.NullOr(Schema.String),
  status: SloStatus,
  sli: Schema.NullOr(Schema.Finite).annotate({
    description: "Fraction of good events over the window (0-1).",
  }),
  goodEvents: Schema.Finite,
  totalEvents: Schema.Finite.annotate({ description: "Minutes with data in the window." }),
  budgetRemaining: Schema.NullOr(Schema.Finite).annotate({
    description: "Fraction of the window's error budget left; negative when overspent.",
  }),
  budgetTotalMinutes: Schema.Finite.annotate({
    description: "The window's whole budget in minutes (43.2 for 99.9% over 30 days).",
  }),
  budgetRemainingMinutes: Schema.NullOr(Schema.Finite),
  burnRates: BurnRates,
  burnAlert: BurnAlert,
  exhaustedAt: Schema.NullOr(IsoDateTime),
  lastEvalAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "Slo" });

export const SloList = Schema.Struct({ slos: Schema.Array(Slo) }).annotate({
  identifier: "SloList",
});

const optionalInputs = {
  description: Schema.optionalKey(settingFields.description),
  probeId: Schema.optionalKey(sourceFields.probeId),
  latencyThresholdMs: Schema.optionalKey(sourceFields.latencyThresholdMs),
  resourceId: Schema.optionalKey(sourceFields.resourceId),
  metricKey: Schema.optionalKey(sourceFields.metricKey),
  comparator: Schema.optionalKey(sourceFields.comparator),
  threshold: Schema.optionalKey(sourceFields.threshold),
  targetPercent: Schema.optionalKey(TargetPercent),
  windowDays: Schema.optionalKey(WindowDays),
  alertsEnabled: Schema.optionalKey(Schema.Boolean),
  suggestFreeze: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
};

const SloCreate = Schema.Struct({
  name: settingFields.name,
  sliKind: SliKind,
  ...optionalInputs,
}).annotate({ identifier: "SloCreate" });

const SloUpdate = Schema.Struct({
  name: Schema.optionalKey(settingFields.name),
  sliKind: Schema.optionalKey(SliKind),
  ...optionalInputs,
}).annotate({ identifier: "SloUpdate" });

const SloBucket = Schema.Struct({
  startMs: Schema.Finite.annotate({ description: "Hour start, Unix epoch ms." }),
  good: Schema.Finite,
  total: Schema.Finite.annotate({ description: "Minutes with data in the hour." }),
}).annotate({ identifier: "SloBucket" });

export const SloActiveFreeze = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  endsAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "SloActiveFreeze" });

export const SloDetail = Schema.Struct({
  slo: Slo,
  buckets: Schema.Array(SloBucket).annotate({
    description: "Hourly events over the window, oldest first.",
  }),
  activeFreeze: Schema.NullOr(SloActiveFreeze).annotate({
    description: "The change freeze in effect, if any.",
  }),
}).annotate({ identifier: "SloDetail" });

export const SloSources = Schema.Struct({
  probes: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      url: Schema.String,
      status: Schema.Literals(["up", "down", "unknown"]),
    }),
  ),
  metricResources: Schema.Array(
    Schema.Struct({
      resourceId: Schema.String,
      displayName: Schema.String,
      accountId: Uuid,
      pluginId: PluginId,
      resourceTypeId: Schema.String,
      series: Schema.Array(Schema.Struct({ label: Schema.String, unit: Schema.String })),
    }),
  ),
}).annotate({ identifier: "SloSources" });

const SloFreezeRequest = Schema.Struct({
  durationHours: Schema.optionalKey(
    Schema.NullOr(Schema.Literals([24, 72, 168])).annotate({
      description: "How long the freeze lasts; null or omitted means until somebody ends it.",
    }),
  ),
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SloFreezeRequest" });

const SloParams = { orgId: OrgId, sloId: Uuid } as const;

export class SlosGroup extends HttpApiGroup.make("slos")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: SloList })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List SLOs")
      .annotate(
        OpenApi.Description,
        "Every service-level objective with its last snapshot: SLI, error budget remaining (as a " +
          "fraction and in minutes) and burn rates over the alerting windows.",
      )
      .annotate(SuccessDescription, "The SLOs"),
    HttpApiEndpoint.get("sources", "/sources", { params: OrgParams, success: SloSources })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List what an SLO can be measured from")
      .annotate(
        OpenApi.Description,
        "Every synthetic probe, and every synced resource that reported a metric series in the " +
          "last week with the series it reported. Feeds the editor's pickers.",
      )
      .annotate(SuccessDescription, "Probes and metric-reporting resources"),
    HttpApiEndpoint.get("get", "/:sloId", {
      params: SloParams,
      success: SloDetail,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read an SLO with its history")
      .annotate(
        OpenApi.Description,
        "The SLO plus hourly good/total buckets over its window (the SLI and budget-burndown " +
          "charts are drawn from these) and the change freeze in effect, if any.",
      )
      .annotate(SuccessDescription, "The SLO"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: SloCreate,
      success: Slo.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create an SLO")
      .annotate(
        OpenApi.Description,
        "Out-of-range inputs are rejected, not clamped. The source must exist in the " +
          "organization. The first evaluation runs within one poller tick. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created SLO")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.put("update", "/:sloId", {
      params: SloParams,
      payload: SloUpdate,
      success: Slo,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update an SLO")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value. Changing the source, target or window resets the " +
          "snapshot and the alert state. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated SLO")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:sloId", {
      params: SloParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete an SLO")
      .annotate(OpenApi.Description, "The measured series are untouched. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("freeze", "/:sloId/freeze", {
      params: SloParams,
      payload: SloFreezeRequest,
      success: SloActiveFreeze.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "freezes:write")
      .annotate(OpenApi.Summary, "Start a change freeze for an SLO")
      .annotate(
        OpenApi.Description,
        "Acts on the freeze suggestion an exhausted budget makes: creates an ordinary change " +
          "freeze named after the SLO, listed and ended like any other. Needs `freezes:write`.",
      )
      .annotate(SuccessDescription, "The freeze")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/slos")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "SLOs") {}

export class SlosApi extends withApiDefaults(HttpApi.make("slos").add(SlosGroup)) {}
