/**
 * Offboarding sweeps: `/api/org/:orgId/offboardings`, the handlers.
 *
 * The sweep and the checklist live in server-core (`offboarding/sweep.ts`,
 * `offboarding/store.ts`); the matching, progress and CSV in client-core; the
 * actions in `services/offboarding-actions.ts`, each through its own
 * surface's code path. This module owns what binds a request: the per-action
 * permission on top of the route's `team:remove`, the change freeze for the
 * actions that reach a provider, and an audit row for every start, edit,
 * export and action attempt.
 *
 * Every mutation is on the gateway (`edge/gateway-routes.ts`): an action is
 * plugin code, and the rest share the prefix.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  OFFBOARDING_ACTION_PERMISSIONS,
  OFFBOARDING_ACTIONS_NEEDING_TARGET,
  OFFBOARDING_PROVIDER_ACTIONS,
  offboardingItemActionable,
  offboardingToCsv,
  type OffboardingActionId,
  type OffboardingItemStatus,
  type OffboardingMatchState,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  getOffboarding,
  getOffboardingItemRow,
  listOffboardingMembers,
  listOffboardings,
  loadOffboardingActor,
  OffboardingInputError,
  previewOffboarding,
  recordItemOutcome,
  rescanOffboarding,
  startOffboarding,
  updateOffboarding,
  updateOffboardingItem,
} from "@infrawrench/server-core/offboarding/store";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  Offboarding,
  OffboardingActionResult,
  OffboardingApi,
  OffboardingItem,
  OffboardingList,
  OffboardingMembers,
  OffboardingPreview,
  OffboardingStartResponse,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import {
  OffboardingActionRefused,
  runOffboardingAction,
} from "../../../services/offboarding-actions";
import { requireNoChangeFreeze } from "../../change-freeze";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { inputRefusal } from "../../refusals";
import { respond } from "../../response";

/** The checklist store's input errors, as their declared statuses. */
const store = <A>(fn: () => Promise<A>) =>
  legacyTry(fn, (error) =>
    error instanceof OffboardingInputError ? inputRefusal(error) : undefined,
  );

const audit = Effect.fn("offboarding.audit")(function* (
  action: string,
  offboardingId: string,
  metadata: Record<string, unknown>,
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action: `offboarding.${action}`,
      entityType: "offboarding",
      entityId: offboardingId,
      metadata,
    }),
  );
});

/** An action the caller has to fix, refused before anything ran. */
class ActionRefused extends Schema.TaggedError<ActionRefused>()("ActionRefused", {
  status: Schema.Literals([400, 403, 409]),
  message: Schema.String,
}) {}

const refusalToHttp = (refusal: ActionRefused) =>
  refusal.status === 403
    ? forbidden(refusal.message)
    : refusal.status === 409
      ? conflict(refusal.message)
      : badRequest(refusal.message);

