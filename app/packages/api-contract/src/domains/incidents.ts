/**
 * Incident mode: `/api/org/:orgId/incidents`, the endpoint definitions.
 *
 * Incidents the organization declares itself; deliberately distinct from
 * `/status-incidents`, which reports a provider's outage scraped from their
 * status page.
 *
 * Permissions are `incidents:read` / `incidents:write`, both held by members:
 * the people who notice an outage at 03:14 are rarely admins. The governance
 * side effects keep their own gates (opening a change freeze still needs
 * `freezes:write`).
 *
 * The write bodies are documented here and read by hand in the handlers, as
 * the routes always did (the store's parsers own the 400 sentences), so those
 * endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";

const IncidentSeverity = Schema.Literals(["sev1", "sev2", "sev3", "sev4"]).annotate({
  description:
    "Severity in the ordinary sev1..sev4 register. `sev1` is a complete outage; " +
    "`sev4` is cosmetic and tracked rather than paged.",
  examples: ["sev2"],
});

const IncidentStatus = Schema.Literals(["open", "mitigated", "resolved"]).annotate({
  description:
    "`mitigated` is a real state, not a synonym for resolved: impact has stopped but the " +
    "incident is still open for follow-up. Keeping it separate is what makes time-to-mitigate " +
    "a measurement rather than a guess. Resolving runs the resolve path; the change freeze " +
    "this incident opened is lifted, and the status-page update it posted is closed.",
});

const ArtifactKind = Schema.Literals(["freeze", "moment", "slack", "status-page"]).annotate({
  description: "Which side effect of declaring this artefact records.",
});

const ArtifactStatus = Schema.Literals(["created", "failed", "closed", "close_failed"]).annotate({
  description:
    "`failed` is a stored state, not an error: declaring writes the incident first and attempts " +
    "each opted-in side effect afterwards, so a Slack outage costs the announcement and never " +
    "the incident. A failed artefact carries its error and can be retried.\n\n" +
    "`close_failed` is the other half and is deliberately distinct: the artefact **was** created " +
    "and resolving could not put it away, so the change freeze is still in force or the public " +
    "notice still reports an outage. Retrying a `failed` artefact re-creates it; retrying a " +
    "`close_failed` one re-closes it. Collapsing the two would either strand the incident with a " +
    "live freeze nothing can lift, or open a second freeze.",
});

const ArtifactRequest = Schema.Struct({
  statusPageId: Schema.optionalKey(Schema.NullOr(Uuid)),
  componentIds: Schema.optionalKey(Schema.Array(Uuid)),
}).annotate({
  identifier: "IncidentArtifactRequest",
  description:
    "What the declaration asked for, recorded so a retry asks for the same thing. Present on " +
    "the status-page artefact, where a retry that forgot the operator's chosen components " +
    "would publish the outage against the whole page.",
});

const IncidentArtifact = Schema.Struct({
  id: Uuid,
  kind: ArtifactKind,
  status: ArtifactStatus,
  label: Schema.NullOr(Schema.String).annotate({
    description: "Human label: the freeze name, the destination count.",
  }),
  refId: Schema.NullOr(Schema.Union([Uuid, Schema.String])).annotate({
    description: "Freeze id, notice id, Slack channel id…",
  }),
  refSecondary: Schema.NullOr(Schema.String).annotate({
    description: "Second half of a compound reference; a Slack message ts, a window width.",
  }),
  error: Schema.NullOr(Schema.String).annotate({
    description: "Why it failed. Null unless `status` is `failed` or `close_failed`.",
  }),
  request: Schema.NullOr(ArtifactRequest),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "IncidentArtifact" });

export const Incident = Schema.Struct({
  id: Uuid,
  title: Schema.String,
  severity: IncidentSeverity,
  status: IncidentStatus,
  summary: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime.annotate({
    description: "Backdatable: people declare after they start firefighting.",
  }),
  mitigatedAt: Schema.NullOr(IsoDateTime),
  resolvedAt: Schema.NullOr(IsoDateTime),
  declaredByUserId: Schema.NullOr(Schema.String),
  declaredByName: Schema.NullOr(Schema.String),
  resolvedByUserId: Schema.NullOr(Schema.String),
  affectedResourceIds: Schema.Array(Schema.String).annotate({
    description: "Advisory. Not foreign keys; the claim must survive the resource being deleted.",
  }),
  affectedAccountIds: Schema.Array(Uuid),
  issueUrl: Schema.NullOr(Schema.String).annotate({
    description: "Where the write-up was filed, once anyone filed it.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  artifacts: Schema.Array(IncidentArtifact),
  noteCount: Schema.Int,
}).annotate({ identifier: "Incident" });

export const IncidentList = Schema.Struct({ incidents: Schema.Array(Incident) }).annotate({
  identifier: "IncidentList",
});

export const IncidentNote = Schema.Struct({
  id: Uuid,
  body: Schema.String,
  authorUserId: Schema.NullOr(Schema.String),
  authorName: Schema.NullOr(Schema.String),
  occurredAt: IsoDateTime.annotate({
    description:
      "When the note is *about*, which may precede when it was written; a note typed at 04:00 " +
      "can be dated to 03:14 and lands there on the timeline.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "IncidentNote" });

export const IncidentDetail = Schema.Struct({
  incident: Incident,
  notes: Schema.Array(IncidentNote),
  affectedServices: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      slug: Schema.String,
      tier: Schema.NullOr(Schema.Literals([1, 2, 3, 4])),
    }),
  ).annotate({ description: "Services the affected resources belong to, resolved on read." }),
}).annotate({ identifier: "IncidentDetail" });

const IncidentActions = Schema.Struct({
  openFreeze: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Open an org change freeze for the duration, lifted when the incident resolves. " +
        "Defaults to false; freezing has blast radius beyond the incident. Needs " +
        "`freezes:write`; without it the freeze is recorded as a failed artefact naming the " +
        "permission, and the incident still stands.",
    }),
  ),
  pinMoment: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Pin the moment (a timestamp and a window) so `GET /moment` is one click away. " +
        "Defaults to true; it cannot fail, and the investigation always wants it.",
    }),
  ),
  postSlack: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Announce through the org's alert routing rules under the `incidentAlerts` trigger, so " +
        "channels, quiet hours, escalation and the acknowledge button all apply unchanged. " +
        "Defaults to true. If no rule matches, the artefact fails and says so.",
    }),
  ),
  statusPageId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description: "Post a public update on this status page. Omitted means no public update.",
    }),
  ),
  statusPageComponentIds: Schema.optionalKey(
    Schema.Array(Uuid).annotate({
      description: "Components on that page to mark affected. Empty means the page as a whole.",
    }),
  ),
}).annotate({ identifier: "IncidentActions" });

const IncidentDeclare = Schema.Struct({
  title: Schema.String,
  severity: Schema.optionalKey(IncidentSeverity),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  startedAt: Schema.optionalKey(IsoDateTime.annotate({ description: "Defaults to now." })),
  affectedResourceIds: Schema.optionalKey(Schema.Array(Schema.String)),
  affectedAccountIds: Schema.optionalKey(Schema.Array(Uuid)),
  actions: Schema.optionalKey(IncidentActions),
}).annotate({ identifier: "IncidentDeclare" });

const IncidentPatch = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(IncidentSeverity),
  status: Schema.optionalKey(IncidentStatus),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  affectedResourceIds: Schema.optionalKey(Schema.Array(Schema.String)),
  affectedAccountIds: Schema.optionalKey(Schema.Array(Uuid)),
  issueUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "IncidentPatch" });

const IncidentNoteCreate = Schema.Struct({
  body: Schema.String,
  occurredAt: Schema.optionalKey(
    IsoDateTime.annotate({ description: "Defaults to now; backdate to place the note." }),
  ),
}).annotate({ identifier: "IncidentNoteCreate" });

const IncidentTimelineEntry = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals([
    "incident",
    "note",
    "artifact",
    "moment",
    "probe",
    "metric-alert",
  ]).annotate({
    description:
      "`moment` covers everything the moment union already indexes; resource changes, " +
      "deployments, cost anomalies, provider status incidents, audit entries, change freezes " +
      "and workflow runs. Nothing is copied into the incident's own tables; the timeline is a " +
      "join, so re-reading it reflects the record as it stands today.",
  }),
  kind: Schema.String.annotate({
    description: "`<noun>.<verb>`. Open set: render unknown kinds generically.",
  }),
  at: IsoDateTime,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  severity: Schema.Literals(["info", "warning", "critical"]),
  authorName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resourceId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resourceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pluginId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  accountId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  link: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        kind: Schema.Literals([
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
        id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        url: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
}).annotate({ identifier: "IncidentTimelineEntry" });

export const IncidentTimeline = Schema.Struct({
  incidentId: Uuid,
  from: IsoDateTime,
  to: IsoDateTime.annotate({
    description: "`resolvedAt`, or the server's clock while the incident is open.",
  }),
  generatedAt: IsoDateTime,
  entries: Schema.Array(IncidentTimelineEntry),
  feeds: Schema.Array(
    Schema.Struct({
      feed: Schema.String,
      status: Schema.Literals(["ok", "omitted", "error"]),
      error: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ).annotate({
    description:
      "Per-feed health, passed through from the moment union: `omitted` means the caller lacks " +
      "that feed's read permission, `error` means it failed and the rest is still good.",
  }),
  truncated: Schema.Boolean,
}).annotate({ identifier: "IncidentTimeline" });

export const IncidentPostmortem = Schema.Struct({
  markdown: Schema.String,
  filename: Schema.String,
}).annotate({ identifier: "IncidentPostmortem" });

const IncidentParams = { orgId: OrgId, incidentId: Uuid } as const;

/** The store's input errors carry 400, 404 or 409. */
const StoreErrors = [BadRequest, NotFound, Conflict] as const;

