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
import { encrypt, decrypt } from "../../services/encryption";
import { openTunnel, closeTunnel, getActiveTunnels } from "../../services/ssh-tunnel";
import type { SshTunnelConfig } from "@infrawrench/plugin-base";
import { sshExec } from "../../services/ssh";
import { requirePermission } from "../../auth/permissions";
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

  // Load and decrypt the SSH key
  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, input.sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);

  if (!keyRow) return c.json({ error: "SSH key not found" }, 404);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    return c.json({ error: "SSH key has no private key data" }, 400);
  }

  const privateKey = await decrypt(keyRow.encryptedPrivateKey, keyRow.privateKeyIv);

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
    return c.json(
      { error: `SSH tunnel failed: ${e instanceof Error ? e.message : "Unknown error"}` },
      400,
    );
  }

  const { ciphertext: credCiphertext, iv: credIv } = await encrypt(
    JSON.stringify(input.credentials),
  );
  const { ciphertext: keyCiphertext, iv: keyIv } = await encrypt(privateKey);

  await db.insert(accounts).values({
    id: newAccountId,
    organizationId,
    pluginId: input.pluginId,
    displayName: input.displayName,
    encryptedCredentials: credCiphertext,
    credentialsIv: credIv,
  });

  await db.insert(sshTunnelConfigs).values({
    id: uuid(),
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

  const privateKey = await decrypt(config.encryptedPrivateKey, config.privateKeyIv);
  const result = await openTunnel(
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
 */
app.post("/exec", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const input = await c.req.json<{
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    command: string;
  }>();

  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, input.sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);

  if (!keyRow) return c.json({ error: "SSH key not found" }, 404);
  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) {
    return c.json({ error: "SSH key has no private key data" }, 400);
  }

  const privateKey = await decrypt(keyRow.encryptedPrivateKey, keyRow.privateKeyIv);

  try {
    const stdout = await sshExec(
      { host: input.sshHost, port: input.sshPort, username: input.sshUser, privateKey },
      input.command,
    );
    return c.json({ stdout, code: 0 });
  } catch (e) {
    // sshExec throws on non-zero exit; extract info from message
    const message = e instanceof Error ? e.message : "Command failed";
    return c.json({ stdout: "", stderr: message, code: 1 });
  }
});

export { app as sshTunnelRoutes };
