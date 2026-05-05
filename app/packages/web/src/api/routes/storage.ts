import { Hono } from "hono";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts } from "../../db/schema";
import { decrypt } from "../../services/encryption";
import { getPlugin } from "../../plugins/loader";
import { buildPluginHostServices } from "../../services/host-services";
import { rewriteCredentialsThroughTunnel } from "../../services/tunnel-resolver";
import { storageDrivers } from "../../services/drivers";
import archiver from "archiver";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/v1/storage/upload */
app.post("/upload", async (c) => {
  const organizationId = c.get("organizationId");
  const formData = await c.req.parseBody();

  const accountId = formData["accountId"] as string | undefined;
  const bucket = formData["bucket"] as string | undefined;
  const key = formData["key"] as string | undefined;
  const file = formData["file"] as File | undefined;

  if (!accountId || !bucket || !key || !file) {
    return c.json({ error: "Missing accountId, bucket, key, or file" }, 400);
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
  await rewriteCredentialsThroughTunnel(accountId, credentials);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return c.json({ error: "Plugin not found" }, 404);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);

  if (!client.uploadStorageObject) return c.json({ error: "Plugin does not support upload" }, 400);

  await client.uploadStorageObject(bucket, key, file);
  return c.json({ ok: true });
});

/** GET /api/v1/storage/download */
app.get("/download", async (c) => {
  const organizationId = c.get("organizationId");
  const accountId = c.req.query("accountId");
  const bucket = c.req.query("bucket");
  const keysParam = c.req.query("keys");

  if (!accountId || !bucket || !keysParam) {
    return c.json({ error: "Missing accountId, bucket, or keys" }, 400);
  }

  let keys: string[];
  try {
    keys = JSON.parse(keysParam) as string[];
  } catch {
    return c.json({ error: "Invalid keys parameter" }, 400);
  }

  if (keys.length === 0) return c.json({ error: "No keys specified" }, 400);

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
  await rewriteCredentialsThroughTunnel(accountId, credentials);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return c.json({ error: "Plugin not found" }, 404);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);

  if (!client.getStorageAccessToken) {
    return c.json({ error: "Plugin does not support storage access tokens" }, 400);
  }

  const accessToken = await client.getStorageAccessToken();
  const storageDriver = storageDrivers.get(account.pluginId);
  if (!storageDriver) return c.json({ error: "No storage driver for this plugin" }, 400);

  if (keys.length === 1) {
    const key = keys[0]!;
    const tmpPath = `/tmp/iw-download-${Date.now()}-${path.basename(key)}`;

    try {
      await storageDriver.downloadFile(bucket, key, accessToken, tmpPath);
      const { readFile, unlink } = await import("node:fs/promises");
      const data = await readFile(tmpPath);
      unlink(tmpPath).catch(() => {});

      return new Response(data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(key)}"`,
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
      for (const key of keys) {
        if (key.endsWith("/")) continue;
        const tmpPath = `/tmp/iw-download-${Date.now()}-${path.basename(key)}`;
        await storageDriver.downloadFile(bucket, key, accessToken, tmpPath);
        archive.file(tmpPath, { name: key });
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

export { app as storageRoutes };
