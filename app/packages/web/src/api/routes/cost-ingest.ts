/**
 * Cost push — `POST /api/org/:orgId/costs/rows`.
 *
 * Lets a server outside Infrawrench report spend it already knows about (a
 * parsed SaaS invoice, an internal chargeback, a colo bill) into the same
 * `cost_daily` table the provider collectors write to, so it shows up in cost
 * graphs, dimension filters, and budgets with no special-casing.
 *
 * Mounted outside the org tree's middleware stack because that stack 401s
 * `iwk_` API keys, and an unattended server has nothing else to authenticate
 * with — see `auth/org-request-auth.ts`.
 */
import { Hono } from "hono";
import { z } from "zod";

import {
  CostIngestError,
  MAX_EXTERNAL_COST_ROWS_PER_CALL,
  writeExternalCostRows,
} from "@infrawrench/server-core/cost/external-costs";

import { authenticateOrgRequest } from "../../auth/org-request-auth";
import { logAudit } from "../../services/audit";

const app = new Hono();

/**
 * The envelope only. Per-row validation belongs to the shared ingest module,
 * whose messages name the offending row index and are identical to the ones
 * `infra.costs.write` gives workflow authors.
 */
const bodySchema = z.object({
  source: z.string(),
  rows: z.array(z.record(z.unknown())).max(MAX_EXTERNAL_COST_ROWS_PER_CALL),
});

/** POST /api/org/:orgId/costs/rows — push cost rows for a named source. */
app.post("/rows", async (c) => {
  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: "Missing organization ID" }, 400);

  const auth = await authenticateOrgRequest(c, orgId, "costs:write");
  if (auth instanceof Response) return auth;

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await writeExternalCostRows({
      organizationId: orgId,
      source: parsed.data.source,
      rows: parsed.data.rows as never,
    });

    void logAudit({
      organizationId: orgId,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      action: "costs.push",
      entityType: "costs",
      entityId: parsed.data.source,
      metadata: { rows: result.written },
    });

    return c.json(result);
  } catch (e) {
    // Everything the caller can fix is a CostIngestError; anything else is ours.
    if (e instanceof CostIngestError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

export { app as costIngestRoutes };
