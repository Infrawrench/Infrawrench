import { NextResponse } from "next/server";
import { requireAuth } from "@/auth/session";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { sftpUpload } from "@/services/sftp";

export async function POST(request: Request) {
  const { organizationId } = await requireAuth();

  const formData = await request.formData();
  const accountId = formData.get("accountId") as string | null;
  const remotePath = formData.get("remotePath") as string | null;
  const file = formData.get("file") as File | null;

  if (!accountId || !remotePath || !file) {
    return NextResponse.json({ error: "Missing accountId, remotePath, or file" }, { status: 400 });
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

  const arrayBuffer = await file.arrayBuffer();
  await sftpUpload(sshConfig, remotePath, Buffer.from(arrayBuffer));
  return NextResponse.json({ ok: true });
}
