/**
 * Incident mode: `/api/org/:orgId/incidents`, the handlers.
 *
 * Bodies are read the way the routes always read them: the store's parsers
 * (`parseIncidentSeverity`, `parseIncidentTimestamp`, ...) own the 400
 * sentences, and anything else a store call throws is a logged
 * `500 { error: "Incident operation failed" }`, through `storeCall`.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { IncidentActions } from "@infrawrench/client-core";
import {
  IncidentInputError,
  deleteIncidentNoteRecord,
  deleteIncidentRecord,
  listIncidentRecords,
  parseIncidentSeverity,
  parseIncidentStatus,
  parseIncidentTimestamp,
} from "@infrawrench/server-core/incidents/store";
import { logAudit } from "../../../services/audit";
import {
  addNote,
  affectedServices,
  assembleIncidentTimeline,
  buildPostmortem,
  declareIncident,
  getIncidentRecord,
  listIncidentNoteRecords,
  patchIncident,
  retryIncidentArtifacts,
  type IncidentActor,
} from "../../../services/incidents";
import { makeDomain } from "../../domain";
import { notFound } from "../../errors";
import { legacy } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { storeCall } from "../store-errors";
import {
  Incident,
  IncidentDetail,
  IncidentList,
  IncidentNote,
  IncidentPostmortem,
  IncidentsApi,
  IncidentTimeline,
} from "./api";

const incidentCall = <A>(fn: () => PromiseLike<A>) =>
  storeCall(
    {
      isInputError: (error): error is IncidentInputError => error instanceof IncidentInputError,
      logPrefix: "[incidents]",
      failure: "Incident operation failed",
    },
    fn,
  );

const incidentNotFound = () => notFound("Incident not found");

const actor = Effect.gen(function* () {
  const { session, permissions } = yield* OrgPrincipal;
  const value: IncidentActor = {
    userId: session.userId ?? null,
    permissions,
    appUrl: process.env["APP_URL"] ?? null,
  };
  return value;
});

function stringArray(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new IncidentInputError("Expected an array of ids.");
  return raw.filter(Predicate.isString);
}

function parseActions(raw: unknown): IncidentActions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Predicate.isObject(raw) || Array.isArray(raw)) {
    throw new IncidentInputError("`actions` must be an object.");
  }
  const actions: IncidentActions = {};
  if (raw["openFreeze"] !== undefined) actions.openFreeze = Boolean(raw["openFreeze"]);
  if (raw["pinMoment"] !== undefined) actions.pinMoment = Boolean(raw["pinMoment"]);
  if (raw["postSlack"] !== undefined) actions.postSlack = Boolean(raw["postSlack"]);
  if (raw["statusPageId"] !== undefined) {
    actions.statusPageId = raw["statusPageId"] ? String(raw["statusPageId"]) : null;
  }
  const componentIds = stringArray(raw["statusPageComponentIds"]);
  if (componentIds) actions.statusPageComponentIds = componentIds;
  return actions;
}

/**
 * A summary as the store takes it. The store stringifies whatever it is
 * given, so stringifying here first changes nothing it stores.
 */
const summaryOf = (raw: unknown): string | null => (raw === null ? null : String(raw));

/** An issue URL as the store takes it: it keeps a truthy one, stringified, and nulls the rest. */
const issueUrlOf = (raw: unknown): string | null => (raw ? String(raw) : null);

