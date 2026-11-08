/**
 * Wallboard: `/api/org/:orgId/wallboard`, the endpoint definitions.
 *
 * `resources:read` and a signed-in caller, deliberately: unlike the calendar
 * feed and the public status pages, this is not an unauthenticated surface.
 * A wallboard carries incident titles, probe names and account names, and a
 * television in an office is exactly the screen a visitor photographs.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams } from "../http/schemas/common";

const WallboardStatus = Schema.Literals(["ok", "degraded", "down"]).annotate({
  description:
    "Three states rather than five, because at four metres a person distinguishes three colours " +
    "reliably and nothing more. `down` is reserved for the two things that mean customers are " +
    "affected now: a sev1 incident or a probe that is down; everything else that is wrong is " +
    "`degraded`. A source that could not be read is `degraded` and never `ok`.",
});

const WallboardTile = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  value: Schema.String.annotate({
    description: "The number or short phrase, rendered in large type.",
  }),
  detail: Schema.NullOr(Schema.String),
  status: WallboardStatus,
}).annotate({ identifier: "WallboardTile" });

const WallboardIncidentLine = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  severity: Schema.String,
  startedAt: IsoDateTime,
  status: Schema.String,
}).annotate({ identifier: "WallboardIncidentLine" });

const WallboardFailureLine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  since: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "WallboardFailureLine" });

export const WallboardResponse = Schema.Struct({
  status: WallboardStatus,
  tiles: Schema.Array(WallboardTile),
  incidents: Schema.Array(WallboardIncidentLine).annotate({
    description: "Unresolved incidents, newest first.",
  }),
  failures: Schema.Array(WallboardFailureLine).annotate({
    description:
      "Probes that are down, query monitors breaching or unable to run, accounts that " +
      "stopped syncing.",
  }),
  failedSources: Schema.Array(Schema.String).annotate({
    description:
      "Sources that could not be read, **named on the screen**. A wallboard showing green " +
      "because a query failed is worse than a blank one; it is actively telling the room " +
      "the wrong thing.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "WallboardResponse" });

export class WallboardGroup extends HttpApiGroup.make("wallboard")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: WallboardResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Everything that is wrong right now, for a screen on a wall")
      .annotate(
        OpenApi.Description,
        "A different reading of data the product already holds, built on one rule: a wallboard may " +
          "only show things that are true **right now** and that somebody would cross a room to look " +
          "at. There is deliberately no history, no trend and no breakdown; those belong on the page " +
          "you open when you do walk over.\n\n" +
          "Four sources (declared incidents, synthetic probes, query monitors and account sync " +
          "health) each guarded independently, because a television that goes blank because one " +
          "query threw is showing nothing to a room that was relying on it.\n\n" +
          "Session-authenticated on purpose: unlike the calendar feed or a public status page, this " +
          "carries incident titles, probe names and account names, and a screen in an office is " +
          "exactly what a visitor photographs. The machine driving the wall signs in once.",
      )
      .annotate(SuccessDescription, "The wall, as of now"),
  )
  .prefix("/api/org/:orgId/wallboard")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Wallboard") {}

export class WallboardApi extends withApiDefaults(HttpApi.make("wallboard").add(WallboardGroup)) {}
