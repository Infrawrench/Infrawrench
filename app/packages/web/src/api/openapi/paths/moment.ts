import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const MomentFeedId = z
  .enum([
    "changes",
    "statusIncidents",
    "costAnomalies",
    "workflowRuns",
    "deployments",
    "audit",
    "freezes",
    "driftAlerts",
    "expiryAlerts",
  ])
  .openapi("MomentFeedId", {
    description: "One of the indexed feeds the moment union draws from.",
  });

const MomentFeedStatus = strict({
  feed: MomentFeedId,
  status: z.enum(["ok", "omitted", "error"]).openapi({
    description:
      "`omitted` = the caller lacks the feed's read permission; `error` = the feed's query " +
      "failed but the rest of the response is still valid (partial-failure tolerance).",
  }),
  error: z.string().nullable().optional().openapi({
    description: "Short failure reason when `status` is `error`.",
  }),
  truncated: z.boolean().optional().openapi({
    description: "True when the feed hit its row cap and events were dropped.",
  }),
}).openapi("MomentFeedStatus");

const MomentEventLink = strict({
  kind: z
    .enum([
      "resource",
      "changes",
      "incident",
      "costs",
      "workflow-run",
      "deployment",
      "audit",
      "freeze",
      "expiring",
    ])
    .openapi({
      description: "Which native screen the event deep-links to.",
    }),
  id: z.string().nullable().optional().openapi({
    description: "Target id where the kind needs one (resource id, run id, freeze id…).",
  }),
  parentId: z.string().nullable().optional().openapi({
    description: "Parent id where the target needs one (workflow id for a run).",
  }),
  url: z.string().nullable().optional().openapi({
    description: "Absolute external URL — a provider's incident page. Wins when present.",
  }),
}).openapi("MomentEventLink");

const MomentEvent = strict({
  id: z.string().openapi({
    description: "Stable synthetic id, unique within a response (`feed:rowId[:phase]`).",
  }),
  feed: MomentFeedId,
  kind: z.string().openapi({
    description:
      "Fine-grained `<noun>.<verb>` kind, e.g. `change.created`, `incident.started`, " +
      "`workflow-run.failed`, `deployment.finished`, `freeze.started`, `drift-alert.sent`. " +
      "Open set — render unknown kinds generically.",
  }),
  timestamp: IsoDateTime,
  title: z.string().openapi({ description: "One-line headline." }),
  detail: z.string().nullable().optional().openapi({
    description: "Optional second line — diff summary, actor, error text.",
  }),
  severity: z.enum(["info", "warning", "critical"]).openapi("MomentSeverity"),
  /** Plain strings, not the live plugin enums: history may reference a removed plugin. */
  pluginId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  accountName: z.string().nullable().optional(),
  resourceId: z.string().nullable().optional(),
  resourceTypeId: z.string().nullable().optional(),
  resourceName: z.string().nullable().optional(),
  link: MomentEventLink.nullable().optional(),
}).openapi("MomentEvent");

const MomentIncidentSpan = strict({
  id: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  title: z.string(),
  impact: z.enum(["maintenance", "minor", "major", "critical"]),
  startedAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable().optional(),
  url: z.string().nullable().optional(),
}).openapi("MomentIncidentSpan", {
  description:
    "A provider incident whose span overlaps the window — returned alongside the events so " +
    'clients can badge events that fall inside it ("during DigitalOcean incident").',
});

const MomentResponse = strict({
  at: IsoDateTime.openapi({ description: "The centre timestamp, normalized to ISO." }),
  from: IsoDateTime,
  to: IsoDateTime,
  windowMinutes: z.number().int().positive().openapi({
    description: "The half-window actually applied, after clamping to 1–4320 minutes.",
  }),
  generatedAt: IsoDateTime,
  feeds: z.array(MomentFeedStatus).openapi({
    description: "One entry per feed, in canonical order — including omitted and errored feeds.",
  }),
  events: z.array(MomentEvent).openapi({ description: "Chronological, oldest first." }),
  incidents: z.array(MomentIncidentSpan),
}).openapi("MomentResponse");

export function registerMomentPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/moment",
    tags: ["Moment"],
    summary: "Everything that happened around a timestamp",
    description:
      '"What changed around 03:14?" — one merged, chronological narrative of everything the ' +
      "platform knows happened in a window: resource changes (including sleep/wake schedule " +
      "attribution), provider status incidents that started/resolved in or overlap the window, " +
      "cost anomalies, workflow runs, deployments, audit-log entries, change freezes, and the " +
      "drift/expiry alert deliveries. Each feed is gated on the same permission its own " +
      "endpoint requires; feeds the caller cannot read are reported as `omitted`, and a feed " +
      "whose query fails is reported as `error` without blanking the rest of the response.",
    request: {
      params: OrgIdParam,
      query: strict({
        at: IsoDateTime.optional().openapi({
          param: { name: "at", in: "query" },
          description: "Centre of the window. Defaults to now.",
        }),
        window: z.coerce
          .number()
          .int()
          .min(1)
          .max(4320)
          .optional()
          .openapi({
            param: { name: "window", in: "query" },
            description:
              "Half-window in minutes (the ± around `at`). Default 60, max 4320 (±3 days).",
          }),
      }),
    },
    responses: {
      200: {
        description: "The merged window",
        content: { "application/json": { schema: MomentResponse } },
      },
      400: ErrorResponses[400],
    },
  });
}
