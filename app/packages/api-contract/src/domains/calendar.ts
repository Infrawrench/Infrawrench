/**
 * Operations calendar: `/api/org/:orgId/calendar`, the endpoint definitions.
 *
 * Reads take `resources:read`: the calendar is a view over the org's own
 * records, and every one of its six sources is already readable with that
 * permission or less. Subscriptions take `org:settings:write`: minting an
 * unauthenticated URL that exposes the org's schedule to anyone holding it is
 * an org-wide decision, not a personal preference.
 *
 * The window and the subscription body are checked by hand in the handlers,
 * with the sentences the routes always answered with, so the query carries
 * plain strings and the create endpoint is served raw. The public iCalendar
 * feed itself (`/api/calendar/:token.ics`) is `../calendar-feed`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CALENDAR_EVENT_KINDS } from "@infrawrench/client-core";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";

const CalendarEventKind = Schema.Literals(CALENDAR_EVENT_KINDS).annotate({
  description:
    "Which of the organization's own records the event was projected from. The kinds are " +
    "sources rather than a severity taxonomy: a reader scanning a month wants to know that " +
    "one bar is a freeze and another is a certificate.",
});

const CalendarEventLink = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      target: Schema.Literal("resource"),
      accountId: Uuid,
      resourceId: Schema.String,
    }),
    Schema.Struct({
      target: Schema.Literal("tab"),
      tab: Schema.Literals(["expiring", "incidents", "workflows", "costs", "settings"]),
    }),
  ]),
).annotate({
  identifier: "CalendarEventLink",
  description:
    "Where opening the event should go; a hint rather than a URL, because each surface " +
    "addresses its own pages differently.",
});

const CalendarEvent = Schema.Struct({
  id: Schema.String.annotate({
    description:
      "Stable across renders for the same underlying thing, because it becomes the " +
      "iCalendar UID. Recurring sources (sleep windows, cron runs) key it by occurrence.",
  }),
  kind: CalendarEventKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  startsAt: IsoDateTime.annotate({
    description:
      "Clamped to the requested window's lower bound when the underlying span began earlier; " +
      "`openEnded` says so.",
  }),
  endsAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "Null means a point in time (a deadline, a scheduled run) or a span whose end is not " +
      "known. `openEnded` distinguishes the two.",
  }),
  openEnded: Schema.Boolean.annotate({
    description:
      "The span continues past an edge of the window, or has no declared end at all (a " +
      "freeze held until further notice, an unresolved incident).",
  }),
  allDay: Schema.Boolean.annotate({
    description:
      "The event is meaningful only to the day; a deadline read off a date field. Rendering " +
      "such a thing at the provider's stored midnight would be false precision.",
  }),
  severity: Schema.Literals(["critical", "warning", "info"]),
  link: CalendarEventLink,
}).annotate({ identifier: "CalendarEvent" });

export const CalendarResponse = Schema.Struct({
  events: Schema.Array(CalendarEvent).annotate({
    description: "Soonest first; longer spans before shorter ones.",
  }),
  from: IsoDateTime,
  to: IsoDateTime,
  emptyKinds: Schema.Array(CalendarEventKind).annotate({
    description: "Kinds that were asked for and produced no events in this window.",
  }),
  failedKinds: Schema.Array(CalendarEventKind).annotate({
    description:
      "Sources that threw. Reported rather than swallowed: 'nothing scheduled' and 'we could " +
      "not read it' are different answers, and one failing source must not empty the page.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "CalendarResponse" });

export const CalendarSubscription = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  kinds: Schema.Array(CalendarEventKind).annotate({
    description: "Kinds the feed carries. Empty means every kind, including ones added later.",
  }),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The subscription URL, returned **only** by the create call; the token it contains is " +
        "stored hashed and cannot be shown again. Lose it and mint a new feed.",
    }),
  ),
  createdAt: IsoDateTime,
  lastAccessedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "Last fetch, written at most hourly. Its purpose is answering 'is anyone still using " +
      "this?' before revoking, which an hour of staleness cannot change.",
  }),
  revokedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "CalendarSubscription" });

export const CalendarSubscriptionList = Schema.Struct({
  subscriptions: Schema.Array(CalendarSubscription),
}).annotate({ identifier: "CalendarSubscriptionList" });

const CalendarSubscriptionCreate = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(80)),
  kinds: Schema.optionalKey(Schema.Array(CalendarEventKind).check(maxLength(6))),
}).annotate({ identifier: "CalendarSubscriptionCreate" });

export class CalendarGroup extends HttpApiGroup.make("calendar")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        from: Schema.optionalKey(
          IsoDateTime.annotate({ description: "Inclusive lower bound. Defaults to 7 days ago." }),
        ),
        to: Schema.optionalKey(
          IsoDateTime.annotate({
            description: "Exclusive upper bound. Defaults to 35 days ahead.",
          }),
        ),
        kinds: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "Comma-separated `CalendarEventKind`s. Unknown members are ignored rather than " +
              "rejected; omitting the parameter returns every kind.",
          }),
        ),
      },
      success: CalendarResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List dated operational events in a window")
      .annotate(
        OpenApi.Description,
        "One time axis over six things the organization already stores: change freezes, sleep/wake " +
          "schedules, declared deadlines (certificates, domains, keys and resource leases), " +
          "commitment term ends, cron-triggered workflow runs, and declared incidents. Nothing here " +
          "is a new record; the calendar is recomputed on every read, exactly as posture findings " +
          "and backup coverage are.\n\n" +
          "The window defaults to the last 7 and next 35 days and may span at most 400. Recurring " +
          "sources are expanded to at most 400 occurrences each, so one nightly schedule cannot " +
          "flood a year-long query.",
      )
      .annotate(SuccessDescription, "Events in the window, soonest first"),
    HttpApiEndpoint.get("listSubscriptions", "/subscriptions", {
      params: OrgParams,
      success: CalendarSubscriptionList,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List the organization's iCalendar subscriptions")
      .annotate(
        OpenApi.Description,
        "Feed URLs that have been minted, including revoked ones; a revoked row is kept so the " +
          "audit trail still resolves. The token itself is never returned.",
      )
      .annotate(SuccessDescription, "Subscriptions, newest first"),
    HttpApiEndpoint.post("createSubscription", "/subscriptions", {
      params: OrgParams,
      payload: CalendarSubscriptionCreate,
      success: CalendarSubscription,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Mint an iCalendar subscription URL")
      .annotate(
        OpenApi.Description,
        "Returns the only copy of the feed URL. The token in it is 32 random bytes, stored as a " +
          "SHA-256 hash, and is the sole credential on a route that runs outside every auth layer; " +
          "treat the URL as a secret. The URL deliberately contains no organization id.\n\n" +
          "An organization may hold 25 live subscriptions; revoking makes room.",
      )
      .annotate(SuccessDescription, "The created subscription, including its one-time `url`")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("revokeSubscription", "/subscriptions/:subscriptionId", {
      params: { orgId: OrgId, subscriptionId: Uuid },
      success: CalendarSubscription,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Revoke an iCalendar subscription")
      .annotate(
        OpenApi.Description,
        "The URL stops working immediately. The row is kept, and revoking twice is not an error.",
      )
      .annotate(SuccessDescription, "The revoked subscription"),
  )
  .prefix("/api/org/:orgId/calendar")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Operations calendar") {}

export class CalendarApi extends withApiDefaults(HttpApi.make("calendar").add(CalendarGroup)) {}
