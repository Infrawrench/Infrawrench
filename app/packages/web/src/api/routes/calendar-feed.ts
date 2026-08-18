/**
 * The public iCalendar feed (`GET /api/calendar/:token.ics`).
 *
 * Registered outside every auth layer, for the same reason public status pages
 * are: the caller is Google Calendar or a phone, which cannot hold a session, a
 * bearer token or an API key. The opaque token in the path is the sole
 * credential — and unlike a status page's slug it is 32 random bytes, because
 * this one answers with the org's schedule rather than a page someone chose to
 * publish.
 *
 * The URL deliberately contains no organization id. A feed that leaks should
 * expose *what it carries* and nothing else — in particular it must not become
 * a way to learn an org id and start probing org-scoped routes with it.
 *
 * Everything this handler can reach is the token resolver and the calendar
 * assembler. There is no path from here to a credential, a cost figure or a
 * mutation.
 */
import { Hono } from "hono";
import {
  ICS_WINDOW_FUTURE_DAYS,
  ICS_WINDOW_PAST_DAYS,
  buildIcsCalendar,
} from "@infrawrench/client-core";
import { listCalendarEvents } from "@infrawrench/server-core/calendar/feed";
import { resolveCalendarToken } from "@infrawrench/server-core/calendar/subscriptions";

const app = new Hono();

const MS_PER_DAY = 86_400_000;

app.get("/calendar/:file", async (c) => {
  const file = c.req.param("file");
  // The `.ics` suffix is what makes desktop clients hand the response to the
  // calendar app rather than the browser's downloader; it is part of the URL
  // we mint, so requiring it costs nothing and keeps the route unambiguous.
  if (!file.endsWith(".ics")) return c.text("Not found", 404);
  const token = file.slice(0, -4);

  const subscription = await resolveCalendarToken(token);
  // One answer for unknown and revoked alike: the difference is exactly what
  // someone probing tokens would want to learn.
  if (!subscription) return c.text("Not found", 404);

  const now = Date.now();
  const feed = await listCalendarEvents(subscription.organizationId, {
    from: now - ICS_WINDOW_PAST_DAYS * MS_PER_DAY,
    to: now + ICS_WINDOW_FUTURE_DAYS * MS_PER_DAY,
    kinds: subscription.kinds,
    now,
  });

  const body = buildIcsCalendar(feed.events, {
    name: subscription.name,
    now: new Date(now).toISOString(),
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Named so a client that saves rather than subscribes produces a
      // recognisable file. ASCII-only: the subscription name is user-supplied
      // and a raw one here would be a header-injection vector.
      "Content-Disposition": 'inline; filename="infrawrench.ics"',
      // Subscribed clients poll on their own schedule; an hour of shared cache
      // is well inside the resolution anything on this calendar has.
      "Cache-Control": "private, max-age=3600",
      // The feed is a credential-bearing URL. Keep it out of referrers and out
      // of any embedding context.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

export { app as publicCalendarRoutes };
