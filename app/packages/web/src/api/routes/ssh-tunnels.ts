/**
 * SSH tunnel management API routes.
 * Supports creating accounts with SSH tunnel configs, opening/closing tunnels,
 * and executing commands over SSH.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, sshKeys, sshTunnelConfigs } from "../../db/schema";
import { encrypt, decrypt, buildAad } from "../../services/encryption";
import { openTunnel, closeTunnel, getActiveTunnels } from "../../services/ssh-tunnel";
import type { SshTunnelConfig } from "@infrawrench/plugin-base";
import { sshExec } from "../../services/ssh";
import { HostKeyTrustRequiredError } from "../../services/ssh-host-keys";
import { hostKeyTrustResponse } from "./ssh-host-keys";
import { requirePermission } from "../../auth/permissions";
import { assertHostNotInternal } from "../../services/host-validation";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * POST /api/org/:orgId/ssh-tunnels/create-account
 * Creates an account with an SSH tunnel config in one step.
 * This is the web equivalent of the desktop SshTunnelModal flow.
 */
app.post("/create-account", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const input = await c.req.json<{
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    remoteHost: string;
    remotePort: number;
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
  }>();

  // SSRF guard: refuse to use a bastion that resolves to internal address
  // space. Only `sshHost` (the public bastion the server dials) is checked;
  // the inner `remoteHost` is allowed to be private, that's the point.
  try {
    await assertHostNotInternal(input.sshHost);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid SSH host" }, 400);
  }

  // Load and decrypt the SSH key — restricted to keys OWNED by the caller,
  // so a same-org peer cannot use another user's private key.
  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(
      and(
        eq(sshKeys.id, input.sshKeyId),
        eq(sshKeys.organizationId, organizationId),
        eq(sshKeys.userId, session.userId),
      ),
    )
    .limit(1);

  if (!keyRow) return c.json({ error: "SSH key not found" }, 404);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    return c.json({ error: "SSH key has no private key data" }, 400);
  }

  const privateKey = await decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", input.sshKeyId, "privateKey"),
  );

  // Verify the SSH tunnel works before persisting
  const tunnelConfig: SshTunnelConfig = {
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    privateKey,
    remoteHost: input.remoteHost,
    remotePort: input.remotePort,
  };

  const newAccountId = uuid();

  try {
    await openTunnel(tunnelConfig, organizationId, newAccountId);
  } catch (e) {
    if (e instanceof HostKeyTrustRequiredError) return hostKeyTrustResponse(c, e);
    return c.json(
      { error: `SSH tunnel failed: ${e instanceof Error ? e.message : "Unknown error"}` },
      400,
    );
  }

  const tunnelConfigId = uuid();
  const { ciphertext: credCiphertext, iv: credIv } = await encrypt(
    JSON.stringify(input.credentials),
    buildAad("account", newAccountId, "credentials"),
  );
  const { ciphertext: keyCiphertext, iv: keyIv } = await encrypt(
    privateKey,
    buildAad("sshTunnelConfig", tunnelConfigId, "privateKey"),
  );

  await db.insert(accounts).values({
    id: newAccountId,
    organizationId,
    pluginId: input.pluginId,
    displayName: input.displayName,
    encryptedCredentials: credCiphertext,
    credentialsIv: credIv,
  });

  await db.insert(sshTunnelConfigs).values({
    id: tunnelConfigId,
    accountId: newAccountId,
    organizationId,
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    remoteHost: input.remoteHost,
    remotePort: input.remotePort,
    encryptedPrivateKey: keyCiphertext,
    privateKeyIv: keyIv,
  });

  return c.json({ accountId: newAccountId });
});

/**
 * POST /api/org/:orgId/ssh-tunnels/open
 * Opens an SSH tunnel for an existing account that has an ssh_tunnel_configs row.
 */
app.post("/open", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{ accountId: string }>();

  const [config] = await db
    .select()
    .from(sshTunnelConfigs)
    .where(
      and(
        eq(sshTunnelConfigs.accountId, input.accountId),
        eq(sshTunnelConfigs.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!config) return c.json({ error: "No tunnel config for this account" }, 404);

  // SSRF guard on the stored bastion endpoint. The create-account flow
  // validates this at write time, but DNS records can change.
  try {
    await assertHostNotInternal(config.sshHost);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid SSH host" }, 400);
  }

  const privateKey = await decrypt(
    config.encryptedPrivateKey,
    config.privateKeyIv,
    buildAad("sshTunnelConfig", config.id, "privateKey"),
  );
  let result;
  try {
    result = await openTunnel(
      {
        sshHost: config.sshHost,
        sshPort: config.sshPort,
        sshUser: config.sshUser,
        privateKey,
        remoteHost: config.remoteHost,
        remotePort: config.remotePort,
      },
      organizationId,
      input.accountId,
    );
  } catch (e) {
    if (e instanceof HostKeyTrustRequiredError) return hostKeyTrustResponse(c, e);
    throw e;
  }

  return c.json(result);
});

/**
 * POST /api/org/:orgId/ssh-tunnels/close
 */
app.post("/close", async (c) => {
  requirePermission(c, "resources:execute");
  const input = await c.req.json<{ tunnelId: string }>();
  closeTunnel(input.tunnelId);
  return c.json({ ok: true });
});

/**
 * GET /api/org/:orgId/ssh-tunnels/active
 */
app.get("/active", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const all = getActiveTunnels();
  // Filter to tunnels belonging to this org
  const result: Record<string, { localPort: number; sshHost: string; remotePort: number }> = {};
  for (const [id, info] of Object.entries(all)) {
    if (info.organizationId === organizationId) {
      result[id] = {
        localPort: info.localPort,
        sshHost: info.sshHost,
        remotePort: info.remotePort,
      };
    }
  }
  return c.json(result);
});

