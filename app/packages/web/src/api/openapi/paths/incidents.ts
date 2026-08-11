import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * Incident mode — incidents the organization declares itself.
 *
 * Deliberately distinct from `/status-incidents`, which reports a *provider's*
 * outage scraped from their status page. Nothing in this file describes that.
 */

const IncidentSeverity = z.enum(["sev1", "sev2", "sev3", "sev4"]).openapi({
  description:
    "Severity in the ordinary sev1..sev4 register. `sev1` is a complete outage; " +
    "`sev4` is cosmetic and tracked rather than paged.",
  example: "sev2",
});

const IncidentStatus = z.enum(["open", "mitigated", "resolved"]).openapi({
  description:
    "`mitigated` is a real state, not a synonym for resolved: impact has stopped but the " +
    "incident is still open for follow-up. Keeping it separate is what makes time-to-mitigate " +
    "a measurement rather than a guess. Resolving runs the resolve path — the change freeze " +
    "this incident opened is lifted, and the status-page update it posted is closed.",
});

const ArtifactKind = z.enum(["freeze", "moment", "slack", "status-page"]).openapi({
  description: "Which side effect of declaring this artefact records.",
});

const ArtifactStatus = z.enum(["created", "failed", "closed"]).openapi({
  description:
    "`failed` is a stored state, not an error: declaring writes the incident first and attempts " +
    "each opted-in side effect afterwards, so a Slack outage costs the announcement and never " +
    "the incident. A failed artefact carries its error and can be retried.",
});

