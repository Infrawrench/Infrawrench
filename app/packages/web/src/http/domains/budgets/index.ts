/**
 * Budgets: `/api/org/:orgId/budgets`, the handlers. The services are still
 * promise code and run through `legacy`, inside the request's cost visibility
 * scope.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SavedCostFilterResolutionError } from "@infrawrench/server-core/cost/saved-filters";
import { AlertEmailRecipientsError } from "@infrawrench/server-core/alerts/email-errors";
import {
  BadRequest,
  BudgetAlertEvent,
  BudgetAlertNoteResult,
  BudgetFull,
  BudgetsApi,
  BudgetWithStatus,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import {
  BudgetValidationError,
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../../../services/budgets";
import { BudgetAlertNoteError, noteBudgetAlertEvent } from "../../../services/budget-alert-notes";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";

/** The service's refusals that are the caller's fault: 400 with its sentence. */
const writeRefusal = (error: unknown) =>
  error instanceof SavedCostFilterResolutionError ||
  error instanceof BudgetValidationError ||
  error instanceof AlertEmailRecipientsError
    ? new BadRequest({ error: error.message })
    : undefined;

const BudgetsHandlers = HttpApiBuilder.group(BudgetsApi, "budgets", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const budgets = yield* legacy(() => listBudgetsWithStatus(organizationId));
        return yield* respond(Schema.Array(BudgetWithStatus))(budgets);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        // A budget must not be born pointing at a saved filter that does not
        // resolve: it would error every evaluation from day one.
        const created = yield* legacyTry(
          () => createBudget(organizationId, payload, session.userId ?? null),
          writeRefusal,
        );
        return yield* respond(BudgetFull)(created);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const budget = yield* legacy(() => getBudgetWithStatus(organizationId, params.id));
        if (!budget) return yield* notFound();
        return yield* respond(BudgetWithStatus)(budget);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateBudget(organizationId, params.id, payload),
          writeRefusal,
        );
        if (!updated) return yield* notFound();
        return yield* respond(BudgetFull)(updated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteBudget(organizationId, params.id));
        if (!deleted) return yield* notFound();
        return ok;
      }),
    )
    .handle("events", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const events = yield* legacy(() => listBudgetEvents(organizationId, params.id));
        if (!events) return yield* notFound();
        return yield* respond(Schema.Array(BudgetAlertEvent))(events);
      }),
    )
    .handle("note", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* requirePermission("budgets:read");
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () =>
            noteBudgetAlertEvent(
              organizationId,
              params.id,
              params.eventId,
              payload.note,
              session.userId ?? null,
            ),
          (error) =>
            error instanceof BudgetAlertNoteError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!result) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "budget_alert.note",
            entityType: "budget",
            entityId: params.id,
            metadata: {
              eventId: result.id,
              month: result.month,
              thresholdType: result.thresholdType,
              thresholdPercent: result.thresholdPercent,
              note: result.note?.text ?? null,
              annotationId: result.note?.annotationId ?? null,
            },
          }),
        );
        return yield* respond(BudgetAlertNoteResult)(result);
      }),
    ),
);

export const budgetsDomain = makeDomain("budgets", BudgetsApi, BudgetsHandlers);