const OffboardingHandlers = HttpApiBuilder.group(
  OffboardingApi,
  "offboarding",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({
      list: Effect.fn("offboarding.list")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const offboardings = yield* legacy(() => listOffboardings(organizationId));
        return yield* respond(OffboardingList)({ offboardings });
      }),

      start: Effect.fn("offboarding.start")(function* ({ payload }) {
        const { organizationId, session } = yield* OrgPrincipal;
        const actor = yield* legacy(() => loadOffboardingActor(session.userId));
        const { offboarding, created } = yield* store(() =>
          startOffboarding(
            organizationId,
            {
              email: payload.email,
              ...(payload.aliases ? { aliases: payload.aliases } : {}),
              ...(payload.note !== undefined ? { note: payload.note } : {}),
            },
            actor,
          ),
        );
        yield* audit(created ? "started" : "rescanned", offboarding.id, {
          email: offboarding.email,
          source: "manual",
          items: offboarding.progress.total,
        });
        return yield* respond(OffboardingStartResponse)({ offboarding, created });
      }),

      preview: Effect.fn("offboarding.preview")(function* ({ payload }) {
        const { organizationId } = yield* OrgPrincipal;
        const preview = yield* store(() =>
          previewOffboarding(organizationId, {
            email: payload.email,
            ...(payload.aliases ? { aliases: payload.aliases } : {}),
          }),
        );
        return yield* respond(OffboardingPreview)(preview);
      }),

      members: Effect.fn("offboarding.members")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const members = yield* legacy(() => listOffboardingMembers(organizationId));
        return yield* respond(OffboardingMembers)({ members });
      }),

      get: Effect.fn("offboarding.get")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const offboarding = yield* legacy(() => getOffboarding(organizationId, params.id));
        if (!offboarding) return yield* notFound("Offboarding not found");
        return yield* respond(Offboarding)(offboarding);
      }),

      update: Effect.fn("offboarding.update")(function* ({ params, payload }) {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* store(() =>
          updateOffboarding(organizationId, params.id, {
            ...(payload.aliases ? { aliases: payload.aliases } : {}),
            ...(payload.note !== undefined ? { note: payload.note } : {}),
            ...(payload.status ? { status: payload.status } : {}),
          }),
        );
        yield* audit("updated", updated.id, {
          email: updated.email,
          ...(payload.aliases ? { aliases: updated.aliases } : {}),
          ...(payload.status ? { status: payload.status } : {}),
          ...(payload.note !== undefined ? { noteChanged: true } : {}),
        });
        return yield* respond(Offboarding)(updated);
      }),

      rescan: Effect.fn("offboarding.rescan")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const fresh = yield* store(() => rescanOffboarding(organizationId, params.id));
        return yield* respond(Offboarding)(fresh);
      }),

      export: Effect.fn("offboarding.export")(function* ({ params, query }) {
        const { organizationId } = yield* OrgPrincipal;
        const format = query.format ?? "csv";
        if (format !== "csv" && format !== "json") {
          return yield* badRequest('format must be "csv" or "json"');
        }
        const offboarding = yield* legacy(() => getOffboarding(organizationId, params.id));
        if (!offboarding) return yield* notFound("Offboarding not found");
        yield* audit("exported", offboarding.id, {
          email: offboarding.email,
          format,
          items: offboarding.items.length,
        });
        // The person and the date in the filename, so a folder of these reads
        // without opening any of them.
        const who = offboarding.email.replace(/[^a-z0-9.@_-]/gi, "_");
        const stamp = new Date().toISOString().slice(0, 10);
        const headers = {
          "content-disposition": `attachment; filename="offboarding-${who}-${stamp}.${format}"`,
        };
        return format === "json"
          ? HttpServerResponse.text(JSON.stringify(offboarding, null, 2), {
              contentType: "application/json; charset=utf-8",
              headers,
            })
          : HttpServerResponse.text(offboardingToCsv(offboarding), {
              contentType: "text/csv; charset=utf-8",
              headers,
            });
      }),

      updateItem: Effect.fn("offboarding.updateItem")(function* ({ params, payload }) {
        const { organizationId, session } = yield* OrgPrincipal;
        const actor = yield* legacy(() => loadOffboardingActor(session.userId));
        const item = yield* store(() =>
          updateOffboardingItem(
            organizationId,
            params.id,
            params.itemId,
            {
              ...(payload.matchState ? { matchState: payload.matchState } : {}),
              ...(payload.status ? { status: payload.status } : {}),
              ...(payload.note !== undefined ? { note: payload.note } : {}),
            },
            actor,
          ),
        );
        yield* audit("item_updated", params.id, {
          itemId: item.id,
          kind: item.kind,
          title: item.title,
          ...(payload.matchState ? { matchState: payload.matchState } : {}),
          ...(payload.status ? { status: payload.status } : {}),
        });
        return yield* respond(OffboardingItem)(item);
      }),

      act: Effect.fn("offboarding.act")(
        function* ({ params, payload, request }) {
          const { organizationId, session, permissions, role } = yield* OrgPrincipal;
          const found = yield* legacy(() =>
            getOffboardingItemRow(organizationId, params.id, params.itemId),
          );
          if (!found) return yield* notFound("Item not found");
          const { offboarding, item } = found;
          const action: OffboardingActionId = payload.action;

          if (offboarding.status !== "open") {
            return yield* new ActionRefused({
              status: 409,
              message: "This offboarding is closed; reopen it to act on it.",
            });
          }
          if (!item.actions.includes(action)) {
            return yield* new ActionRefused({
              status: 409,
              message: "This row does not offer that action.",
            });
          }
          if (
            !offboardingItemActionable({
              matchState: item.matchState as OffboardingMatchState,
              status: item.status as OffboardingItemStatus,
            })
          ) {
            return yield* new ActionRefused({
              status: 409,
              message:
                item.matchState === "unconfirmed"
                  ? "Confirm this is them before acting on it."
                  : "This row is already resolved.",
            });
          }
          const needed = OFFBOARDING_ACTION_PERMISSIONS[action];
          if (needed && !hasPermission(permissions, needed)) {
            return yield* new ActionRefused({
              status: 403,
              message: `Missing permission: ${needed}`,
            });
          }
          if (OFFBOARDING_ACTIONS_NEEDING_TARGET.has(action) && !payload.targetUserId) {
            return yield* new ActionRefused({ status: 400, message: "Choose who takes it over." });
          }
          if (OFFBOARDING_PROVIDER_ACTIONS.has(action)) {
            yield* requireNoChangeFreeze(request, {
              action: "offboarding.action",
              entityType: "offboarding",
              entityId: offboarding.id,
              metadata: { action, itemId: item.id, kind: item.kind },
            });
          }

          const actor = yield* legacy(() => loadOffboardingActor(session.userId));
          const outcome = yield* legacyTry(
            () =>
              runOffboardingAction(
                {
                  organizationId,
                  userId: session.userId,
                  permissions,
                  callerIsOwner: role?.systemKey === "owner",
                },
                { kind: item.kind, title: item.title, ref: item.ref },
                {
                  action,
                  ...(payload.targetUserId ? { targetUserId: payload.targetUserId } : {}),
                },
              ).then(
                (message) => ({ ok: true as const, message }),
                (error: unknown) => {
                  if (error instanceof OffboardingActionRefused) throw error;
                  return {
                    ok: false as const,
                    error: error instanceof Error ? error.message : String(error),
                  };
                },
              ),
            (error) =>
              error instanceof OffboardingActionRefused
                ? new ActionRefused({ status: error.status, message: error.message })
                : undefined,
          );

          const updated = yield* legacy(() =>
            recordItemOutcome(
              item.id,
              outcome.ok ? { ok: true, action } : { ok: false, error: outcome.error },
              actor,
            ),
          );
          if (!updated) return yield* notFound("Item not found");
          yield* audit("action", offboarding.id, {
            email: offboarding.email,
            itemId: item.id,
            kind: item.kind,
            title: item.title,
            pluginId: item.pluginId,
            accountId: item.accountId,
            action,
            ...(payload.targetUserId ? { targetUserId: payload.targetUserId } : {}),
            outcome: outcome.ok ? "done" : "failed",
            ...(outcome.ok ? {} : { error: outcome.error }),
          });
          return yield* respond(OffboardingActionResult)({
            item: updated,
            message: outcome.ok ? outcome.message : null,
          });
        },
        Effect.catchTag("ActionRefused", (refusal) => Effect.fail(refusalToHttp(refusal))),
      ),
    });
  }),
);

export const offboardingDomain = makeDomain("offboarding", OffboardingApi, OffboardingHandlers);
