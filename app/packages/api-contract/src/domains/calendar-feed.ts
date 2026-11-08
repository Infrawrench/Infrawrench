/**
 * The public iCalendar feed (`GET /api/calendar/:token.ics`), the endpoint
 * definition.
 *
 * No auth middleware, for the same reason public status pages have none: the
 * caller is Google Calendar or a phone, which cannot hold a session, a bearer
 * token or an API key. The opaque token in the path is the sole credential,
 * and unlike a status page's slug it is 32 random bytes, because this one
 * answers with the org's schedule rather than a page someone chose to
 * publish. The URL deliberately contains no organization id: a feed that
 * leaks exposes what it carries and nothing else, and must not become a way
 * to learn an org id and start probing org-scoped routes with it.
 *
 * The hand-written spec never documented the feed (calendar clients are its
 * only callers), so the operation stays out of the document.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { Security } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";

/** The feed body; `text/plain` "Not found" for an unknown or revoked token. */
export const IcsCalendar = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/calendar" }),
);

export class CalendarFeedGroup extends HttpApiGroup.make("calendarFeed")
  .add(
    HttpApiEndpoint.get("feed", "/:file", { params: { file: Schema.String }, success: IcsCalendar })
      .annotate(OpenApi.Summary, "Read an iCalendar feed")
      .annotate(Security, []),
  )
  .prefix("/api/calendar")
  .annotate(OpenApi.Title, "Operations calendar")
  // Undocumented, as the hand-written spec left it: no operations, no tag.
  .annotate(OpenApi.Exclude, true) {}

export class CalendarFeedApi extends withApiDefaults(
  HttpApi.make("calendarFeed").add(CalendarFeedGroup),
) {}
