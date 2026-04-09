import { Hono } from "hono";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts } from "../../db/schema";
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

/** POST /api/v1/sftp/upload */
app.post("/upload", async (c) => {
  const { organizationId } = c.get("session");
  const formData = await c.req.parseBody();

  const accountId = formData["accountId"] as string | undefined;
  const remotePath = formData["remotePath"] as string | undefined;
  const file = formData["file"] as File | undefined;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sshConfig = (client as any).getSshConfig?.();
  if (!sshConfig) return c.json({ error: "Plugin does not support SSH" }, 400);

  const arrayBuffer = await file.arrayBuffer();
  await sftpUpload(sshConfig, remotePath, Buffer.from(arrayBuffer));
  return c.json({ ok: true });
});

/** GET /api/v1/sftp/download */
app.get("/download", async (c) => {
  const { organizationId } = c.get("session");
  const accountId = c.req.query("accountId");
  const pathsParam = c.req.query("paths");

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sshConfig = (client as any).getSshConfig?.();
  if (!sshConfig) return c.json({ error: "Plugin does not support SSH" }, 400);

  // Single file → direct download
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

  // Multiple files → zip download
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