export class IncidentsGroup extends HttpApiGroup.make("incidents")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        status: Schema.optionalKey(
          Schema.String.annotate({
            description: "`open`, `mitigated`, `resolved`, or `all` (the default).",
          }),
        ),
      },
      success: IncidentList,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:read")
      .annotate(OpenApi.Summary, "List declared incidents")
      .annotate(
        OpenApi.Description,
        "Every incident the organization has declared, newest first, each with the artefacts its " +
          "declaration created: including the ones that failed.",
      )
      .annotate(SuccessDescription, "The organization's incidents"),
    HttpApiEndpoint.post("declare", "/", {
      params: OrgParams,
      payload: IncidentDeclare,
      success: Incident.pipe(HttpApiSchema.status(201)),
      error: [...StoreErrors, Forbidden],
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Declare an incident")
      .annotate(
        OpenApi.Description,
        "Record the incident and perform the opted-in side effects. The incident row is written " +
          "first and alone: a 201 means it exists, and the `artifacts` array on the response says " +
          "what else happened. No side effect can lose the declaration, and none is swallowed. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The declared incident, re-read after its artefacts settled"),
    HttpApiEndpoint.get("get", "/:incidentId", {
      params: IncidentParams,
      success: IncidentDetail,
      error: NotFound,
    })
      .annotate(RequiredPermission, "incidents:read")
      .annotate(OpenApi.Summary, "Read one incident")
      .annotate(OpenApi.Description, "The incident with its artefacts and its operator notes.")
      .annotate(SuccessDescription, "The incident"),
    HttpApiEndpoint.patch("update", "/:incidentId", {
      params: IncidentParams,
      payload: IncidentPatch,
      success: Incident,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Edit or transition an incident")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value. Setting `status` stamps the matching timestamp, and " +
          "resolving undoes exactly what this incident created; the freeze whose id is on its own " +
          "artefact, not whatever freeze happens to be in effect. Resolving an incident that was " +
          "never marked mitigated back-fills `mitigatedAt` from `resolvedAt`. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated incident"),
    HttpApiEndpoint.delete("delete", "/:incidentId", {
      params: IncidentParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Delete an incident")
      .annotate(
        OpenApi.Description,
        "Removes the incident, its notes and its artefact records. It does not lift a freeze or " +
          "close a status-page update, resolve for that; deleting is for a mis-declaration. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
    // Its own endpoint rather than a flag on PATCH: retrying is an action with
    // side effects in three external systems, and it should not be something
    // an ordinary edit can trigger by accident.
    HttpApiEndpoint.post("retryArtifacts", "/:incidentId/retry-artifacts", {
      params: IncidentParams,
      success: Incident,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Retry the artefacts that failed")
      .annotate(
        OpenApi.Description,
        "Re-runs only the side effects whose artefact is in a failure state, replacing each " +
          "failure rather than queueing a second attempt beside it. A `failed` artefact is " +
          "**re-created**; a `close_failed` one is **re-closed**; re-creating the latter would open " +
          "a second change freeze or post a duplicate public notice. A status-page retry reuses the " +
          "components recorded on the artefact's `request`, so the announcement keeps its original " +
          "scope. Its own endpoint rather than a flag on PATCH, because it writes into three " +
          "external systems. Audit-logged.",
      )
      .annotate(SuccessDescription, "The incident with its artefacts re-read"),
    HttpApiEndpoint.get("timeline", "/:incidentId/timeline", {
      params: IncidentParams,
      success: IncidentTimeline,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:read")
      .annotate(OpenApi.Summary, "Assemble the incident's timeline")
      .annotate(
        OpenApi.Description,
        "Merged on read from what is already recorded between the incident's start and its " +
          "resolution: resource changes, deployments, cost anomalies, provider status incidents, " +
          "audit entries, change freezes and workflow runs (all via the same union the Moment " +
          "screen uses), plus probe state transitions, metric-alert firings, the incident's own " +
          "life events, its artefacts and its operator notes. Nothing is copied; a correction " +
          "upstream shows up here on the next read.\n\n" +
          "Probe transitions are an approximation: `synthetic_probes` keeps only a single " +
          "`lastStateChangeAt`, so a probe that flapped twice inside the window contributes its " +
          "most recent flip and no more.",
      )
      .annotate(SuccessDescription, "The merged timeline"),
    HttpApiEndpoint.get("postmortem", "/:incidentId/postmortem", {
      params: IncidentParams,
      success: IncidentPostmortem,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:read")
      .annotate(OpenApi.Summary, "Export a pre-filled postmortem")
      .annotate(
        OpenApi.Description,
        "Markdown with the timeline, the affected resources, the duration, the time to mitigate " +
          "and the notes already filled in. The analysis headings (impact, root cause, action " +
          "items) are deliberately left blank: a generated document that guesses at a root cause " +
          "is worse than one that leaves a heading.",
      )
      .annotate(SuccessDescription, "The postmortem document"),
    HttpApiEndpoint.post("addNote", "/:incidentId/notes", {
      params: IncidentParams,
      payload: IncidentNoteCreate,
      success: IncidentNote.pipe(HttpApiSchema.status(201)),
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Add an operator note")
      .annotate(
        OpenApi.Description,
        "The running commentary no join can reconstruct. `occurredAt` may be backdated so a note " +
          "typed at 04:00 lands on the timeline where it belongs.",
      )
      .annotate(SuccessDescription, "The created note"),
    HttpApiEndpoint.delete("deleteNote", "/:incidentId/notes/:noteId", {
      params: { ...IncidentParams, noteId: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "incidents:write")
      .annotate(OpenApi.Summary, "Delete an operator note")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/incidents")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Incidents") {}

export class IncidentsApi extends withApiDefaults(HttpApi.make("incidents").add(IncidentsGroup)) {}
