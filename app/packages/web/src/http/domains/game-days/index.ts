/**
 * Game days: `/api/org/:orgId/game-days`, the handlers.
 *
 * Planning, confirming, ending and reporting. Bodies arrive decoded by the
 * contract's `GameDayInput`; what can only be checked against the org (the
 * targets, the failure actions their plugins declare, the service, probes and
 * SLOs) is the store's, which refuses with `GameDayRefusal`. The injecting,
 * watching and undoing is the poller's (`server-core/src/game-days/pass.ts`).
 *
 * Every write is audit-logged as `game_day.*`. Arming refuses API keys and
 * agents: a game day only ever runs because a person confirmed it.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  armGameDay,
  createGameDay,
  deleteGameDay,
  disarmGameDay,
  GameDayRefusal,
  getGameDayDetail,
  listGameDayCandidates,
  listGameDays,
  requestGameDayEnd,
  retryGameDayUndo,
  updateGameDay,
} from "@infrawrench/server-core/game-days/store";
import { planGameDay } from "@infrawrench/server-core/game-days/plan";
import {
  forbidden,
  GameDay,
  GameDayCandidates,
  GameDayDetail,
  GameDayList,
  GameDayPlan,
  GameDaysApi,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { inputRefusal } from "../../refusals";
import { respond } from "../../response";

/** A store call whose refusals are the endpoint's declared 400/404/409. */
const store = <A>(write: () => Promise<A>) =>
  legacyTry(write, (error) => (error instanceof GameDayRefusal ? inputRefusal(error) : undefined));

const audit = Effect.fn("gameDays.audit")(function* (
  action: string,
  gameDayId: string,
  metadata: Record<string, unknown>,
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action: `game_day.${action}`,
      entityType: "game_day",
      entityId: gameDayId,
      metadata,
    }),
  );
});

const GameDaysHandlers = HttpApiBuilder.group(
  GameDaysApi,
  "gameDays",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({
      list: Effect.fn("gameDays.list")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const gameDays = yield* legacy(() => listGameDays(organizationId));
        return yield* respond(GameDayList)({ gameDays });
      }),
      candidates: Effect.fn("gameDays.candidates")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const candidates = yield* legacy(() => listGameDayCandidates(organizationId));
        return yield* respond(GameDayCandidates)(candidates);
      }),
      // A read despite the method: the dry run changes nothing.
      plan: Effect.fn("gameDays.plan")(function* ({ payload }) {
        const { organizationId } = yield* OrgPrincipal;
        const plan = yield* store(() => planGameDay(organizationId, payload));
        return yield* respond(GameDayPlan)(plan);
      }),
      get: Effect.fn("gameDays.get")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const detail = yield* legacy(() => getGameDayDetail(organizationId, params.gameDayId));
        if (!detail) return yield* notFound("Game day not found");
        return yield* respond(GameDayDetail)(detail);
      }),
      create: Effect.fn("gameDays.create")(function* ({ payload }) {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* store(() =>
          createGameDay(organizationId, payload, session.userId ?? null),
        );
        yield* audit("create", created.id, {
          name: created.name,
          startsAt: created.startsAt,
          targets: created.targets.map((t) => `${t.displayName}: ${t.actionId}`),
        });
        return yield* respond(GameDay)(created);
      }),
      update: Effect.fn("gameDays.update")(function* ({ params, payload }) {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* store(() =>
          updateGameDay(organizationId, params.gameDayId, payload),
        );
        yield* audit("update", updated.id, { name: updated.name, startsAt: updated.startsAt });
        return yield* respond(GameDay)(updated);
      }),
      delete: Effect.fn("gameDays.delete")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* store(() => deleteGameDay(organizationId, params.gameDayId));
        yield* audit("delete", deleted.id, { name: deleted.name, status: deleted.status });
        return ok;
      }),
      arm: Effect.fn("gameDays.arm")(function* ({ params, payload }) {
        const { organizationId, session, apiKey } = yield* OrgPrincipal;
        if (apiKey) {
          return yield* forbidden(
            "A game day is armed by a person signed in, never by an API key or agent",
          );
        }
        const armed = yield* store(() =>
          armGameDay(organizationId, params.gameDayId, session.userId, payload.confirmName),
        );
        yield* audit("arm", armed.id, { name: armed.name, startsAt: armed.startsAt });
        return yield* respond(GameDay)(armed);
      }),
      disarm: Effect.fn("gameDays.disarm")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const disarmed = yield* store(() => disarmGameDay(organizationId, params.gameDayId));
        yield* audit("disarm", disarmed.id, { name: disarmed.name });
        return yield* respond(GameDay)(disarmed);
      }),
      end: Effect.fn("gameDays.end")(function* ({ params }) {
        const { organizationId, session } = yield* OrgPrincipal;
        const ended = yield* store(() =>
          requestGameDayEnd(organizationId, params.gameDayId, session.userId ?? null, "ended"),
        );
        yield* audit("end_requested", ended.id, { name: ended.name });
        return yield* respond(GameDay)(ended);
      }),
      abort: Effect.fn("gameDays.abort")(function* ({ params }) {
        const { organizationId, session } = yield* OrgPrincipal;
        const aborted = yield* store(() =>
          requestGameDayEnd(organizationId, params.gameDayId, session.userId ?? null, "aborted"),
        );
        yield* audit("abort", aborted.id, { name: aborted.name, status: aborted.status });
        return yield* respond(GameDay)(aborted);
      }),
      retryUndo: Effect.fn("gameDays.retryUndo")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const retried = yield* store(() => retryGameDayUndo(organizationId, params.gameDayId));
        yield* audit("retry_undo", retried.id, { name: retried.name });
        return yield* respond(GameDay)(retried);
      }),
    });
  }),
);

export const gameDaysDomain = makeDomain("game-days", GameDaysApi, GameDaysHandlers);
