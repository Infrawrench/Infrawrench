/**
 * Credential hygiene (org-scoped, mounted at
 * /api/org/:orgId/credential-hygiene).
 *
 * A single read-only report over data we already hold: API keys nobody uses,
 * SSH keys nothing references, and members holding write permissions they have
 * never exercised.
 *
 * Gated on `audit:read` rather than a family of its own. Everything here is
 * derived from the audit log and the credential tables; anyone who can read
 * the audit log can already reach every fact in it by hand, and a separate
 * permission would only mean an org had to grant two things to get one view.
 * The report is a lens, not a new disclosure.
 */
import { Hono, type Context } from "hono";

import {
  MAX_HYGIENE_WINDOW_DAYS,
  MIN_HYGIENE_WINDOW_DAYS,
  buildHygieneReport,
} from "@infrawrench/server-core/hygiene/report";

import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * GET / — the report.
 *
 * `?windowDays=` sets the activity window (default 90). Not cached: the report
 * is a handful of indexed aggregates run when somebody opens a settings page,
 * and a stale governance report is a governance report people learn to
 * distrust.
 */
app.get("/", async (c: Context) => {
  requirePermission(c, "audit:read");
  const raw = c.req.query("windowDays");
  if (raw !== undefined) {
    const days = Number(raw);
    if (
      !Number.isInteger(days) ||
      days < MIN_HYGIENE_WINDOW_DAYS ||
      days > MAX_HYGIENE_WINDOW_DAYS
    ) {
      return c.json(
        {
          error: `windowDays must be an integer between ${MIN_HYGIENE_WINDOW_DAYS} and ${MAX_HYGIENE_WINDOW_DAYS}`,
        },
        400,
      );
    }
  }
  const report = await buildHygieneReport(c.get("organizationId") as string, {
    ...(raw !== undefined ? { windowDays: Number(raw) } : {}),
  });
  return c.json(report);
});

export default app;
