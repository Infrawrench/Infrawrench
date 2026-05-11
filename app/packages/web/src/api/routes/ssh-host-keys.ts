/**
 * SSH host-key trust API. Lists pinned fingerprints, lets the operator
 * explicitly trust a presented fingerprint (after a 409 from any SSH/SFTP/
 * tunnel route), and removes pins.
 *
 * Replaces silent TOFU-on-first-use: a connection to an unknown host now
 * returns 409 `ssh_host_key_trust_required` with the presented fingerprint;
 * the client is expected to prompt the user, POST /trust if accepted, then
 * retry the original action.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { sshHostKeys } from "../../db/schema";
import {
  HostKeyTrustRequiredError,
  trustHostKey,
  HostKeyMismatchError,
} from "../../services/ssh-host-keys";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Shared 409 response shape for any route that catches a
 * `HostKeyTrustRequiredError`. Clients (web frontend, desktop cloud-proxy)
 * recognize `error === "ssh_host_key_trust_required"` and prompt the user.
 */
export function hostKeyTrustResponse(c: Context, err: HostKeyTrustRequiredError) {
  return c.json(
    {
      error: "ssh_host_key_trust_required",
      message: err.message,
      kind: err.kind,
      host: err.host,
      port: err.port,
      presentedFingerprint: err.presentedFingerprint,
      storedFingerprint: err.storedFingerprint,
    },
    409,
  );
}

const app = new Hono();

/** GET /api/org/:orgId/ssh-host-keys — list all pinned fingerprints. */
app.get("/", async (c) => {
  requirePermission(c, "accounts:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: sshHostKeys.id,
      host: sshHostKeys.host,
      port: sshHostKeys.port,
      fingerprint: sshHostKeys.fingerprint,
      createdAt: sshHostKeys.createdAt,
    })
    .from(sshHostKeys)
    .where(eq(sshHostKeys.organizationId, organizationId))
    .orderBy(asc(sshHostKeys.host));
  return c.json({ pins: rows });
});

const trustBody = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  fingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]+$/, "fingerprint must be SHA256:<base64> (no padding)"),
  /**
   * If the caller was responding to a mismatch (not just an unknown host),
   * pass the previously-stored fingerprint so we can record a clear audit
   * trail of the replacement.
   */
  previousFingerprint: z.string().optional(),
});

/** POST /api/org/:orgId/ssh-host-keys/trust — pin a fingerprint after user consent. */
app.post("/trust", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = trustBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const { host, port, fingerprint, previousFingerprint } = parsed.data;

  try {
    await trustHostKey(organizationId, host, port, fingerprint);
  } catch (err) {
    // A concurrent connect could observe a different fingerprint than what
    // the user just accepted. Surface that as a 409 so the client can
    // re-prompt with the new value.
    if (err instanceof HostKeyMismatchError) {
      return hostKeyTrustResponse(c, err);
    }
    throw err;
  }

  await logAudit({
    organizationId,
    userId: session.userId,
    action: previousFingerprint ? "ssh_host_key.replaced" : "ssh_host_key.trusted",
    entityType: "ssh_host_key",
    entityId: `${host}:${port}`,
    metadata: previousFingerprint
      ? { host, port, fingerprint, previousFingerprint }
      : { host, port, fingerprint },
  });

  return c.json({ ok: true });
});

/** DELETE /api/org/:orgId/ssh-host-keys/:id — remove a pin. */
app.delete("/:id", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const [existing] = await db
    .select({
      host: sshHostKeys.host,
      port: sshHostKeys.port,
      fingerprint: sshHostKeys.fingerprint,
    })
    .from(sshHostKeys)
    .where(and(eq(sshHostKeys.id, id), eq(sshHostKeys.organizationId, organizationId)))
    .limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db
    .delete(sshHostKeys)
    .where(and(eq(sshHostKeys.id, id), eq(sshHostKeys.organizationId, organizationId)));

  await logAudit({
    organizationId,
    userId: session.userId,
    action: "ssh_host_key.removed",
    entityType: "ssh_host_key",
    entityId: `${existing.host}:${existing.port}`,
    metadata: { host: existing.host, port: existing.port, fingerprint: existing.fingerprint },
  });

  return c.json({ ok: true });
});

export { app as sshHostKeyRoutes };
