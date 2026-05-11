import { Hono } from "hono";
import path from "node:path";
import { sftpUpload, sftpDownloadToBuffer } from "../../services/sftp";
import { getClientForAccount } from "../../services/plugin-clients";
import { resolveSshConfig } from "../../services/ssh";
import archiver from "archiver";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** POST /api/v1/sftp/upload */
app.post("/upload", async (c) => {
  requirePermission(c, "storage:write");
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

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const sshConfig = await resolveSshConfig(ctx.client, organizationId, {
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
  requirePermission(c, "storage:read");
  const organizationId = c.get("organizationId");
  const accountId = c.req.query("accountId");
  const pathsParam = c.req.query("paths");
  const basePath = c.req.query("basePath") ?? "";
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

  if (!Array.isArray(paths)) {
    return c.json({ error: "paths must be a JSON array of strings" }, 400);
  }
  if (paths.length === 0) return c.json({ error: "No paths specified" }, 400);
  const MAX_BULK_PATHS = 100;
  if (paths.length > MAX_BULK_PATHS) {
    return c.json({ error: `Too many paths (max ${MAX_BULK_PATHS})` }, 400);
  }

  const ctx = await getClientForAccount(accountId, organizationId);
  if (!ctx) return c.json({ error: "Account not found" }, 404);
  const sshConfig = await resolveSshConfig(ctx.client, organizationId, {
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

  const normalizedBase = basePath.endsWith("/") ? basePath : basePath ? `${basePath}/` : "";
  (async () => {
    try {
      for (const remotePath of paths) {
        if (remotePath.endsWith("/")) continue;
        const data = await sftpDownloadToBuffer(sshConfig, remotePath);
        const rel =
          normalizedBase && remotePath.startsWith(normalizedBase)
            ? remotePath.slice(normalizedBase.length)
            : path.basename(remotePath);
        archive.append(data, { name: rel });
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
