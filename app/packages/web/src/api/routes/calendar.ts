/**
 * Operations calendar routes (`/api/org/:orgId/calendar*`).
 *
 * The feed is assembled in server-core (`calendar/feed.ts`) so this route, the
 * iCalendar subscription route and any future digest section share one
 * computation. Purely a read over already-synced state: no provider API calls.
 *
 * Reads take `resources:read` — the calendar is a view over the org's own
 * records, and every one of its six sources is already readable with that
 * permission or less. Subscriptions take `org:settings:write`: minting an
 * unauthenticated URL that exposes the org's schedule to anyone holding it is
 * an org-wide decision, not a personal preference, and it is the same call the
 * API-key surface makes.
 */
import { Hono } from "hono";
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

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

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
  from?: string | undefined;
  to?: string | undefined;
  kinds?: string | undefined;
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
 * GET /api/org/:orgId/calendar — every dated thing the org holds, in one
 * window, soonest first.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const parsed = parseWindow({
    from: c.req.query("from"),
    to: c.req.query("to"),
    kinds: c.req.query("kinds"),
  });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  return c.json(await listCalendarEvents(c.get("organizationId"), parsed.value));
});

/** GET /api/org/:orgId/calendar/subscriptions — the org's iCalendar feeds. */
app.get("/subscriptions", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json({ subscriptions: await listCalendarSubscriptions(c.get("organizationId")) });
});

/**
 * POST /api/org/:orgId/calendar/subscriptions — mint one.
 *
 * The response carries the only copy of the token, as an absolute URL ready to
 * paste into a calendar client. The audit entry deliberately records the name
 * and the kinds but not the prefix: a prefix in an audit log is eight
 * characters of a live credential sitting in a surface more people can read
 * than can mint.
 */
app.post("/subscriptions", async (c) => {
  requirePermission(c, "org:settings:write");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await c.req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = body["name"];
  if (typeof name !== "string") return c.json({ error: "name is required" }, 400);
  const kinds = parseCalendarKinds(body["kinds"]);

  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  try {
    const created = await createCalendarSubscription(
      organizationId,
      { name, kinds },
      userId ?? null,
    );
    void logAudit({
      organizationId,
      userId,
      action: "calendar_subscription.create",
      entityType: "calendar_subscription",
      entityId: created.subscription.id,
      metadata: { name: created.subscription.name, kinds: created.subscription.kinds },
    });
    return c.json({
      ...created.subscription,
      url: new URL(`/api/calendar/${created.token}.ics`, c.req.url).toString(),
    });
  } catch (err) {
    if (err instanceof CalendarSubscriptionInputError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }
});

/** DELETE /api/org/:orgId/calendar/subscriptions/:id — revoke one. */
app.delete("/subscriptions/:subscriptionId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const subscriptionId = c.req.param("subscriptionId");
  try {
    const subscription = await revokeCalendarSubscription(organizationId, subscriptionId);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "calendar_subscription.revoke",
      entityType: "calendar_subscription",
      entityId: subscriptionId,
      metadata: { name: subscription.name },
    });
    return c.json(subscription);
  } catch (err) {
    if (err instanceof CalendarSubscriptionInputError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }
});

export { app as calendarRoutes };