export function registerIncidentPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const IncidentArtifact = strict({
    id: Uuid,
    kind: ArtifactKind,
    status: ArtifactStatus,
    label: z.string().nullable().describe("Human label — the freeze name, the destination count."),
    refId: Uuid.or(z.string()).nullable().describe("Freeze id, notice id, Slack channel id…"),
    refSecondary: z
      .string()
      .nullable()
      .describe("Second half of a compound reference — a Slack message ts, a window width."),
    error: z.string().nullable().describe("Why it failed. Null unless `status` is `failed`."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("IncidentArtifact");

  const Incident = strict({
    id: Uuid,
    title: z.string(),
    severity: IncidentSeverity,
    status: IncidentStatus,
    summary: z.string().nullable(),
    startedAt: IsoDateTime.describe("Backdatable — people declare after they start firefighting."),
    mitigatedAt: IsoDateTime.nullable(),
    resolvedAt: IsoDateTime.nullable(),
    declaredByUserId: z.string().nullable(),
    declaredByName: z.string().nullable(),
    resolvedByUserId: z.string().nullable(),
    affectedResourceIds: z
      .array(z.string())
      .describe("Advisory. Not foreign keys — the claim must survive the resource being deleted."),
    affectedAccountIds: z.array(Uuid),
    issueUrl: z.string().nullable().describe("Where the write-up was filed, once anyone filed it."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    artifacts: z.array(IncidentArtifact),
    noteCount: z.number().int(),
  }).openapi("Incident");

  const IncidentList = strict({ incidents: z.array(Incident) }).openapi("IncidentList");

  const IncidentNote = strict({
    id: Uuid,
    body: z.string(),
    authorUserId: z.string().nullable(),
    authorName: z.string().nullable(),
    occurredAt: IsoDateTime.describe(
      "When the note is *about*, which may precede when it was written — a note typed at 04:00 " +
        "can be dated to 03:14 and lands there on the timeline.",
    ),
    createdAt: IsoDateTime,
  }).openapi("IncidentNote");

  const IncidentDetail = strict({
    incident: Incident,
    notes: z.array(IncidentNote),
  }).openapi("IncidentDetail");

  const IncidentActions = strict({
    openFreeze: z
      .boolean()
      .optional()
      .describe(
        "Open an org change freeze for the duration, lifted when the incident resolves. " +
          "Defaults to false — freezing has blast radius beyond the incident. Needs " +
          "`freezes:write`; without it the freeze is recorded as a failed artefact naming the " +
          "permission, and the incident still stands.",
      ),
    pinMoment: z
      .boolean()
      .optional()
      .describe(
        "Pin the moment (a timestamp and a window) so `GET /moment` is one click away. " +
          "Defaults to true — it cannot fail, and the investigation always wants it.",
      ),
    postSlack: z
      .boolean()
      .optional()
      .describe(
        "Announce through the org's alert routing rules under the `incidentAlerts` trigger, so " +
          "channels, quiet hours, escalation and the acknowledge button all apply unchanged. " +
          "Defaults to true. If no rule matches, the artefact fails and says so.",
      ),
    statusPageId: Uuid.nullable()
      .optional()
      .describe("Post a public update on this status page. Omitted means no public update."),
    statusPageComponentIds: z
      .array(Uuid)
      .optional()
      .describe("Components on that page to mark affected. Empty means the page as a whole."),
  }).openapi("IncidentActions");

  const IncidentDeclare = strict({
    title: z.string(),
    severity: IncidentSeverity.optional(),
    summary: z.string().nullable().optional(),
    startedAt: IsoDateTime.optional().describe("Defaults to now."),
    affectedResourceIds: z.array(z.string()).optional(),
    affectedAccountIds: z.array(Uuid).optional(),
    actions: IncidentActions.optional(),
  }).openapi("IncidentDeclare");

  const IncidentPatch = strict({
    title: z.string().optional(),
    severity: IncidentSeverity.optional(),
    status: IncidentStatus.optional(),
    summary: z.string().nullable().optional(),
    affectedResourceIds: z.array(z.string()).optional(),
    affectedAccountIds: z.array(Uuid).optional(),
    issueUrl: z.string().nullable().optional(),
  }).openapi("IncidentPatch");

  const IncidentNoteCreate = strict({
    body: z.string(),
    occurredAt: IsoDateTime.optional().describe("Defaults to now; backdate to place the note."),
  }).openapi("IncidentNoteCreate");

  const IncidentTimelineEntry = strict({
    id: z.string(),
    source: z.enum(["incident", "note", "artifact", "moment", "probe", "metric-alert"]).openapi({
      description:
        "`moment` covers everything the moment union already indexes — resource changes, " +
        "deployments, cost anomalies, provider status incidents, audit entries, change freezes " +
        "and workflow runs. Nothing is copied into the incident's own tables; the timeline is a " +
        "join, so re-reading it reflects the record as it stands today.",
    }),
    kind: z.string().describe("`<noun>.<verb>`. Open set — render unknown kinds generically."),
    at: IsoDateTime,
    title: z.string(),
    detail: z.string().nullable().optional(),
    severity: z.enum(["info", "warning", "critical"]),
    authorName: z.string().nullable().optional(),
    resourceId: z.string().nullable().optional(),
    resourceName: z.string().nullable().optional(),
    pluginId: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
    link: strict({
      kind: z.enum([
        "resource",
        "changes",
        "provider-incident",
        "costs",
        "workflow-run",
        "deployment",
        "audit",
        "freeze",
        "expiring",
        "probe",
        "metric-alert",
        "incident",
      ]),
      id: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    })
      .nullable()
      .optional(),
  }).openapi("IncidentTimelineEntry");

  const IncidentTimeline = strict({
    incidentId: Uuid,
    from: IsoDateTime,
    to: IsoDateTime.describe("`resolvedAt`, or the server's clock while the incident is open."),
    generatedAt: IsoDateTime,
    entries: z.array(IncidentTimelineEntry),
    feeds: z
      .array(
        strict({
          feed: z.string(),
          status: z.enum(["ok", "omitted", "error"]),
          error: z.string().nullable().optional(),
        }),
      )
      .describe(
        "Per-feed health, passed through from the moment union: `omitted` means the caller lacks " +
          "that feed's read permission, `error` means it failed and the rest is still good.",
      ),
    truncated: z.boolean(),
  }).openapi("IncidentTimeline");

  const IncidentPostmortem = strict({
    markdown: z.string(),
    filename: z.string(),
  }).openapi("IncidentPostmortem");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/incidents",
    tags: ["Incidents"],
    summary: "List declared incidents",
    description:
      "Every incident the organization has declared, newest first, each with the artefacts its " +
      "declaration created — including the ones that failed.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: z
          .string()
          .optional()
          .describe("`open`, `mitigated`, `resolved`, or `all` (the default)."),
      }),
    },
    responses: {
      200: {
        description: "The organization's incidents",
        content: { "application/json": { schema: IncidentList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/incidents",
    tags: ["Incidents"],
    summary: "Declare an incident",
    description:
      "Record the incident and perform the opted-in side effects. The incident row is written " +
      "first and alone: a 201 means it exists, and the `artifacts` array on the response says " +
      "what else happened. No side effect can lose the declaration, and none is swallowed. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: IncidentDeclare } } },
    },
    responses: {
      201: {
        description: "The declared incident, re-read after its artefacts settled",
        content: { "application/json": { schema: Incident } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/incidents/{incidentId}",
    tags: ["Incidents"],
    summary: "Read one incident",
    description: "The incident with its artefacts and its operator notes.",
    request: { params: OrgIdParam.extend({ incidentId: Uuid }) },
    responses: {
      200: {
        description: "The incident",
        content: { "application/json": { schema: IncidentDetail } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/incidents/{incidentId}",
    tags: ["Incidents"],
    summary: "Edit or transition an incident",
    description:
      "Omitted fields keep their value. Setting `status` stamps the matching timestamp, and " +
      "resolving undoes exactly what this incident created — the freeze whose id is on its own " +
      "artefact, not whatever freeze happens to be in effect. Resolving an incident that was " +
      "never marked mitigated back-fills `mitigatedAt` from `resolvedAt`. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ incidentId: Uuid }),
      body: { content: { "application/json": { schema: IncidentPatch } } },
    },
    responses: {
      200: {
        description: "The updated incident",
        content: { "application/json": { schema: Incident } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/incidents/{incidentId}",
    tags: ["Incidents"],
    summary: "Delete an incident",
    description:
      "Removes the incident, its notes and its artefact records. It does not lift a freeze or " +
      "close a status-page update — resolve for that; deleting is for a mis-declaration. " +
      "Audit-logged.",
    request: { params: OrgIdParam.extend({ incidentId: Uuid }) },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/incidents/{incidentId}/retry-artifacts",
    tags: ["Incidents"],
    summary: "Retry the artefacts that failed",
    description:
      "Re-runs only the side effects whose artefact is in the `failed` state, replacing each " +
      "failure rather than queueing a second attempt beside it. Its own endpoint rather than a " +
      "flag on PATCH, because it writes into three external systems. Audit-logged.",
    request: { params: OrgIdParam.extend({ incidentId: Uuid }) },
    responses: {
      200: {
        description: "The incident with its artefacts re-read",
        content: { "application/json": { schema: Incident } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/incidents/{incidentId}/timeline",
    tags: ["Incidents"],
    summary: "Assemble the incident's timeline",
    description:
      "Merged on read from what is already recorded between the incident's start and its " +
      "resolution: resource changes, deployments, cost anomalies, provider status incidents, " +
      "audit entries, change freezes and workflow runs (all via the same union the Moment " +
      "screen uses), plus probe state transitions, metric-alert firings, the incident's own " +
      "life events, its artefacts and its operator notes. Nothing is copied — a correction " +
      "upstream shows up here on the next read.\n\n" +
      "Probe transitions are an approximation: `synthetic_probes` keeps only a single " +
      "`lastStateChangeAt`, so a probe that flapped twice inside the window contributes its " +
      "most recent flip and no more.",
    request: { params: OrgIdParam.extend({ incidentId: Uuid }) },
    responses: {
      200: {
        description: "The merged timeline",
        content: { "application/json": { schema: IncidentTimeline } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/incidents/{incidentId}/postmortem",
    tags: ["Incidents"],
    summary: "Export a pre-filled postmortem",
    description:
      "Markdown with the timeline, the affected resources, the duration, the time to mitigate " +
      "and the notes already filled in. The analysis headings — impact, root cause, action " +
      "items — are deliberately left blank: a generated document that guesses at a root cause " +
      "is worse than one that leaves a heading.",
    request: { params: OrgIdParam.extend({ incidentId: Uuid }) },
    responses: {
      200: {
        description: "The postmortem document",
        content: { "application/json": { schema: IncidentPostmortem } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/incidents/{incidentId}/notes",
    tags: ["Incidents"],
    summary: "Add an operator note",
    description:
      "The running commentary no join can reconstruct. `occurredAt` may be backdated so a note " +
      "typed at 04:00 lands on the timeline where it belongs.",
    request: {
      params: OrgIdParam.extend({ incidentId: Uuid }),
      body: { content: { "application/json": { schema: IncidentNoteCreate } } },
    },
    responses: {
      201: {
        description: "The created note",
        content: { "application/json": { schema: IncidentNote } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/incidents/{incidentId}/notes/{noteId}",
    tags: ["Incidents"],
    summary: "Delete an operator note",
    request: { params: OrgIdParam.extend({ incidentId: Uuid, noteId: Uuid }) },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });
}
