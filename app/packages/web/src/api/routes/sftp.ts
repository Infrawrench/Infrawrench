import { Hono } from "hono";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, sshKeys } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { sftpUpload, sftpDownloadToBuffer } from "../../services/sftp";
import archiver from "archiver";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * Resolve SSH config from either the plugin's getSshConfig() or from
 * an org SSH key + host (for sshEndpoint-based resources).
 */
async function resolveSshConfigForUpload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  organizationId: string,
  opts: { sshKeyId?: string; sshHost?: string; sshUsername?: string },
): Promise<{ host: string; port: number; username: string; privateKey: string }> {
  const pluginConfig = client.getSshConfig?.();
  if (pluginConfig) return pluginConfig;

  if (!opts.sshKeyId || !opts.sshHost) {
    throw new Error("Plugin does not support SSH and no SSH key/host provided");
  }

  const [keyRow] = await db
    .select({
      encryptedPrivateKey: sshKeys.encryptedPrivateKey,
      privateKeyIv: sshKeys.privateKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, opts.sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);
  if (!keyRow) throw new Error("SSH key not found");

  if (!keyRow.encryptedPrivateKey || !keyRow.privateKeyIv) throw new Error("SSH key has no private key data");
  const privateKey = await decrypt(keyRow.encryptedPrivateKey, keyRow.privateKeyIv);
  const host = opts.sshHost;
  if (!host) throw new Error("SSH host is required");
  return { host, port: 22, username: opts.sshUsername ?? "root", privateKey };
}

/** POST /api/v1/sftp/upload */
app.post("/upload", async (c) => {
  const organizationId = c.get("organizationId");
  const formData = await c.req.parseBody();

  const accountId = formData["accountId"] as string | undefined;
  const remotePath = formData["remotePath"] as string | undefined;
  const file = formData["file"] as File | undefined;
  const sshKeyId = formData["sshKeyId"] as string | undefined;
  const sshHost = formData["sshHost"] as string | undefined;
  const sshUsername = formData["sshUsername"] as string | undefined;

  if (!accountId || !remotePath || !file) {
    return c.json({ error: "Missing accountId, remotePath, or file" }, 400);
  }

  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);

  if (!account) return c.json({ error: "Account not found" }, 404);

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return c.json({ error: "Plugin not found" }, 404);

  const client = loaded.plugin.createClient(credentials);
  const sshConfig = await resolveSshConfigForUpload(client, organizationId, {
    ...(sshKeyId !== undefined ? { sshKeyId } : {}),
    ...(sshHost !== undefined ? { sshHost } : {}),
    ...(sshUsername !== undefined ? { sshUsername } : {}),
  });

  const arrayBuffer = await file.arrayBuffer();
  await sftpUpload(sshConfig, remotePath, Buffer.from(arrayBuffer));
  return c.json({ ok: true });
});

/** GET /api/v1/sftp/download */
app.get("/download", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.query("accountId");
  const pathsParam = c.req.query("paths");
  const sshKeyId = c.req.query("sshKeyId");
  const sshHost = c.req.query("sshHost");
  const sshUsername = c.req.query("sshUsername");

  if (!accountId || !pathsParam) {
    return c.json({ error: "Missing accountId or paths" }, 400);
  }

  let paths: string[];
  try {
    paths = JSON.parse(pathsParam) as string[];
  } catch {
    return c.json({ error: "Invalid paths parameter" }, 400);
  }

  if (paths.length === 0) return c.json({ error: "No paths specified" }, 400);

  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);

  if (!account) return c.json({ error: "Account not found" }, 404);

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return c.json({ error: "Plugin not found" }, 404);

  const client = loaded.plugin.createClient(credentials);
  const sshConfig = await resolveSshConfigForUpload(client, organizationId, {
    ...(sshKeyId !== undefined ? { sshKeyId } : {}),
    ...(sshHost !== undefined ? { sshHost } : {}),
    ...(sshUsername !== undefined ? { sshUsername } : {}),
  });

  if (paths.length === 1) {
    const remotePath = paths[0]!;
    try {
      const data = await sftpDownloadToBuffer(sshConfig, remotePath);
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(remotePath)}"`,
          "Content-Length": String(data.length),
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Download failed" }, 500);
    }
  }

  const { PassThrough } = await import("node:stream");
  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(passthrough);

  (async () => {
    try {
      for (const remotePath of paths) {
        if (remotePath.endsWith("/")) continue;
        const data = await sftpDownloadToBuffer(sshConfig, remotePath);
        archive.append(data, { name: path.basename(remotePath) });
      }
      await archive.finalize();
    } catch {
      archive.abort();
    }
  })();

  // @ts-expect-error -- PassThrough is a Node.js ReadableStream, compatible with Response
  return new Response(passthrough, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="download-${Date.now()}.zip"`,
    },
  });
});

export { app as sftpRoutes };
