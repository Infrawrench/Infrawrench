import { Hono } from "hono";
import type { Context } from "hono";
import { billingProfileInputSchema } from "@infrawrench/ui/cost/config";
import { billingProfileAuditChanges, type BillingProfileInput } from "@infrawrench/client-core";
import {
  BillingProfileError,
  BillingProfileInUseError,
  BillingProfileNameConflictError,
  createBillingProfile,
  deleteBillingProfile,
  getBillingProfile,
  listBillingProfiles,
  updateBillingProfile,
} from "@infrawrench/server-core/cost/billing-profiles";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Billing profiles: the reusable invoice settings customers are assigned to.
 *
 * Same permission family as the customers themselves, for the same reason:
 * a profile holds a third party's legal entity and tax ID and the org's own
 * bank details. Reads are `invoices:read`; every write is `invoices:write`,
 * because editing a profile only ever reaches drafts (an approved invoice
 * carries its own copy) and so is revisable preparation, not issuing.
 *
 * Every write is audit-logged field by field, with account numbers masked to
 * their last four characters and the logo reduced to whether there is one:
 * the audit log is read by more people than the invoice is.
 */
const app = new Hono();

function writeError(c: Context, e: unknown): Response {
  if (e instanceof BillingProfileNameConflictError) return c.json({ error: e.message }, 409);
  if (e instanceof BillingProfileInUseError) {
    return c.json({ error: e.message, customers: e.customers }, 409);
  }
  if (e instanceof BillingProfileError) return c.json({ error: e.message }, 400);
  throw e;
}

/** GET /api/org/:orgId/billing-profiles: every profile, name-sorted. */
app.get("/", async (c) => {
  requirePermission(c, "invoices:read");
  return c.json(await listBillingProfiles(c.get("organizationId")));
});

/** GET /api/org/:orgId/billing-profiles/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "invoices:read");
  const profile = await getBillingProfile(c.get("organizationId"), c.req.param("id"));
  if (!profile) return c.json({ error: "Not found" }, 404);
  return c.json(profile);
});

/** POST /api/org/:orgId/billing-profiles */
app.post("/", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = billingProfileInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid billing profile", issues: parsed.error.issues }, 400);
  }
  let profile;
  try {
    profile = await createBillingProfile(
      organizationId,
      parsed.data as BillingProfileInput,
      session.userId,
    );
  } catch (e) {
    return writeError(c, e);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_profile.create",
    entityType: "billing_profile",
    entityId: profile.id,
    metadata: { name: profile.name, changes: billingProfileAuditChanges(null, profile) },
  });
  return c.json(profile);
});

/**
 * PUT /api/org/:orgId/billing-profiles/:id: full replace, except the logo,
 * which is left as saved when absent and removed by null.
 */
app.put("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = billingProfileInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid billing profile", issues: parsed.error.issues }, 400);
  }
  let result;
  try {
    result = await updateBillingProfile(
      organizationId,
      c.req.param("id"),
      parsed.data as BillingProfileInput,
    );
  } catch (e) {
    return writeError(c, e);
  }
  if (!result) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_profile.update",
    entityType: "billing_profile",
    entityId: result.after.id,
    metadata: {
      name: result.after.name,
      changes: billingProfileAuditChanges(result.before, result.after),
      // Who the change reaches: their drafts follow it, their issued invoices do not.
      managedAccountIds: result.after.managedAccountIds,
    },
  });
  return c.json(result.after);
});

/** DELETE /api/org/:orgId/billing-profiles/:id: refused while customers use it. */
app.delete("/:id", async (c) => {
  requirePermission(c, "invoices:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  let deleted;
  try {
    deleted = await deleteBillingProfile(organizationId, c.req.param("id"));
  } catch (e) {
    return writeError(c, e);
  }
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "billing_profile.delete",
    entityType: "billing_profile",
    entityId: deleted.id,
    metadata: { name: deleted.name },
  });
  return c.json({ ok: true });
});

export { app as billingProfileRoutes };
