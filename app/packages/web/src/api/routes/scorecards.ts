import { Hono, type Context } from "hono";
import {
  ORG_SCORECARD_RETENTION_DAYS,
  isServiceTier,
  type ScorecardInput,
} from "@infrawrench/client-core";
import {
  ScorecardInputError,
  createScorecardRecord,
  deleteScorecardRecord,
  ensureDefaultScorecard,
  getScorecardRecord,
  listScorecardRecords,
  listScorecardResults,
  scorecardToWire,
  updateScorecardRecord,
} from "@infrawrench/server-core/scorecards/store";
import { evaluateOrgScorecards } from "@infrawrench/server-core/scorecards/eval";
import {
  getOrgScorecard,
  listOrgScorecardTrend,
} from "@infrawrench/server-core/scorecards/org-snapshots";
import { listServiceRecords } from "@infrawrench/server-core/service-catalog/store";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { parseObjectBody } from "../object-body";

/**
 * Scorecards: org-defined checks, weights and levels every service is graded
 * against. CRUD, the overview matrix, and an evaluate-now for the editor.
 * Scoring itself runs hourly in the poller (`server-core/src/scorecards/`).
 *
 * The org grade (`/org`, `/org/history`) is the header above the matrix:
 * seven pillars read from existing feeds, one of them these scorecards'
 * results, with a daily history the poller records.
 *
 * Reads are `resources:read`, writes `resources:write`: the SLO stance.
 * The first read seeds the default scorecard for orgs created before
 * scorecards existed (once; a deleted default stays deleted).
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function scorecardErrorResponse(c: Context, err: unknown) {
  if (err instanceof ScorecardInputError) return c.json({ error: err.message }, err.status);
  console.error("[scorecards] unexpected error:", err);
  return c.json({ error: "Scorecard operation failed" }, 500);
}

function pickScorecardBody(body: Record<string, unknown>): Partial<ScorecardInput> | string {
  const out: Partial<ScorecardInput> = {};
  if (typeof body["name"] === "string") out.name = body["name"];
  if (body["description"] === null || typeof body["description"] === "string") {
    out.description = body["description"] as string | null;
  }
  if (body["checks"] !== undefined) {
    const checks = body["checks"];
    if (!Array.isArray(checks) || !checks.every((c) => c && typeof c === "object")) {
      return "checks must be an array of check objects";
    }
    out.checks = checks.map((raw) => {
      const c = raw as Record<string, unknown>;
      return {
        id: typeof c["id"] === "string" ? c["id"] : "",
        type: c["type"] as ScorecardInput["checks"][number]["type"],
        name: typeof c["name"] === "string" ? c["name"] : null,
        weight: typeof c["weight"] === "number" ? c["weight"] : 1,
        params:
          c["params"] && typeof c["params"] === "object" && !Array.isArray(c["params"])
            ? (c["params"] as Record<string, number | string[]>)
            : {},
      };
    });
  }
  if (body["levels"] !== undefined) {
    const levels = body["levels"];
    if (!Array.isArray(levels) || !levels.every((l) => l && typeof l === "object")) {
      return "levels must be an array of level objects";
    }
    out.levels = levels.map((raw) => {
      const l = raw as Record<string, unknown>;
      return {
        key: typeof l["key"] === "string" ? l["key"] : "",
        name: typeof l["name"] === "string" ? l["name"] : "",
        minScore: typeof l["minScore"] === "number" ? l["minScore"] : Number.NaN,
        color: typeof l["color"] === "string" ? l["color"] : null,
      };
    });
  }
  if (body["applicableTiers"] !== undefined) {
    const tiers = body["applicableTiers"];
    if (!Array.isArray(tiers) || !tiers.every(isServiceTier)) {
      return "applicableTiers must be an array of 1, 2, 3 or 4";
    }
    out.applicableTiers = tiers;
  }
  if (typeof body["alertOnLevelDrop"] === "boolean") {
    out.alertOnLevelDrop = body["alertOnLevelDrop"];
  }
  if (typeof body["enabled"] === "boolean") out.enabled = body["enabled"];
  return out;
}

async function overview(organizationId: string) {
  const [cards, rows, results] = await Promise.all([
    listScorecardRecords(organizationId),
    listServiceRecords(organizationId),
    listScorecardResults(organizationId),
  ]);
  return {
    scorecards: cards.map(scorecardToWire),
    services: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      tier: isServiceTier(r.tier) ? r.tier : null,
      ownerTeam: r.ownerTeam,
    })),
    results,
  };
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  await ensureDefaultScorecard(organizationId);
  const rows = await listScorecardRecords(organizationId);
  return c.json({ scorecards: rows.map(scorecardToWire) });
});

/** The matrix: every service, every scorecard, the current result in each cell. */
app.get("/overview", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  await ensureDefaultScorecard(organizationId);
  return c.json(await overview(organizationId));
});

