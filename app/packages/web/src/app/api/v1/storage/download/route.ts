import { NextResponse } from "next/server";
import path from "node:path";
import { requireAuth } from "@/auth/session";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";
import { storageDrivers } from "@/services/drivers";
import archiver from "archiver";

export async function GET(request: Request) {
  const { organizationId } = await requireAuth();

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  const bucket = url.searchParams.get("bucket");
  const keysParam = url.searchParams.get("keys");

  if (!accountId || !bucket || !keysParam) {
    return NextResponse.json({ error: "Missing accountId, bucket, or keys" }, { status: 400 });
  }

  let keys: string[];
  try {
    keys = JSON.parse(keysParam) as string[];
  } catch {
    return NextResponse.json({ error: "Invalid keys parameter" }, { status: 400 });
  }

  if (keys.length === 0) {
    return NextResponse.json({ error: "No keys specified" }, { status: 400 });
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

  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) {
    return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  }

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);

  if (!client.getStorageAccessToken) {
    return NextResponse.json({ error: "Plugin does not support storage access tokens" }, { status: 400 });
  }

  const accessToken = await client.getStorageAccessToken();
  const storageDriver = storageDrivers.get(account.pluginId);
  if (!storageDriver) {
    return NextResponse.json({ error: "No storage driver for this plugin" }, { status: 400 });
  }

  // Single file → direct download
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
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Download failed" },
        { status: 500 },
      );
    }
  }

  // Multiple files → zip download
  const { PassThrough } = await import("node:stream");
  const passthrough = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(passthrough);

  // Download and append each file to the archive
  (async () => {
    try {
      for (const key of keys) {
        if (key.endsWith("/")) continue; // skip folders
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
}
