/**
 * Managing the agent registrations that act in an organization.
 *
 * Sits under the org tree, so it inherits the whole middleware stack. Gated on
 * `team:read` / `team:invite` rather than a permission of its own: a
 * registration is a member of the organization in every sense that matters to a
 * reader of this page — it holds a membership row and acts with authority — and
 * inventing `agents:*` would mean every existing custom role silently lacked
 * it.
 */
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { agentAuthRegistrations, users } from "../../db/schema";
import { revokeAgentRegistration } from "@infrawrench/server-core/trials/ceremony";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";

const app = new Hono();

/** GET /api/org/:orgId/agent-registrations */
app.get("/", async (c) => {
  requirePermission(c, "team:read");
  const organizationId = c.get("organizationId");

  const rows = await db
    .select({
      id: agentAuthRegistrations.id,
      label: agentAuthRegistrations.label,
      kind: agentAuthRegistrations.kind,
      prefix: agentAuthRegistrations.credentialPrefix,
      claimedAt: agentAuthRegistrations.claimedAt,
      claimedByUserId: agentAuthRegistrations.claimedByUserId,
      claimedByEmail: users.email,
      lastSeenAt: agentAuthRegistrations.lastSeenAt,
      revokedAt: agentAuthRegistrations.revokedAt,
      createdAt: agentAuthRegistrations.createdAt,
    })
    .from(agentAuthRegistrations)
    .leftJoin(users, eq(users.id, agentAuthRegistrations.claimedByUserId))
    .where(eq(agentAuthRegistrations.organizationId, organizationId))
    .orderBy(desc(agentAuthRegistrations.createdAt));

  return c.json(rows);
});

/**
 * DELETE /api/org/:orgId/agent-registrations/:id — revoke.
 *
 * Revoke, not delete. The row is how an audit entry naming this agent stays
 * legible, and how "what did that thing do before we cut it off" remains
 * answerable — `resolveAgentPrincipal` refuses a revoked row on the next
 * request, which is what actually ends the access.
 *
 * Gated on `team:invite` because revoking an agent is the same class of act as
 * removing a member, and `team:read` must not be enough to do it.
 */
app.delete("/:id", async (c) => {
  requirePermission(c, "team:invite");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  // Scoped to the org before the update: without this, any org's admin could
  // revoke any registration whose id they happened to learn.
  const [row] = await db
    .select({ id: agentAuthRegistrations.id })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.id, id),
        eq(agentAuthRegistrations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Agent registration not found" }, 404);

  const revoked = await revokeAgentRegistration(id);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "agent.revoke",
    entityType: "agent_registration",
    entityId: id,
    metadata: { alreadyRevoked: !revoked },
  });

  return c.json({ ok: true, revoked });
});

export { app as agentRegistrationRoutes };
