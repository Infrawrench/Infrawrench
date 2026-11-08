/**
 * The moment view: `GET /api/org/:orgId/moment?at=…&window=…`, the endpoint
 * definitions.
 *
 * There is deliberately no `RequiredPermission` gate: the union spans six
 * read permissions and the service omits (not errors) every feed the caller
 * cannot read. The handler refuses only a caller who can read none of them.
 * The document still states `resources:read`, the floor, as it always has.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { DocumentedPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";

const MomentFeedId = Schema.Literals([
  "changes",
  "statusIncidents",
  "costAnomalies",
  "workflowRuns",
  "deployments",
  "audit",
  "freezes",
  "driftAlerts",
  "expiryAlerts",
]).annotate({
  identifier: "MomentFeedId",
  description: "One of the indexed feeds the moment union draws from.",
});

const MomentFeedStatus = Schema.Struct({
  feed: MomentFeedId,
  status: Schema.Literals(["ok", "omitted", "error"]).annotate({
    description:
      "`omitted` = the caller lacks the feed's read permission; `error` = the feed's query " +
      "failed but the rest of the response is still valid (partial-failure tolerance).",
  }),
  error: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Short failure reason when `status` is `error`.",
    }),
  ),
  truncated: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "True when the feed hit its row cap and events were dropped.",
    }),
  ),
}).annotate({ identifier: "MomentFeedStatus" });

const MomentEventLink = Schema.Struct({
  kind: Schema.Literals([
    "resource",
    "changes",
    "incident",
    "costs",
    "workflow-run",
    "deployment",
    "audit",
    "freeze",
    "expiring",
  ]).annotate({ description: "Which native screen the event deep-links to." }),
  id: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Target id where the kind needs one (resource id, run id, freeze id…).",
    }),
  ),
  parentId: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Parent id where the target needs one (workflow id for a run).",
    }),
  ),
  url: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Absolute external URL; a provider's incident page. Wins when present.",
    }),
  ),
}).annotate({ identifier: "MomentEventLink" });

const MomentSeverity = Schema.Literals(["info", "warning", "critical"]).annotate({
  identifier: "MomentSeverity",
});

/** Plain strings, not the live plugin enums: history may reference a removed plugin. */
const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

const MomentEvent = Schema.Struct({
  id: Schema.String.annotate({
    description: "Stable synthetic id, unique within a response (`feed:rowId[:phase]`).",
  }),
  feed: MomentFeedId,
  kind: Schema.String.annotate({
    description:
      "Fine-grained `<noun>.<verb>` kind, e.g. `change.created`, `incident.started`, " +
      "`workflow-run.failed`, `deployment.finished`, `freeze.started`, `drift-alert.sent`. " +
      "Open set: render unknown kinds generically.",
  }),
  timestamp: IsoDateTime,
  title: Schema.String.annotate({ description: "One-line headline." }),
  detail: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description: "Optional second line; diff summary, actor, error text.",
    }),
  ),
  severity: MomentSeverity,
  pluginId: optionalText,
  accountId: optionalText,
  accountName: optionalText,
  resourceId: optionalText,
  resourceTypeId: optionalText,
  resourceName: optionalText,
  link: Schema.optionalKey(Schema.NullOr(MomentEventLink)),
}).annotate({ identifier: "MomentEvent" });

const MomentIncidentSpan = Schema.Struct({
  id: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  title: Schema.String,
  impact: Schema.Literals(["maintenance", "minor", "major", "critical"]),
  startedAt: IsoDateTime,
  resolvedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({
  identifier: "MomentIncidentSpan",
  description:
    "A provider incident whose span overlaps the window; returned alongside the events so " +
    'clients can badge events that fall inside it ("during DigitalOcean incident").',
});

export const MomentResponse = Schema.Struct({
  at: IsoDateTime.annotate({ description: "The centre timestamp, normalized to ISO." }),
  from: IsoDateTime,
  to: IsoDateTime,
  windowMinutes: Schema.Int.annotate({
    description: "The half-window actually applied, after clamping to 1–4320 minutes.",
  }).check(Schema.isGreaterThan(0)),
  generatedAt: IsoDateTime,
  feeds: Schema.Array(MomentFeedStatus).annotate({
    description: "One entry per feed, in canonical order; including omitted and errored feeds.",
  }),
  events: Schema.Array(MomentEvent).annotate({ description: "Chronological, oldest first." }),
  incidents: Schema.Array(MomentIncidentSpan),
}).annotate({ identifier: "MomentResponse" });

export class MomentGroup extends HttpApiGroup.make("moment")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      // Read as sent: the handler parses both and answers with its own sentences.
      query: {
        at: Schema.optionalKey(
          documentedAs(
            IsoDateTime.annotate({ description: "Centre of the window. Defaults to now." }),
          ),
        ),
        window: Schema.optionalKey(
          documentedAs(
            Schema.Int.annotate({
              description:
                "Half-window in minutes (the ± around `at`). Default 60, max 4320 (±3 days).",
            }),
          ),
        ),
      },
      success: MomentResponse,
      error: [BadRequest, Forbidden],
    })
      .annotate(OpenApi.Summary, "Everything that happened around a timestamp")
      .annotate(
        OpenApi.Description,
        '"What changed around 03:14?"; one merged, chronological narrative of everything the ' +
          "platform knows happened in a window: resource changes (including sleep/wake schedule " +
          "attribution), provider status incidents that started/resolved in or overlap the window, " +
          "cost anomalies, workflow runs, deployments, audit-log entries, change freezes, and the " +
          "drift/expiry alert deliveries. Each feed is gated on the same permission its own " +
          "endpoint requires; feeds the caller cannot read are reported as `omitted`, and a feed " +
          "whose query fails is reported as `error` without blanking the rest of the response.",
      )
      .annotate(SuccessDescription, "The merged window")
      // States the documented floor without enforcing it (see the module comment).
      .annotate(DocumentedPermission, "resources:read")
      .annotate(
        OpenApi.Transform,
        numericQuery({ window: { type: "integer", minimum: 1, maximum: 4320 } }),
      ),
  )
  .prefix("/api/org/:orgId/moment")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Moment") {}

export class MomentApi extends withApiDefaults(HttpApi.make("moment").add(MomentGroup)) {}
