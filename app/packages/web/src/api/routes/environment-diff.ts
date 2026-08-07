/**
 * Environment diff route (`/api/org/:orgId/environment-diff`).
 *
 * The comparison lives in server-core (`environment-diff.ts`) over the pure
 * `computeEnvironmentDiff` in client-core, so the web view, the desktop panel
 * and `infrawrench diff` all read the same computation. Purely a read over
 * already-synced state: no provider API calls.
 */
import { Hono } from "hono";
import {
  loadEnvironmentDiff,
  EnvironmentDiffAccountNotFoundError,
  EnvironmentDiffPluginMismatchError,
} from "@infrawrench/server-core/environment-diff";
import { requirePermission } from "../../auth/permissions";

const app = new Hono();

/**
 * GET /api/org/:orgId/environment-diff?a=…&b=…
 *
 * Compares two accounts of the same provider: which resource types exist in
 * one and not the other, the per-type count deltas, and the fields on which
 * two corresponding resources disagree.
 *
 * `resources:read` only — this reads the same rows the account pages do and
 * writes nothing.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const a = c.req.query("a");
  const b = c.req.query("b");
  if (!a || !b) {
    return c.json({ error: "Both a and b account ids are required" }, 400);
  }
  if (a === b) {
    return c.json({ error: "a and b must be different accounts" }, 400);
  }

  try {
    return c.json(
      await loadEnvironmentDiff(organizationId, a, b, {
        resourceTypeId: c.req.query("resourceTypeId"),
        includeIdentityFields: c.req.query("includeIdentityFields") === "true",
      }),
    );
  } catch (e) {
    // Both are user-input problems, not server faults: an id that isn't this
    // org's, and two accounts that can't meaningfully be compared.
    if (e instanceof EnvironmentDiffAccountNotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof EnvironmentDiffPluginMismatchError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export { app as environmentDiffRoutes };
