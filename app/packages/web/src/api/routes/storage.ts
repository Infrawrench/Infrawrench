import { Hono } from "hono";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { getClientForAccount } from "../../services/plugin-clients";
import { storageDrivers } from "../../services/drivers";
import archiver from "archiver";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

/** Maximum number of paths/keys accepted in a single bulk request. */
const MAX_BULK_KEYS = 100;

/** Build a non-guessable temp path under the OS tmpdir for a download. */
function tmpDownloadPath(key: string): string {
  return path.join(os.tmpdir(), `iw-download-${randomUUID()}-${path.basename(key)}`);
}

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/v1/storage/upload */
app.post("/upload", async (c) => {
  requirePermission(c, "storage:write");
  const organizationId = c.get("organizationId");
  const formData = await c.req.parseBody();

  const accountId = formData["accountId"] as string | undefined;
  const bucket = formData["bucket"] as string | undefined;
  const key = formData["key"] as string | undefined;
  const file = formData["file"] as File | undefined;

  if (!accountId || !bucket || !key || !file) {
    return c.json({ error: "Missing accountId, bucket, key, or file" }, 400);
  }

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account or plugin not found" }, 404);

  if (!ctx.client.uploadStorageObject)
    return c.json({ error: "Plugin does not support upload" }, 400);

  await ctx.client.uploadStorageObject(bucket, key, file);
  return c.json({ ok: true });
});

/** GET /api/v1/storage/download */
app.get("/download", async (c) => {
  requirePermission(c, "storage:read");
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

  if (!Array.isArray(keys)) {
    return c.json({ error: "keys must be a JSON array of strings" }, 400);
  }
  if (keys.length === 0) return c.json({ error: "No keys specified" }, 400);
  if (keys.length > MAX_BULK_KEYS) {
    return c.json({ error: `Too many keys (max ${MAX_BULK_KEYS})` }, 400);
  }

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account or plugin not found" }, 404);

  if (!ctx.client.getStorageAccessToken) {
    return c.json({ error: "Plugin does not support storage access tokens" }, 400);
  }

  const accessToken = await ctx.client.getStorageAccessToken();
  const storageDriver = storageDrivers.get(ctx.account.pluginId);
  if (!storageDriver) return c.json({ error: "No storage driver for this plugin" }, 400);

  if (keys.length === 1) {
    const key = keys[0]!;
    const tmpPath = tmpDownloadPath(key);

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

  const { PassThrough, Readable } = await import("node:stream");
  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(passthrough);

  (async () => {
    try {
      for (const key of keys) {
        if (key.endsWith("/")) continue;
        const tmpPath = tmpDownloadPath(key);
        await storageDriver.downloadFile(bucket, key, accessToken, tmpPath);
        archive.file(tmpPath, { name: key });
      }
      await archive.finalize();
    } catch {
      archive.abort();
    }
  })();

  return new Response(Readable.toWeb(passthrough) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="download-${Date.now()}.zip"`,
    },
  });
});

export { app as storageRoutes };