/**
 * POST /api/org/:orgId/ssh-tunnels/exec
 * Execute a command over SSH using an org SSH key.
 *
 * Authorization:
 *  - The (sshHost, sshPort, sshUser) triple must match an admin-configured
 *    `ssh_tunnel_configs` row for this org. Without this, `resources:execute`
 *    is an arbitrary "run any command as any user on any host with any
 *    available key" primitive.
 *  - The SSH key must be OWNED by the caller (sshKeys.userId === caller).
 *  - Every exec attempt — success or failure — is audit-logged.
 */
app.post("/exec", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const input = await c.req.json<{
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    command: string;
  }>();

  // SSRF guard on the bastion host the server is about to dial.
  try {
    await assertHostNotInternal(input.sshHost);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid SSH host" }, 400);
  }

  // (host, port, user) must be tied to a tunnel config admin-configured for
  // this org. We do not trust arbitrary triples even within the same org.
  const matchingConfigs = await db
    .select({ id: sshTunnelConfigs.id, accountId: sshTunnelConfigs.accountId })
    .from(sshTunnelConfigs)
    .where(
      and(
        eq(sshTunnelConfigs.organizationId, organizationId),
        eq(sshTunnelConfigs.sshHost, input.sshHost),
        eq(sshTunnelConfigs.sshUser, input.sshUser),
        eq(sshTunnelConfigs.sshPort, input.sshPort),
      ),
    )
    .limit(1);

  if (matchingConfigs.length === 0) {
    return c.json(
      {
        error:
          "The requested SSH host/user combination is not configured for this organization. Ask an admin to create an SSH tunnel config first.",
      },
      403,
    );
  }

  // Key lookup restricted to the calling user as owner.
  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(
      and(
        eq(sshKeys.id, input.sshKeyId),
        eq(sshKeys.organizationId, organizationId),
        eq(sshKeys.userId, session.userId),
      ),
    )
    .limit(1);

  if (!keyRow) return c.json({ error: "SSH key not found" }, 404);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    return c.json({ error: "SSH key has no private key data" }, 400);
  }

  const privateKey = await decrypt(
    keyRow.encryptedPrivateKey,
    keyRow.privateKeyIv,
    buildAad("sshKey", input.sshKeyId, "privateKey"),
  );

  const commandSnippet = input.command.slice(0, 200);
  const auditBase = {
    organizationId,
    userId: session.userId,
    entityType: "ssh-tunnel-exec",
    entityId: matchingConfigs[0]!.accountId,
  };

  try {
    const stdout = await sshExec(
      organizationId,
      { host: input.sshHost, port: input.sshPort, username: input.sshUser, privateKey },
      input.command,
    );
    void logAudit({
      ...auditBase,
      action: "ssh.exec",
      metadata: {
        sshHost: input.sshHost,
        sshUser: input.sshUser,
        sshKeyId: input.sshKeyId,
        commandSnippet,
        exitCode: 0,
      },
    });
    return c.json({ stdout, code: 0 });
  } catch (e) {
    // sshExec throws on non-zero exit OR a host-key trust failure. The
    // latter needs the structured 409 so the client can prompt.
    if (e instanceof HostKeyTrustRequiredError) {
      void logAudit({
        ...auditBase,
        action: "ssh.exec.host_key_trust_required",
        metadata: {
          sshHost: input.sshHost,
          sshUser: input.sshUser,
          sshKeyId: input.sshKeyId,
          commandSnippet,
          kind: e.kind,
          presentedFingerprint: e.presentedFingerprint,
        },
      });
      return hostKeyTrustResponse(c, e);
    }
    const message = e instanceof Error ? e.message : "Command failed";
    void logAudit({
      ...auditBase,
      action: "ssh.exec.failed",
      metadata: {
        sshHost: input.sshHost,
        sshUser: input.sshUser,
        sshKeyId: input.sshKeyId,
        commandSnippet,
        error: message,
      },
    });
    return c.json({ stdout: "", stderr: message, code: 1 });
  }
});

export { app as sshTunnelRoutes };
