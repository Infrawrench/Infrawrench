import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const CalendarEventKind = z
  .enum([
    "change-freeze",
    "sleep-schedule",
    "expiry",
    "commitment-expiry",
    "workflow-schedule",
    "incident",
  ])
  .openapi({
    description:
      "Which of the organization's own records the event was projected from. The kinds are " +
      "sources rather than a severity taxonomy: a reader scanning a month wants to know that " +
      "one bar is a freeze and another is a certificate.",
  });

const CalendarEventSeverity = z.enum(["critical", "warning", "info"]);

export function registerCalendarPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const CalendarEventLink = z
    .union([
      strict({
        target: z.literal("resource"),
        accountId: Uuid,
        resourceId: z.string(),
      }),
      strict({
        target: z.literal("tab"),
        tab: z.enum(["expiring", "incidents", "workflows", "costs", "settings"]),
      }),
    ])
    .openapi("CalendarEventLink", {
      description:
        "Where opening the event should go — a hint rather than a URL, because each surface " +
        "addresses its own pages differently.",
    });

  const CalendarEvent = strict({
    id: z
      .string()
      .describe(
        "Stable across renders for the same underlying thing, because it becomes the " +
          "iCalendar UID. Recurring sources (sleep windows, cron runs) key it by occurrence.",
      ),
    kind: CalendarEventKind,
    title: z.string(),
    detail: z.string().nullable(),
    startsAt: IsoDateTime.describe(
      "Clamped to the requested window's lower bound when the underlying span began earlier; " +
        "`openEnded` says so.",
    ),
    endsAt: IsoDateTime.nullable().describe(
      "Null means a point in time — a deadline, a scheduled run — or a span whose end is not " +
        "known. `openEnded` distinguishes the two.",
    ),
    openEnded: z
      .boolean()
      .describe(
        "The span continues past an edge of the window, or has no declared end at all (a " +
          "freeze held until further notice, an unresolved incident).",
      ),
    allDay: z
      .boolean()
      .describe(
        "The event is meaningful only to the day — a deadline read off a date field. Rendering " +
          "such a thing at the provider's stored midnight would be false precision.",
      ),
    severity: CalendarEventSeverity,
    link: CalendarEventLink.nullable(),
  }).openapi("CalendarEvent");

  const CalendarResponse = strict({
    events: z.array(CalendarEvent).describe("Soonest first; longer spans before shorter ones."),
    from: IsoDateTime,
    to: IsoDateTime,
    emptyKinds: z
      .array(CalendarEventKind)
      .describe("Kinds that were asked for and produced no events in this window."),
    failedKinds: z
      .array(CalendarEventKind)
      .describe(
        "Sources that threw. Reported rather than swallowed: 'nothing scheduled' and 'we could " +
          "not read it' are different answers, and one failing source must not empty the page.",
      ),
    generatedAt: IsoDateTime,
  }).openapi("CalendarResponse");

  const CalendarSubscription = strict({
    id: Uuid,
    name: z.string(),
    kinds: z
      .array(CalendarEventKind)
      .describe("Kinds the feed carries. Empty means every kind, including ones added later."),
    url: z
      .string()
      .optional()
      .describe(
        "The subscription URL, returned **only** by the create call — the token it contains is " +
          "stored hashed and cannot be shown again. Lose it and mint a new feed.",
      ),
    createdAt: IsoDateTime,
    lastAccessedAt: IsoDateTime.nullable().describe(
      "Last fetch, written at most hourly. Its purpose is answering 'is anyone still using " +
        "this?' before revoking, which an hour of staleness cannot change.",
    ),
    revokedAt: IsoDateTime.nullable(),
  }).openapi("CalendarSubscription");

  const CalendarSubscriptionList = strict({
    subscriptions: z.array(CalendarSubscription),
  }).openapi("CalendarSubscriptionList");

  const CalendarSubscriptionCreate = strict({
    name: z.string().min(1).max(80),
    kinds: z.array(CalendarEventKind).max(6).optional(),
  }).openapi("CalendarSubscriptionCreate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/calendar",
    tags: ["Operations calendar"],
    summary: "List dated operational events in a window",
    description:
      "One time axis over six things the organization already stores: change freezes, sleep/wake " +
      "schedules, declared deadlines (certificates, domains, keys and resource leases), " +
      "commitment term ends, cron-triggered workflow runs, and declared incidents. Nothing here " +
      "is a new record — the calendar is recomputed on every read, exactly as posture findings " +
      "and backup coverage are.\n\n" +
      "The window defaults to the last 7 and next 35 days and may span at most 400. Recurring " +
      "sources are expanded to at most 400 occurrences each, so one nightly schedule cannot " +
      "flood a year-long query.",
    request: {
      params: OrgIdParam,
      query: z.object({
        from: IsoDateTime.optional().describe("Inclusive lower bound. Defaults to 7 days ago."),
        to: IsoDateTime.optional().describe("Exclusive upper bound. Defaults to 35 days ahead."),
        kinds: z
          .string()
          .optional()
          .describe(
            "Comma-separated `CalendarEventKind`s. Unknown members are ignored rather than " +
              "rejected; omitting the parameter returns every kind.",
          ),
      }),
    },
    responses: {
      200: {
        description: "Events in the window, soonest first",
        content: { "application/json": { schema: CalendarResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/calendar/subscriptions",
    tags: ["Operations calendar"],
    summary: "List the organization's iCalendar subscriptions",
    description:
      "Feed URLs that have been minted, including revoked ones — a revoked row is kept so the " +
      "audit trail still resolves. The token itself is never returned.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Subscriptions, newest first",
        content: { "application/json": { schema: CalendarSubscriptionList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/calendar/subscriptions",
    tags: ["Operations calendar"],
    summary: "Mint an iCalendar subscription URL",
    description:
      "Returns the only copy of the feed URL. The token in it is 32 random bytes, stored as a " +
      "SHA-256 hash, and is the sole credential on a route that runs outside every auth layer — " +
      "treat the URL as a secret. The URL deliberately contains no organization id.\n\n" +
      "An organization may hold 25 live subscriptions; revoking makes room.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CalendarSubscriptionCreate } } },
    },
    responses: {
      200: {
        description: "The created subscription, including its one-time `url`",
        content: { "application/json": { schema: CalendarSubscription } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/calendar/subscriptions/{subscriptionId}",
    tags: ["Operations calendar"],
    summary: "Revoke an iCalendar subscription",
    description:
      "The URL stops working immediately. The row is kept, and revoking twice is not an error.",
    request: { params: OrgIdParam.extend({ subscriptionId: Uuid }) },
    responses: {
      200: {
        description: "The revoked subscription",
        content: { "application/json": { schema: CalendarSubscription } },
      },
      404: ErrorResponses[404],
    },
  });
}
