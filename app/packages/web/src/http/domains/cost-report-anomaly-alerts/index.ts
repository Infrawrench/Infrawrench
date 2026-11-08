/**
 * Anomaly alerts scoped to one cost report, the handlers. The detector and
 * the store live in `server-core/src/cost/report-anomaly-alerts.ts`; the
 * destination checks are the alert routing ones (`alerts/destinations.ts`).
 */
import { Effect, Layer, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  costReportAnomalyAlertProblem,
  type AlertDestination,
  type CostReportAnomalyAlertInput,
} from "@infrawrench/client-core";
import {
  ReportAnomalyAlertError,
  deleteReportAnomalyAlert,
  getReportAnomalyAlert,
  listReportAnomalyAlerts,
  upsertReportAnomalyAlert,
} from "@infrawrench/server-core/cost/report-anomaly-alerts";
import {
  canonicalDestination,
  destinationShapeError,
  foreignDestinationError,
  loadDestinationCatalog,
  loadOwnedDestinations,
} from "@infrawrench/server-core/alerts/destinations";
import { getCostReport } from "../../../services/cost-reports";
import { filterVisibleObjects } from "../../../services/object-sharing";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, NotFound, notFound } from "../../errors";
import { decodeAsPayload, readJson } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal, visibilityUserId } from "../../principal";
import { respond } from "../../response";
import {
  CostReportAnomalyAlert,
  CostReportAnomalyAlertList,
  CostReportAnomalyAlertsApi,
  CostReportAnomalyAlertTargets,
} from "./api";

/**
 * Shape only, as the route's zod schema was: `costReportAnomalyAlertProblem`
 * and the destination checks judge the rest, in their own words. Each
 * destination keeps every property it was sent with.
 */
const AnomalyAlertBody = Schema.Struct({
  enabled: Schema.Boolean,
  sigmas: Schema.Finite,
  minDeltaCents: Schema.Finite,
  destinations: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ kind: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ).check(Schema.isMaxLength(50)),
});

/**
 * A destination handed to `destinationShapeError`, which checks the kind and
 * each kind's identifier itself: the predicate claims only what that check
 * then proves.
 */
const isDestinationObject = (dest: unknown): dest is AlertDestination => Predicate.isObject(dest);

/** 404 unless the caller can see the report (deleted and unshared read the same). */
const requireReport = (id: string) =>
  Effect.gen(function* () {
    const { organizationId } = yield* OrgPrincipal;
    const report = yield* legacy(() => getCostReport(organizationId, id));
    if (!report) return yield* notFound("Cost report not found");
    return report;
  });

const noAlert = () => notFound("This report has no anomaly alert");

const CostReportAnomalyAlertsHandlers = HttpApiBuilder.group(
  CostReportAnomalyAlertsApi,
  "costReportAnomalyAlerts",
  (handlers) =>
    handlers
      // The alert and its recent findings.
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const report = yield* requireReport(params.id);
          const { organizationId } = yield* OrgPrincipal;
          const alert = yield* legacy(() => getReportAnomalyAlert(organizationId, report.id));
          if (!alert) return yield* noAlert();
          return yield* respond(CostReportAnomalyAlert)(alert);
        }),
      )
      // What the destination picker offers.
      .handle("targets", ({ params }) =>
        Effect.gen(function* () {
          yield* requireReport(params.id);
          const { organizationId } = yield* OrgPrincipal;
          const catalog = yield* legacy(() => loadDestinationCatalog(organizationId));
          return yield* respond(CostReportAnomalyAlertTargets)(catalog);
        }),
      )
      // Create or replace the report's alert. The report is found before the
      // body is read, so an unknown report is a 404 whatever was sent.
      .handleRaw("put", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const report = yield* requireReport(params.id);
          const body = yield* decodeAsPayload(AnomalyAlertBody, yield* readJson(request));
          const destinations: AlertDestination[] = [];
          for (const d of body.destinations) {
            if (!isDestinationObject(d)) return yield* badRequest('Unknown destination "?"');
            const shape = destinationShapeError(d, "destination");
            if (shape) return yield* badRequest(shape);
            destinations.push(d);
          }
          const input: CostReportAnomalyAlertInput = {
            enabled: body.enabled,
            sigmas: body.sigmas,
            minDeltaCents: body.minDeltaCents,
            destinations: destinations.map(canonicalDestination),
          };
          const problem = costReportAnomalyAlertProblem(input);
          if (problem) return yield* badRequest(problem);
          const owned = yield* legacy(() => loadOwnedDestinations(organizationId));
          const foreign = foreignDestinationError(owned, input.destinations);
          if (foreign) return yield* badRequest(foreign);

          const visibilityUser = yield* visibilityUserId;
          const saved = yield* legacyTry(
            () =>
              upsertReportAnomalyAlert(organizationId, report.id, input, {
                userId: session.userId,
                visibilityUserId: visibilityUser,
              }),
            (error) => {
              if (!(error instanceof ReportAnomalyAlertError)) return undefined;
              return error.status === 404
                ? new NotFound({ error: error.message })
                : new BadRequest({ error: error.message });
            },
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_report_anomaly_alert.upsert",
              entityType: "cost_report",
              entityId: report.id,
              metadata: {
                reportName: report.name,
                enabled: saved.enabled,
                sigmas: saved.sigmas,
                minDeltaCents: saved.minDeltaCents,
                destinations: saved.destinations.map((d) => d.kind),
              },
            }),
          );
          return yield* respond(CostReportAnomalyAlert)(saved);
        }),
      )
      // Remove the alert and its findings.
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const report = yield* requireReport(params.id);
          const deleted = yield* legacy(() => deleteReportAnomalyAlert(organizationId, report.id));
          if (!deleted) return yield* noAlert();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_report_anomaly_alert.delete",
              entityType: "cost_report",
              entityId: report.id,
              metadata: { reportName: report.name },
            }),
          );
          return { ok: true };
        }),
      ),
);

const OrgReportAnomalyAlertsHandlers = HttpApiBuilder.group(
  CostReportAnomalyAlertsApi,
  "orgReportAnomalyAlerts",
  (handlers) =>
    // Every report alert the caller can see (the report's sharing decides),
    // report name order. For the CLI and anyone auditing which scopes page whom.
    handlers.handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const visible = yield* legacy(async () => {
          const all = await listReportAnomalyAlerts(organizationId);
          return filterVisibleObjects(
            organizationId,
            "cost_report",
            all,
            (a) => a.reportId,
            (a) => ({ createdByUserId: a.reportCreatedByUserId, folderId: a.reportFolderId }),
          );
        });
        return yield* respond(CostReportAnomalyAlertList)({
          alerts: visible.map(
            ({ reportCreatedByUserId: _c, reportFolderId: _f, ...alert }) => alert,
          ),
        });
      }),
    ),
);

export const costReportAnomalyAlertsDomain = makeDomain(
  "cost-report-anomaly-alerts",
  CostReportAnomalyAlertsApi,
  Layer.mergeAll(CostReportAnomalyAlertsHandlers, OrgReportAnomalyAlertsHandlers),
);
