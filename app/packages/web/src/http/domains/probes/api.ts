/**
 * Synthetic probes: `/api/org/:orgId/probes`, the endpoint definitions.
 *
 * HTTP uptime/latency checks run on an interval from the egress-proxy Worker
 * (an external vantage point). Reads are `resources:read` (the suggestions
 * list is derived from the org's resource set), mutations `resources:write`:
 * a probe is a standing instruction to poll an endpoint the org's resources
 * expose.
 *
 * The write bodies are documented here and picked by hand in the handlers
 * (a field of the wrong type is ignored, the store clamps numbers into range),
 * so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound, ServiceUnavailable } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

const ProbeStatus = Schema.Literals(["up", "down", "unknown"]).annotate({
  description:
    "The probe's state machine: `unknown` until the first result, `down` after " +
    "`failureThreshold` consecutive failures, `up` on any success.",
});

const ProbeMethod = Schema.String.annotate({
  description: "HTTP method the probe uses, GET, HEAD or OPTIONS. Unknown values become GET.",
  examples: ["GET"],
});

const IntervalSeconds = Schema.Int.annotate({
  description: "Seconds between checks. Clamped server-side to 60–86400.",
  examples: [60],
});

const TimeoutMs = Schema.Int.annotate({
  description: "Per-check timeout in milliseconds. Clamped server-side to 1000–60000.",
  examples: [10000],
});

const FailureThreshold = Schema.Int.annotate({
  description: "Consecutive failures before the probe flips to `down` and notifies. Clamped 1–20.",
  examples: [3],
});

export const SyntheticProbe = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  url: Schema.String.annotate({
    description: "Absolute http(s) URL the check hits from the edge proxy.",
  }),
  method: ProbeMethod,
  intervalSeconds: IntervalSeconds,
  timeoutMs: TimeoutMs,
  failureThreshold: FailureThreshold,
  enabled: Schema.Boolean,
  accountId: Schema.NullOr(Uuid).annotate({
    description: "Account of the linked resource, when the URL came from one.",
  }),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "Linked resource id; advisory, not a foreign key.",
  }),
  pluginId: Schema.NullOr(PluginId),
  resourceTypeId: Schema.NullOr(Schema.String),
  outputKey: Schema.NullOr(Schema.String).annotate({
    description: "The resource output/field key the URL was suggested from.",
  }),
  status: ProbeStatus,
  consecutiveFailures: Schema.Int,
  lastProbeAt: Schema.NullOr(IsoDateTime),
  lastStatusCode: Schema.NullOr(Schema.Int),
  lastLatencyMs: Schema.NullOr(Schema.Int),
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Failure detail; null after a success.",
  }),
  lastStateChangeAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When status last flipped up/down.",
  }),
  uptime24h: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Fraction (0–1) of the trailing 24h the endpoint was up, from the recorded series; " +
      "null before the first result lands in the metric store.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SyntheticProbe" });

export const SyntheticProbeList = Schema.Struct({
  probes: Schema.Array(SyntheticProbe),
}).annotate({ identifier: "SyntheticProbeList" });

const SyntheticProbeCreate = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  method: Schema.optionalKey(ProbeMethod),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  timeoutMs: Schema.optionalKey(TimeoutMs),
  failureThreshold: Schema.optionalKey(FailureThreshold),
  enabled: Schema.optionalKey(Schema.Boolean),
  resourceId: Schema.optionalKey(
    Schema.String.annotate({
      description: "Link the probe to the resource whose output suggested the URL.",
    }),
  ),
  outputKey: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "SyntheticProbeCreate" });

const SyntheticProbeUpdate = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(ProbeMethod),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  timeoutMs: Schema.optionalKey(TimeoutMs),
  failureThreshold: Schema.optionalKey(FailureThreshold),
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "SyntheticProbeUpdate" });

const ProbeSuggestion = Schema.Struct({
  url: Schema.String.annotate({
    description: "Normalized to an absolute URL, bare hosts get https://.",
  }),
  resourceId: Schema.String,
  displayName: Schema.String,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  accountId: Uuid,
  outputKey: Schema.String.annotate({
    description: "The output/field key the URL was mined from.",
  }),
}).annotate({ identifier: "ProbeSuggestion" });

export const ProbeSuggestions = Schema.Struct({
  suggestions: Schema.Array(ProbeSuggestion),
}).annotate({ identifier: "ProbeSuggestions" });

const ProbeMetricSeries = Schema.Struct({
  label: Schema.String.annotate({ description: '"Latency" (ms) or "Up" (1/0).' }),
  unit: Schema.optionalKey(Schema.String),
  points: Schema.Array(
    Schema.Struct({
      timestamp: Schema.Finite.annotate({ description: "Unix epoch milliseconds." }),
      value: Schema.Finite,
    }),
  ),
}).annotate({ identifier: "ProbeMetricSeries" });

export const ProbeMetrics = Schema.Struct({
  series: Schema.Array(ProbeMetricSeries),
}).annotate({ identifier: "ProbeMetrics" });

const ProbeParams = { orgId: OrgId, probeId: Uuid } as const;

export class ProbesGroup extends HttpApiGroup.make("probes")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: SyntheticProbeList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List synthetic probes")
      .annotate(
        OpenApi.Description,
        "Every probe in the organization with its live status, consecutive-failure count, last " +
          "latency and trailing-24h uptime. Probes run on an interval from an edge proxy outside " +
          "the cluster, so results reflect what an internet client would see.",
      )
      .annotate(SuccessDescription, "The organization's probes"),
    HttpApiEndpoint.get("suggestions", "/suggestions", {
      params: OrgParams,
      success: ProbeSuggestions,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Suggest endpoints from synced resources")
      .annotate(
        OpenApi.Description,
        "Endpoint candidates mined from the organization's synced resource outputs and fields " +
          "(keys like url, endpoint, host, domain, publicIp). A cheap read over stored state; no " +
          "provider API calls. Deduplicated by URL.",
      )
      .annotate(SuccessDescription, "Suggested endpoints"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: SyntheticProbeCreate,
      success: SyntheticProbe.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a probe")
      .annotate(
        OpenApi.Description,
        "Point an uptime/latency check at an endpoint. Numeric inputs are clamped into their " +
          "allowed ranges rather than rejected; the first check runs within one poller tick. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The created probe")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.put("update", "/:probeId", {
      params: ProbeParams,
      payload: SyntheticProbeUpdate,
      success: SyntheticProbe,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update or disable a probe")
      .annotate(
        OpenApi.Description,
        "Edit settings and/or toggle `enabled`. Changing the URL or method resets the probe's " +
          "state to `unknown`: the history belongs to the old endpoint. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated probe")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:probeId", {
      params: ProbeParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a probe")
      .annotate(
        OpenApi.Description,
        "Remove the probe. Recorded series age out of the metric store. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("metrics", "/:probeId/metrics", {
      params: ProbeParams,
      query: {
        startMs: Schema.optionalKey(
          Schema.String.annotate({ description: "Range start, Unix epoch ms." }),
        ),
        endMs: Schema.optionalKey(
          Schema.String.annotate({ description: "Range end, Unix epoch ms." }),
        ),
      },
      success: ProbeMetrics,
      error: [BadRequest, NotFound, ServiceUnavailable],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a probe's recorded series")
      .annotate(
        OpenApi.Description,
        'The "Latency" (ms) and "Up" (1/0) series over a time range, from the shared metric ' +
          "store. Resolution auto-selects raw/1-minute/1-hour rollups by span. Defaults to the " +
          "trailing 24 hours.",
      )
      .annotate(SuccessDescription, "The recorded series"),
  )
  .prefix("/api/org/:orgId/probes")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Synthetic probes") {}

export class ProbesApi extends withApiDefaults(HttpApi.make("probes").add(ProbesGroup)) {}
