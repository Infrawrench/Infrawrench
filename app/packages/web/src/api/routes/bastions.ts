import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { eq, and, count } from "drizzle-orm";
import { db } from "../../db/client";
import { bastionVms, accounts } from "../../db/schema";
import { logAudit } from "../../services/audit";
import { keyedHash } from "../../services/encryption";
import { requirePermission } from "../../auth/permissions";
import { isBastionConnected } from "@infrawrench/server-core/bastion/registry";
import type { AuthSession } from "../auth-middleware";

const BASTION_TOKEN_HASH_DOMAIN = "bastion-agent";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * POST /api/org/:orgId/bastions — register a new bastion. Returns a one-time
 * enrollment token the user runs the agent container with; the token is
 * never recoverable after this response.
 */
app.post("/", async (c) => {
  requirePermission(c, "bastions:write");
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);

  const raw = randomBytes(32);
  const token = `iwb_${raw.toString("base64url")}`;
  const hashedToken = await keyedHash(token, BASTION_TOKEN_HASH_DOMAIN);
  const tokenPrefix = token.slice(0, 12);
  const id = uuid();

  await db.insert(bastionVms).values({
    id,
    organizationId,
    createdByUserId: session.userId,
    name: name.trim(),
    hashedToken,
    tokenPrefix,
    status: "pending",
  });

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "bastion.create",
    entityType: "bastion",
    entityId: id,
    metadata: { name: name.trim() },
  });

  return c.json({ id, name: name.trim(), token, tokenPrefix });
});

/** GET /api/org/:orgId/bastions — list bastions in this org. */
app.get("/", async (c) => {
  requirePermission(c, "bastions:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: bastionVms.id,
      name: bastionVms.name,
      tokenPrefix: bastionVms.tokenPrefix,
      agentVersion: bastionVms.agentVersion,
      lastSeenAt: bastionVms.lastSeenAt,
      status: bastionVms.status,
      revokedAt: bastionVms.revokedAt,
      createdAt: bastionVms.createdAt,
      createdByUserId: bastionVms.createdByUserId,
    })
    .from(bastionVms)
    .where(eq(bastionVms.organizationId, organizationId))
    .orderBy(bastionVms.createdAt);

  // Cross-reference the in-memory registry so "connected" is live, not stale.
  const accountCounts = await db
    .select({ bastionId: accounts.bastionId, count: count() })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .groupBy(accounts.bastionId);
  const countByBastion = new Map<string, number>();
  for (const r of accountCounts) {
    if (r.bastionId) countByBastion.set(r.bastionId, Number(r.count));
  }

  return c.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      tokenPrefix: r.tokenPrefix,
      agentVersion: r.agentVersion,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      status: r.status,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdByUserId: r.createdByUserId,
      connected: isBastionConnected(r.id),
      accountCount: countByBastion.get(r.id) ?? 0,
    })),
  );
});

/** DELETE /api/org/:orgId/bastions/:id — revoke. Accounts referencing it have bastionId set NULL by FK. */
app.delete("/:id", async (c) => {
  requirePermission(c, "bastions:write");
  const session = c.get("session");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");

  const result = await db
    .delete(bastionVms)
    .where(and(eq(bastionVms.id, id), eq(bastionVms.organizationId, organizationId)))
    .returning({ id: bastionVms.id });

  if (result.length === 0) return c.json({ error: "Bastion not found" }, 404);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "bastion.revoke",
    entityType: "bastion",
    entityId: id,
  });

  return c.json({ ok: true });
});

export { app as bastionRoutes };
