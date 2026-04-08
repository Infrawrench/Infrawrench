import { NextResponse } from "next/server";
import path from "node:path";
import { requireAuth } from "@/auth/session";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { sftpDownloadToBuffer } from "@/services/sftp";
import archiver from "archiver";

export async function GET(request: Request) {
  const { organizationId } = await requireAuth();

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  const pathsParam = url.searchParams.get("paths");

  if (!accountId || !pathsParam) {
    return NextResponse.json({ error: "Missing accountId or paths" }, { status: 400 });
  }

  let paths: string[];
  try {
    paths = JSON.parse(pathsParam) as string[];
  } catch {
    return NextResponse.json({ error: "Invalid paths parameter" }, { status: 400 });
  }

  if (paths.length === 0) {
    return NextResponse.json({ error: "No paths specified" }, { status: 400 });
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

  const client = loaded.plugin.createClient(credentials);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sshConfig = (client as any).getSshConfig?.();
  if (!sshConfig) {
    return NextResponse.json({ error: "Plugin does not support SSH" }, { status: 400 });
  }

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
}