const IncidentsHandlers = HttpApiBuilder.group(IncidentsApi, "incidents", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const statusParam = query.status;
        const incidents = yield* incidentCall(async () => {
          const status =
            statusParam && statusParam !== "all" ? parseIncidentStatus(statusParam) : undefined;
          return listIncidentRecords(organizationId, { status });
        });
        return yield* respond(IncidentList)({ incidents });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const incident = yield* legacy(() => getIncidentRecord(organizationId, params.incidentId));
        if (!incident) return yield* incidentNotFound();
        const [notes, services] = yield* legacy(() =>
          Promise.all([
            listIncidentNoteRecords(params.incidentId),
            affectedServices(organizationId, incident.affectedResourceIds),
          ]),
        );
        return yield* respond(IncidentDetail)({ incident, notes, affectedServices: services });
      }),
    )
    .handle("timeline", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const incident = yield* legacy(() => getIncidentRecord(organizationId, params.incidentId));
        if (!incident) return yield* incidentNotFound();
        const by = yield* actor;
        const timeline = yield* incidentCall(() =>
          assembleIncidentTimeline(organizationId, incident, by),
        );
        return yield* respond(IncidentTimeline)(timeline);
      }),
    )
    .handle("postmortem", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const incident = yield* legacy(() => getIncidentRecord(organizationId, params.incidentId));
        if (!incident) return yield* incidentNotFound();
        const by = yield* actor;
        const postmortem = yield* incidentCall(() => buildPostmortem(organizationId, incident, by));
        return yield* respond(IncidentPostmortem)(postmortem);
      }),
    )
    .handleRaw("declare", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const { body } = parsed;
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const incident = yield* incidentCall(async () =>
          declareIncident(
            organizationId,
            {
              title: String(body["title"] ?? ""),
              severity: parseIncidentSeverity(body["severity"]),
              summary: body["summary"] === undefined ? undefined : summaryOf(body["summary"]),
              startedAt: parseIncidentTimestamp(body["startedAt"], "startedAt"),
              affectedResourceIds: stringArray(body["affectedResourceIds"]),
              affectedAccountIds: stringArray(body["affectedAccountIds"]),
              actions: parseActions(body["actions"]),
            },
            by,
          ),
        );
        return yield* respond(Incident, { status: 201 })(incident);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const { body } = parsed;
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const updated = yield* incidentCall(async () =>
          patchIncident(
            organizationId,
            params.incidentId,
            {
              ...(body["title"] === undefined ? {} : { title: String(body["title"]) }),
              ...(body["severity"] === undefined
                ? {}
                : { severity: parseIncidentSeverity(body["severity"]) }),
              ...(body["status"] === undefined
                ? {}
                : { status: parseIncidentStatus(body["status"]) }),
              ...(body["summary"] === undefined ? {} : { summary: summaryOf(body["summary"]) }),
              ...(body["issueUrl"] === undefined ? {} : { issueUrl: issueUrlOf(body["issueUrl"]) }),
              ...(body["affectedResourceIds"] === undefined
                ? {}
                : { affectedResourceIds: stringArray(body["affectedResourceIds"]) }),
              ...(body["affectedAccountIds"] === undefined
                ? {}
                : { affectedAccountIds: stringArray(body["affectedAccountIds"]) }),
            },
            by,
          ),
        );
        if (!updated) return yield* incidentNotFound();
        return yield* respond(Incident)(updated);
      }),
    )
    .handle("retryArtifacts", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const by = yield* actor;
        // The audit write is inside the call, as it was inside the route's
        // `try`: the response waits for it.
        const incident = yield* incidentCall(async () => {
          const retried = await retryIncidentArtifacts(organizationId, params.incidentId, by);
          if (!retried) return null;
          await logAudit({
            organizationId,
            userId: session.userId,
            action: "incident.retry_artifacts",
            entityType: "incident",
            entityId: params.incidentId,
          });
          return retried;
        });
        if (!incident) return yield* incidentNotFound();
        return yield* respond(Incident)(incident);
      }),
    )
    .handleRaw("addNote", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const { body } = parsed;
        const { organizationId } = yield* OrgPrincipal;
        const by = yield* actor;
        const note = yield* incidentCall(async () =>
          addNote(
            organizationId,
            params.incidentId,
            String(body["body"] ?? ""),
            parseIncidentTimestamp(body["occurredAt"], "occurredAt"),
            by,
          ),
        );
        if (!note) return yield* incidentNotFound();
        return yield* respond(IncidentNote, { status: 201 })(note);
      }),
    )
    .handle("deleteNote", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const incident = yield* legacy(() => getIncidentRecord(organizationId, params.incidentId));
        if (!incident) return yield* incidentNotFound();
        const deleted = yield* legacy(() =>
          deleteIncidentNoteRecord(params.incidentId, params.noteId),
        );
        if (!deleted) return yield* notFound("Note not found");
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() =>
          deleteIncidentRecord(organizationId, params.incidentId),
        );
        if (!deleted) return yield* incidentNotFound();
        // Awaited, as the route awaited it: the 204 follows the audit row.
        yield* legacy(async () => {
          await logAudit({
            organizationId,
            userId: session.userId,
            action: "incident.delete",
            entityType: "incident",
            entityId: params.incidentId,
          });
        });
      }),
    ),
);

export const incidentsDomain = makeDomain("incidents", IncidentsApi, IncidentsHandlers);
