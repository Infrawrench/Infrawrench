/**
 * Change-based cost alerts: `/api/org/:orgId/cost-alerts`, the handlers.
 * Logic lives in services/cost-alerts.ts so the MCP/chat tools share the code
 * path; these handlers are transport only, calling it through `legacy`
 * inside the request's scopes.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AlertEmailRecipientsError } from "@infrawrench/server-core/alerts/email-errors";
import { logAudit } from "../../../services/audit";
import {
  CostAlertLimitError,
  createCostAlert,
  getCostAlert,
  listCostAlertEventsForOrg,
  listCostAlerts,
  softDeleteCostAlert,
  updateCostAlert,
} from "../../../services/cost-alerts";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { CostAlert, CostAlertEventList, CostAlertList, CostAlertsApi } from "./api";

const CostAlertsHandlers = HttpApiBuilder.group(CostAlertsApi, "costAlerts", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const alerts = yield* legacy(() => listCostAlerts(organizationId));
        return yield* respond(CostAlertList)({ alerts });
      }),
    )
    .handle("events", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const alertId = query.alertId;
        const limit = query.limit === undefined ? undefined : Number(query.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          return yield* badRequest("limit must be a positive integer");
        }
        const events = yield* legacy(() =>
          listCostAlertEventsForOrg(organizationId, {
            ...(alertId ? { alertId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
        if (events === null) return yield* notFound();
        return yield* respond(CostAlertEventList)({ events });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const alert = yield* legacy(() => getCostAlert(organizationId, params.id));
        if (!alert) return yield* notFound();
        return yield* respond(CostAlert)(alert);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacyTry(
          () => createCostAlert(organizationId, payload, session.userId ?? null),
          (error) =>
            error instanceof CostAlertLimitError || error instanceof AlertEmailRecipientsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_alert.create",
            entityType: "cost_alert",
            entityId: created.id,
            metadata: { name: created.name, cadence: created.cadence },
          }),
        );
        return yield* respond(CostAlert)(created);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateCostAlert(organizationId, params.id, payload),
          (error) =>
            error instanceof AlertEmailRecipientsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_alert.update",
            entityType: "cost_alert",
            entityId: updated.id,
            metadata: { name: updated.name, cadence: updated.cadence },
          }),
        );
        return yield* respond(CostAlert)(updated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteCostAlert(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_alert.delete",
            entityType: "cost_alert",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    ),
);

export const costAlertsDomain = makeDomain("cost-alerts", CostAlertsApi, CostAlertsHandlers);