/**
 * The org grade: seven pillars, the weighted overall and the stored history.
 * Never seeds the default scorecard (a read of the grade must not create
 * configuration). `resources:read`, like every feed it reads: gating the
 * summary more tightly than its parts would be a lock on a door with no
 * walls. Listed as a gateway route: the posture and backup pillars bind
 * plugin functions the edge Worker only stubs.
 */
app.get("/org", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getOrgScorecard(c.get("organizationId")));
});

/**
 * The org grade's history alone, the cheap half: a tile that wants only the
 * sparkline should not pay for seven feed computations. Postgres only, so it
 * stays on the edge.
 */
app.get("/org/history", async (c) => {
  requirePermission(c, "resources:read");
  const raw = c.req.query("days");
  const days = raw === undefined ? undefined : Number(raw);
  if (
    days !== undefined &&
    (!Number.isInteger(days) || days < 1 || days > ORG_SCORECARD_RETENTION_DAYS)
  ) {
    return c.json(
      { error: `days must be a whole number between 1 and ${ORG_SCORECARD_RETENTION_DAYS}` },
      400,
    );
  }
  const trend = await listOrgScorecardTrend(
    c.get("organizationId"),
    days === undefined ? {} : { days },
  );
  return c.json({ trend });
});

app.get("/:id", async (c) => {
  requirePermission(c, "resources:read");
  const row = await getScorecardRecord(c.get("organizationId"), c.req.param("id"));
  if (!row) return c.json({ error: "Scorecard not found" }, 404);
  return c.json(scorecardToWire(row));
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const input = pickScorecardBody(body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const created = await createScorecardRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "scorecard.create",
      entityType: "scorecard",
      entityId: created.id,
      metadata: { name: created.name, checks: created.checks.length },
    });
    return c.json(scorecardToWire(created), 201);
  } catch (err) {
    return scorecardErrorResponse(c, err);
  }
});

app.patch("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const patch = pickScorecardBody(body);
  if (typeof patch === "string") return c.json({ error: patch }, 400);
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);
  try {
    const updated = await updateScorecardRecord(organizationId, c.req.param("id"), patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "scorecard.update",
      entityType: "scorecard",
      entityId: updated.id,
      metadata: { name: updated.name, fields: Object.keys(patch) },
    });
    return c.json(scorecardToWire(updated));
  } catch (err) {
    return scorecardErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const deleted = await deleteScorecardRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "scorecard.delete",
      entityType: "scorecard",
      entityId: deleted.id,
      metadata: { name: deleted.name },
    });
    return c.body(null, 204);
  } catch (err) {
    return scorecardErrorResponse(c, err);
  }
});

/**
 * Score every service on this scorecard now, so the editor shows the effect
 * of a change without waiting for the hourly pass. Drops found here are
 * stored but not announced: the person who just edited the checks caused
 * them, and paging the org about it would be noise.
 */
app.post("/:id/evaluate", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const row = await getScorecardRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "Scorecard not found" }, 404);
  try {
    await evaluateOrgScorecards(organizationId, { scorecardIds: [row.id], announce: false });
    return c.json(await overview(organizationId));
  } catch (err) {
    return scorecardErrorResponse(c, err);
  }
});

export { app as scorecardRoutes };
