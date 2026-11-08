/**
 * The public iCalendar feed, the handler. Everything it can reach is the
 * token resolver and the calendar assembler: there is no path from here to a
 * credential, a cost figure or a mutation.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  ICS_WINDOW_FUTURE_DAYS,
  ICS_WINDOW_PAST_DAYS,
  buildIcsCalendar,
} from "@infrawrench/client-core";
import { listCalendarEvents } from "@infrawrench/server-core/calendar/feed";
import { resolveCalendarToken } from "@infrawrench/server-core/calendar/subscriptions";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { CalendarFeedApi } from "./api";

const MS_PER_DAY = 86_400_000;

/** Hono's `c.text("Not found", 404)`, byte for byte. */
const notFoundText = () =>
  HttpServerResponse.text("Not found", {
    status: 404,
    contentType: "text/plain; charset=UTF-8",
  });

const CalendarFeedHandlers = HttpApiBuilder.group(CalendarFeedApi, "calendarFeed", (h) =>
  h.handle("feed", ({ params }) =>
    Effect.gen(function* () {
      // The `.ics` suffix is what makes desktop clients hand the response to
      // the calendar app rather than the browser's downloader; it is part of
      // the URL we mint, so requiring it costs nothing and keeps the route
      // unambiguous.
      if (!params.file.endsWith(".ics")) return notFoundText();
      const token = params.file.slice(0, -4);

      const subscription = yield* legacy(() => resolveCalendarToken(token));
      // One answer for unknown and revoked alike: the difference is exactly
      // what someone probing tokens would want to learn.
      if (!subscription) return notFoundText();

      const now = Date.now();
      const feed = yield* legacy(() =>
        listCalendarEvents(subscription.organizationId, {
          from: now - ICS_WINDOW_PAST_DAYS * MS_PER_DAY,
          to: now + ICS_WINDOW_FUTURE_DAYS * MS_PER_DAY,
          kinds: subscription.kinds,
          now,
        }),
      );

      const body = buildIcsCalendar(feed.events, {
        name: subscription.name,
        now: new Date(now).toISOString(),
      });

      return HttpServerResponse.text(body, {
        contentType: "text/calendar; charset=utf-8",
        headers: {
          // Named so a client that saves rather than subscribes produces a
          // recognisable file. ASCII-only: the subscription name is
          // user-supplied and a raw one here would be a header-injection vector.
          "Content-Disposition": 'inline; filename="infrawrench.ics"',
          // Subscribed clients poll on their own schedule; an hour of shared
          // cache is well inside the resolution anything on this calendar has.
          "Cache-Control": "private, max-age=3600",
          // The feed is a credential-bearing URL. Keep it out of referrers and
          // out of any embedding context.
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }),
  ),
);

export const calendarFeedDomain = makeDomain(
  "calendar-feed",
  CalendarFeedApi,
  CalendarFeedHandlers,
);
