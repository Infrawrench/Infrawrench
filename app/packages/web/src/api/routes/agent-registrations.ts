/**
 * Managing the agent registrations that act in an organization.
 *
 * Sits under the org tree, so it inherits the whole middleware stack. Gated on
 * `team:read` / `team:invite` rather than a permission of its own: a
 * registration is a member of the organization in every sense that matters to a
 * reader of this page (it holds a membership row and acts with authority) and
 * inventing `agents:*` would mean every existing custom role silently lacked
 * it.
 */
import { Hono } from "hono";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { agentAuthRegistrations, users } from "../../db/schema";
import { revokeAgentRegistration } from "@infrawrench/server-core/trials/ceremony";
import {
  AgentLinkError,
  LABEL_MAX,
  getLink,
  getLinkAgent,
  linkEffectiveScopes,
  updatePlatformAgent,
  validateAgentGrant,
} from "@infrawrench/server-core/agent-links/links";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { serializeAgent, unknownProviders } from "../../services/agent-links";

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
      linkId: agentAuthRegistrations.linkId,
      externalId: agentAuthRegistrations.externalId,
      scopes: agentAuthRegistrations.scopes,
      providers: agentAuthRegistrations.providers,
    })
    .from(agentAuthRegistrations)
    .leftJoin(users, eq(users.id, agentAuthRegistrations.claimedByUserId))
    .where(eq(agentAuthRegistrations.organizationId, organizationId))
    .orderBy(desc(agentAuthRegistrations.createdAt));

  return c.json(rows);
});

/**
 * DELETE /api/org/:orgId/agent-registrations/:id: revoke.
 *
 * Revoke, not delete. The row is how an audit entry naming this agent stays
 * legible, and how "what did that thing do before we cut it off" remains
 * answerable: `resolveAgentPrincipal` refuses a revoked row on the next
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

/**
 * PATCH /api/org/:orgId/agent-registrations/:id: edit a platform agent's
 * label, scopes and providers from Settings → Agents.
 *
 * Only platform agents have scopes of their own; a trial or service agent's
 * authority is its claimer's role and there is nothing here to edit. The
 * grant is validated against the link's current ceiling exactly as the
 * platform's own PATCH is, and additionally a person may only *add* scopes
 * they hold themselves, so `team:invite` alone is not a way to widen an agent
 * past its editor.
 */
app.patch("/:id", async (c) => {
  requirePermission(c, "team:invite");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const [row] = await db
    .select({ linkId: agentAuthRegistrations.linkId })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.id, id),
        eq(agentAuthRegistrations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "Agent registration not found" }, 404);
  if (!row.linkId) {
    return c.json(
      { error: "Only agents made through a connected platform have scopes to edit." },
      400,
    );
  }
  const link = await getLink(organizationId, row.linkId);
  const existing = await getLinkAgent(row.linkId, id);
  if (!link || link.revokedAt || !existing || existing.revokedAt) {
    return c.json({ error: "That agent or its platform link has been revoked." }, 409);
  }

  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  try {
    const patch: { label?: string; scopes?: string[]; providers?: string[] } = {};
    if (body["label"] !== undefined) {
      const label = typeof body["label"] === "string" ? body["label"].trim() : "";
      if (label.length < 1 || label.length > LABEL_MAX) {
        return c.json({ error: `\`label\` must be 1 to ${LABEL_MAX} characters.` }, 400);
      }
      patch.label = label;
    }
    if (body["scopes"] !== undefined || body["providers"] !== undefined) {
      const grant = validateAgentGrant(
        await linkEffectiveScopes(link),
        body["scopes"] ?? existing.scopes ?? [],
        body["providers"] !== undefined ? body["providers"] : (existing.providers ?? []),
      );
      const unknown = await unknownProviders(grant.providers);
      if (unknown.length > 0) {
        return c.json(
          { error: `Unknown providers: ${unknown.join(", ")}`, code: "invalid_provider" },
          400,
        );
      }
      const granted = c.get("permissions") ?? [];
      const added = grant.scopes.filter((s) => !(existing.scopes ?? []).includes(s));
      const beyondEditor = added.filter((s) => !hasPermission(granted, s));
      if (beyondEditor.length > 0) {
        return c.json(
          {
            error: `You cannot grant: ${beyondEditor.join(", ")}`,
            code: "scope_not_allowed",
            scopes: beyondEditor,
          },
          400,
        );
      }
      patch.scopes = grant.scopes;
      patch.providers = grant.providers;
    }
    await updatePlatformAgent(id, patch);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "agent.update",
      entityType: "agent_registration",
      entityId: id,
      metadata: { linkId: link.id, by: "member", ...patch },
    });
    const updated = await getLinkAgent(link.id, id);
    return c.json({ agent: serializeAgent(updated ?? existing) });
  } catch (e) {
    if (e instanceof AgentLinkError) {
      return c.json(
        { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.details ?? {}) },
        e.status as 400,
      );
    }
    throw e;
  }
});

export { app as agentRegistrationRoutes };
