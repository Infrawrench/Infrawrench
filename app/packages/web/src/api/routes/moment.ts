/**
 * The moment view — `GET /api/org/{orgId}/moment?at=…&window=…`.
 *
 * Thin route: the union itself (nine feeds, per-feed permission gating,
 * per-feed partial-failure tolerance) lives in `services/moment.ts`, shared
 * with the `what_changed` MCP tool.
 *
 * There is deliberately no single `requirePermission` gate here: the union
 * spans six different read permissions, and the service omits (not errors)
 * every feed the caller can't read. A caller who can read *nothing* gets the
 * same 403 as the change feed would give them.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  computeMoment,
  parseMomentTimestamp,
  MOMENT_FEED_PERMISSIONS,
} from "../../services/moment";

const app = new Hono();

app.get("/", async (c) => {
  const permissions = c.get("permissions") ?? [];
  const anyFeedReadable = Object.values(MOMENT_FEED_PERMISSIONS).some((permission) =>
    hasPermission(permissions, permission),
  );
  if (!anyFeedReadable) {
    throw new HTTPException(403, { message: "Missing permission: resources:read" });
  }

  const atRaw = c.req.query("at");
  let at: Date | undefined;
  if (atRaw !== undefined) {
    // Offset-less timestamps are pinned to UTC (shared with `what_changed`)
    // so the same URL means the same window wherever the server runs.
    const parsed = parseMomentTimestamp(atRaw);
    if (parsed === null) {
      return c.json({ error: "Invalid 'at' timestamp" }, 400);
    }
    at = parsed;
  }
  const windowRaw = c.req.query("window");
  let windowMinutes: number | undefined;
  if (windowRaw !== undefined) {
    windowMinutes = Number.parseInt(windowRaw, 10);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      return c.json({ error: "Invalid 'window' — expected a positive number of minutes" }, 400);
    }
  }

  const response = await computeMoment(c.get("organizationId"), {
    at,
    windowMinutes,
    permissions,
  });
  return c.json(response);
});

export { app as momentRoutes };
