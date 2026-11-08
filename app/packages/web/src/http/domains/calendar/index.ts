/**
 * Operations calendar: `/api/org/:orgId/calendar`, the handlers.
 *
 * The feed is assembled in server-core (`calendar/feed.ts`) so this domain,
 * the iCalendar subscription route and any future digest section share one
 * computation. Purely a read over already-synced state.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  CALENDAR_MAX_WINDOW_DAYS,
  parseCalendarKinds,
  type CalendarEventKind,
} from "@infrawrench/client-core";
import { listCalendarEvents } from "@infrawrench/server-core/calendar/feed";
import {
  CalendarSubscriptionInputError,
  createCalendarSubscription,
  listCalendarSubscriptions,
  revokeCalendarSubscription,
} from "@infrawrench/server-core/calendar/subscriptions";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, HttpFailure, NotFound, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  CalendarApi,
  CalendarResponse,
  CalendarSubscription,
  CalendarSubscriptionList,
} from "./api";

const MS_PER_DAY = 86_400_000;
/** Default view when the caller names no window: the month around today. */
const DEFAULT_PAST_DAYS = 7;
const DEFAULT_FUTURE_DAYS = 35;

interface ParsedWindow {
  from: number;
  to: number;
  kinds: CalendarEventKind[];
}

/**
 * Read `from` / `to` / `kinds` off the query string.
 *
 * The window is validated rather than clamped, because silently answering a
 * different question than the one asked is how a UI ends up drawing March over
 * a February heading. The one exception is an absent bound, which has no
 * intent to contradict.
 */
function parseWindow(query: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly kinds?: string | undefined;
}): { ok: true; value: ParsedWindow } | { ok: false; error: string } {
  const now = Date.now();
  const from = query.from ? Date.parse(query.from) : now - DEFAULT_PAST_DAYS * MS_PER_DAY;
  const to = query.to ? Date.parse(query.to) : now + DEFAULT_FUTURE_DAYS * MS_PER_DAY;
  if (Number.isNaN(from)) return { ok: false, error: "from must be an ISO 8601 instant" };
  if (Number.isNaN(to)) return { ok: false, error: "to must be an ISO 8601 instant" };
  if (to <= from) return { ok: false, error: "to must be after from" };
  if (to - from > CALENDAR_MAX_WINDOW_DAYS * MS_PER_DAY) {
    return {
      ok: false,
      error: `The window may span at most ${CALENDAR_MAX_WINDOW_DAYS} days`,
    };
  }
  return { ok: true, value: { from, to, kinds: parseCalendarKinds(query.kinds) } };
}

/**
 * Run a subscription write, answering the service's refusal with the status it
 * carries: a declared one as its typed error, any other as that status.
 */
const subscriptionCall = <A, E>(
  fn: () => PromiseLike<A>,
  declared: (error: CalendarSubscriptionInputError) => E | undefined,
) =>
  legacyTry(fn, (error) =>
    error instanceof CalendarSubscriptionInputError ? declared(error) : undefined,
  ).pipe(
    Effect.catchDefect((defect) =>
      Effect.die(
        defect instanceof CalendarSubscriptionInputError
          ? new HttpFailure(defect.status, { error: defect.message })
          : defect,
      ),
    ),
  );

const CalendarHandlers = HttpApiBuilder.group(CalendarApi, "calendar", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const parsed = parseWindow(query);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const { organizationId } = yield* OrgPrincipal;
        const events = yield* legacy(() => listCalendarEvents(organizationId, parsed.value));
        return yield* respond(CalendarResponse)(events);
      }),
    )
    .handle("listSubscriptions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const subscriptions = yield* legacy(() => listCalendarSubscriptions(organizationId));
        return yield* respond(CalendarSubscriptionList)({ subscriptions });
      }),
    )
    /**
     * The response carries the only copy of the token, as an absolute URL
     * ready to paste into a calendar client. The audit entry deliberately
     * records the name and the kinds but not the prefix: a prefix in an audit
     * log is eight characters of a live credential sitting in a surface more
     * people can read than can mint.
     */
    .handleRaw("createSubscription", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* invalidBody(parsed.error);
        const name = parsed.body["name"];
        if (!Predicate.isString(name)) return yield* invalidBody("name is required");
        const kinds = parseCalendarKinds(parsed.body["kinds"]);

        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* subscriptionCall(
          () => createCalendarSubscription(organizationId, { name, kinds }, session.userId ?? null),
          (error) => (error.status === 400 ? new BadRequest({ error: error.message }) : undefined),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "calendar_subscription.create",
            entityType: "calendar_subscription",
            entityId: created.subscription.id,
            metadata: { name: created.subscription.name, kinds: created.subscription.kinds },
          }),
        );
        return yield* respond(CalendarSubscription)({
          ...created.subscription,
          url: new URL(`/api/calendar/${created.token}.ics`, request.originalUrl).toString(),
        });
      }),
    )
    .handle("revokeSubscription", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const subscription = yield* subscriptionCall(
          () => revokeCalendarSubscription(organizationId, params.subscriptionId),
          (error) => (error.status === 404 ? new NotFound({ error: error.message }) : undefined),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "calendar_subscription.revoke",
            entityType: "calendar_subscription",
            entityId: params.subscriptionId,
            metadata: { name: subscription.name },
          }),
        );
        return yield* respond(CalendarSubscription)(subscription);
      }),
    ),
);

export const calendarDomain = makeDomain("calendar", CalendarApi, CalendarHandlers);
