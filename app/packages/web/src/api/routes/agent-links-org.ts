/**
 * The agent links connected to an organization, for Settings → Agents.
 *
 * Gated like `agent-registrations.ts` and for the same reason: `team:read` to
 * see them, `team:invite` to cut one off, since a link is a standing door for
 * agents into the org and revoking it is the same class of act as removing a
 * member. Agents cannot reach the mutation (`AGENT_DENY_RULES`).
 */
import { Hono } from "hono";
import { getLink, listOrgLinks, revokeLink } from "@infrawrench/server-core/agent-links/links";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { buildOrgLinkSummary } from "../../services/agent-links";

const app = new Hono();

/** GET /api/org/:orgId/agent-links */
app.get("/", async (c) => {
  requirePermission(c, "team:read");
  const rows = await listOrgLinks(c.get("organizationId"));
  return c.json(await Promise.all(rows.map((row) => buildOrgLinkSummary(row))));
});

/** DELETE /api/org/:orgId/agent-links/:id: revoke the link and its agents. */
app.delete("/:id", async (c) => {
  requirePermission(c, "team:invite");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  // Scoped to the org before the update, so an id learned elsewhere is a 404.
  const link = await getLink(organizationId, c.req.param("id"));
  if (!link) return c.json({ error: "Agent link not found" }, 404);
  const revoked = await revokeLink(link.id);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "agent_link.revoke",
    entityType: "agent_link",
    entityId: link.id,
    metadata: { platform: link.platform, by: "member", alreadyRevoked: !revoked },
  });
  return c.json({ ok: true, revoked });
});

export { app as agentLinkOrgRoutes };
