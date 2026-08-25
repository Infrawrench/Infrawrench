import { z } from "../zod";
import { strict, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const WallboardStatus = z.enum(["ok", "degraded", "down"]).openapi({
  description:
    "Three states rather than five, because at four metres a person distinguishes three colours " +
    "reliably and nothing more. `down` is reserved for the two things that mean customers are " +
    "affected now — a sev1 incident or a probe that is down; everything else that is wrong is " +
    "`degraded`. A source that could not be read is `degraded` and never `ok`.",
});

export function registerWallboardPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const WallboardTile = strict({
    id: z.string(),
    label: z.string(),
    value: z.string().describe("The number or short phrase, rendered in large type."),
    detail: z.string().nullable(),
    status: WallboardStatus,
  }).openapi("WallboardTile");

  const WallboardIncidentLine = strict({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
    startedAt: IsoDateTime,
    status: z.string(),
  }).openapi("WallboardIncidentLine");

  const WallboardFailureLine = strict({
    id: z.string(),
    label: z.string(),
    detail: z.string(),
    since: IsoDateTime.nullable(),
  }).openapi("WallboardFailureLine");

  const WallboardResponse = strict({
    status: WallboardStatus,
    tiles: z.array(WallboardTile),
    incidents: z.array(WallboardIncidentLine).describe("Unresolved incidents, newest first."),
    failures: z
      .array(WallboardFailureLine)
      .describe(
        "Probes that are down, query monitors breaching or unable to run, accounts that " +
          "stopped syncing.",
      ),
    failedSources: z
      .array(z.string())
      .describe(
        "Sources that could not be read, **named on the screen**. A wallboard showing green " +
          "because a query failed is worse than a blank one — it is actively telling the room " +
          "the wrong thing.",
      ),
    generatedAt: IsoDateTime,
  }).openapi("WallboardResponse");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/wallboard",
    tags: ["Wallboard"],
    summary: "Everything that is wrong right now, for a screen on a wall",
    description:
      "A different reading of data the product already holds, built on one rule: a wallboard may " +
      "only show things that are true **right now** and that somebody would cross a room to look " +
      "at. There is deliberately no history, no trend and no breakdown — those belong on the page " +
      "you open when you do walk over.\n\n" +
      "Four sources — declared incidents, synthetic probes, query monitors and account sync " +
      "health — each guarded independently, because a television that goes blank because one " +
      "query threw is showing nothing to a room that was relying on it.\n\n" +
      "Session-authenticated on purpose: unlike the calendar feed or a public status page, this " +
      "carries incident titles, probe names and account names, and a screen in an office is " +
      "exactly what a visitor photographs. The machine driving the wall signs in once.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The wall, as of now",
        content: { "application/json": { schema: WallboardResponse } },
      },
    },
  });
}
