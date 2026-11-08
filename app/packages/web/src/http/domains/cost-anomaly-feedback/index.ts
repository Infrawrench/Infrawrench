/**
 * Anomaly feedback under `/api/org/:orgId/costs`, the handlers. The logic
 * lives in services/cost-anomaly-feedback.ts, called through `legacy` inside
 * the request's scopes. The two expected refusals keep their answers: the
 * feedback service's error carries its own status (400, or 409 past the
 * active-suppression limit), and an acknowledgement refusal is a 400.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { COST_ANOMALY_FEEDBACK_LIMITS } from "@infrawrench/client-core";
import { logAudit } from "../../../services/audit";
import { CostAnomalyAcknowledgeError } from "../../../services/cost-anomalies";
import {
  clearCostAnomalyFeedback,
  createCostAnomalySuppression,
  CostAnomalyFeedbackError,
  deleteCostAnomalySuppression,
  getCostAnomalyPrecision,
  getCostAnomalySensitivity,
  getCostAnomalySuppression,
  listCostAnomalySuppressions,
  submitCostAnomalyFeedback,
  updateCostAnomalySuppression,
} from "../../../services/cost-anomaly-feedback";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, Conflict, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { CostAnomaly } from "../../schemas/cost-anomalies";
import {
  CostAnomalyFeedbackApi,
  CostAnomalyFeedbackResult,
  CostAnomalyPrecisionReport,
  CostAnomalySensitivity,
  CostAnomalySuppression,
  CostAnomalySuppressionList,
} from "./api";

/** The Hono route's `failure`: anything else is a defect, a 500. */
const feedbackRefusal = (error: unknown) => {
  if (error instanceof CostAnomalyFeedbackError) {
    return error.status === 409
      ? new Conflict({ error: error.message })
      : new BadRequest({ error: error.message });
  }
  if (error instanceof CostAnomalyAcknowledgeError) return new BadRequest({ error: error.message });
  return undefined;
};

const CostAnomalyFeedbackHandlers = HttpApiBuilder.group(
  CostAnomalyFeedbackApi,
  "costAnomalyFeedback",
  (handlers) =>
    handlers
      .handle("submitFeedback", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* legacyTry(
            () =>
              submitCostAnomalyFeedback(
                organizationId,
                params.anomalyId,
                payload,
                session.userId ?? null,
              ),
            feedbackRefusal,
          );
          if (!result) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_anomaly.feedback",
              entityType: "cost_anomaly",
              entityId: result.anomaly.id,
              metadata: {
                day: result.anomaly.day,
                dimension: result.anomaly.dimension,
                dimensionKey: result.anomaly.dimensionKey,
                verdict: payload.verdict,
                reason: payload.reason ?? null,
                suppressionId: result.suppression?.id ?? null,
              },
            }),
          );
          return yield* respond(CostAnomalyFeedbackResult)(result);
        }),
      )
      .handle("clearFeedback", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const anomaly = yield* legacy(() =>
            clearCostAnomalyFeedback(organizationId, params.anomalyId),
          );
          if (!anomaly) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_anomaly.feedback_clear",
              entityType: "cost_anomaly",
              entityId: anomaly.id,
              metadata: {
                day: anomaly.day,
                dimension: anomaly.dimension,
                dimensionKey: anomaly.dimensionKey,
              },
            }),
          );
          return yield* respond(CostAnomaly)(anomaly);
        }),
      )
      .handle("listSuppressions", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const suppressions = yield* legacy(() => listCostAnomalySuppressions(organizationId));
          return yield* respond(CostAnomalySuppressionList)({ suppressions });
        }),
      )
      .handle("createSuppression", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* legacyTry(
            () => createCostAnomalySuppression(organizationId, payload, session.userId ?? null),
            feedbackRefusal,
          );
          if (!created) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_anomaly_suppression.create",
              entityType: "cost_anomaly_suppression",
              entityId: created.id,
              metadata: {
                scope: created.scope,
                scopeKey: created.scopeKey,
                expiresOn: created.expiresOn,
              },
            }),
          );
          return yield* respond(CostAnomalySuppression, { status: 201 })(created);
        }),
      )
      .handle("getSuppression", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const found = yield* legacy(() =>
            getCostAnomalySuppression(organizationId, params.suppressionId),
          );
          if (!found) return yield* notFound();
          return yield* respond(CostAnomalySuppression)(found);
        }),
      )
      .handle("updateSuppression", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* legacyTry(
            () => updateCostAnomalySuppression(organizationId, params.suppressionId, payload),
            feedbackRefusal,
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_anomaly_suppression.update",
              entityType: "cost_anomaly_suppression",
              entityId: updated.id,
              metadata: {
                scope: updated.scope,
                scopeKey: updated.scopeKey,
                expiresOn: updated.expiresOn,
              },
            }),
          );
          return yield* respond(CostAnomalySuppression)(updated);
        }),
      )
      .handle("deleteSuppression", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const id = params.suppressionId;
          const deleted = yield* legacy(() => deleteCostAnomalySuppression(organizationId, id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "cost_anomaly_suppression.delete",
              entityType: "cost_anomaly_suppression",
              entityId: id,
            }),
          );
        }),
      )
      .handle("sensitivity", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const sensitivity = yield* legacy(() => getCostAnomalySensitivity(organizationId));
          return yield* respond(CostAnomalySensitivity)(sensitivity);
        }),
      )
      .handle("precision", ({ query }) =>
        Effect.gen(function* () {
          const max = COST_ANOMALY_FEEDBACK_LIMITS.precisionMaxMonths;
          const months =
            query.months === undefined
              ? COST_ANOMALY_FEEDBACK_LIMITS.precisionDefaultMonths
              : Number(query.months);
          if (!Number.isInteger(months) || months < 1 || months > max) {
            return yield* badRequest(`months must be an integer between 1 and ${max}`);
          }
          const { organizationId } = yield* OrgPrincipal;
          const report = yield* legacy(() => getCostAnomalyPrecision(organizationId, months));
          return yield* respond(CostAnomalyPrecisionReport)(report);
        }),
      ),
);

export const costAnomalyFeedbackDomain = makeDomain(
  "cost-anomaly-feedback",
  CostAnomalyFeedbackApi,
  CostAnomalyFeedbackHandlers,
);
