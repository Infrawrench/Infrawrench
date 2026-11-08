/**
 * Realized savings: `/api/org/:orgId/savings`, the handlers. The report is
 * computed on every read (billing restates; see
 * `server-core/src/savings/realized.ts`); the rest manage the *events* the
 * report measures. A `SavingsEventError` is answered with the status it
 * carries; anything else is a defect, as the Hono route's `errorResponse`
 * rethrew it.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  annotateSavingsEvent,
  createManualSavingsEvent,
  deleteSavingsEvent,
  getSavingsEventRow,
  SavingsEventError,
  updateManualSavingsEvent,
} from "@infrawrench/server-core/savings/events";
import {
  getRealizedSavingsReport,
  RealizedSavingsRangeError,
} from "@infrawrench/server-core/savings/realized";
import {
  getOrgSavingsSettings,
  setOrgSavingsSettings,
} from "@infrawrench/server-core/savings/settings";
import {
  BadRequest,
  notFound,
  ok,
  RealizedSavingsReport,
  RealizedSavingsSettings,
  SavingsApi,
  SavingsEvent,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { refuse, refusalCall, type StatusRefusal } from "../../refusals";

const savingsRefusal = (error: unknown): StatusRefusal | undefined =>
  error instanceof SavingsEventError ? { status: error.status, message: error.message } : undefined;

const SavingsHandlers = HttpApiBuilder.group(SavingsApi, "savings", (handlers) =>
  handlers
    /** The report, with every event's realized figure. */
    .handle("realized", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const report = yield* legacyTry(
          () =>
            getRealizedSavingsReport(organizationId, {
              from: query.from || undefined,
              to: query.to || undefined,
            }),
          (error) =>
            error instanceof RealizedSavingsRangeError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        return yield* respond(RealizedSavingsReport)(report);
      }),
    )
    /** Log a saving by hand. */
    .handle("createEvent", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* refusalCall(savingsRefusal, { 400: refuse[400] }, () =>
          createManualSavingsEvent(organizationId, payload, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_event.create",
            entityType: "savings_event",
            entityId: created.id,
            metadata: { kind: created.kind, occurredOn: created.occurredOn },
          }),
        );
        return yield* respond(SavingsEvent)(created);
      }),
    )
    /** Rewrite a manual entry. */
    .handle("updateEvent", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* refusalCall(
          savingsRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => updateManualSavingsEvent(organizationId, params.id, payload),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_event.update",
            entityType: "savings_event",
            entityId: updated.id,
            metadata: { kind: updated.kind },
          }),
        );
        return yield* respond(SavingsEvent)(updated);
      }),
    )
    /**
     * Add context to any event (a note, an attribution, a horizon, an end
     * date). The facts of an automatic event stay as observed.
     */
    .handle("annotateEvent", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* refusalCall(
          savingsRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => annotateSavingsEvent(organizationId, params.id, payload),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_event.update",
            entityType: "savings_event",
            entityId: updated.id,
            metadata: { kind: updated.kind, fields: Object.keys(payload) },
          }),
        );
        return yield* respond(SavingsEvent)(updated);
      }),
    )
    /** Withdraw an entry and the chart note it left. */
    .handle("deleteEvent", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const id = params.id;
        const row = yield* legacy(() => getSavingsEventRow(organizationId, id));
        if (!row) return yield* notFound("Saving not found");
        const removed = yield* refusalCall(savingsRefusal, { 404: refuse[404] }, () =>
          deleteSavingsEvent(organizationId, id),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_event.delete",
            entityType: "savings_event",
            entityId: id,
            metadata: { kind: removed.kind, title: removed.title },
          }),
        );
        return ok;
      }),
    )
    /** Horizon, shortfall threshold and baseline window. */
    .handle("getSettings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getOrgSavingsSettings(organizationId));
        return yield* respond(RealizedSavingsSettings)(settings);
      }),
    )
    /** Retune how realized savings are measured, org-wide. */
    .handle("updateSettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* legacy(() => setOrgSavingsSettings(organizationId, payload));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "savings_settings.update",
            entityType: "organization",
            entityId: organizationId,
            metadata: { ...saved },
          }),
        );
        return yield* respond(RealizedSavingsSettings)(saved);
      }),
    ),
);

export const savingsDomain = makeDomain("savings", SavingsApi, SavingsHandlers);
