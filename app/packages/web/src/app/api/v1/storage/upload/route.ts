import { NextResponse } from "next/server";
import { requireAuth } from "@/auth/session";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";

export async function POST(request: Request) {
  const { organizationId } = await requireAuth();

  const formData = await request.formData();
  const accountId = formData.get("accountId") as string | null;
  const bucket = formData.get("bucket") as string | null;
  const key = formData.get("key") as string | null;
  const file = formData.get("file") as File | null;

  if (!accountId || !bucket || !key || !file) {
    return NextResponse.json({ error: "Missing accountId, bucket, key, or file" }, { status: 400 });
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

  if (!client.uploadStorageObject) {
    return NextResponse.json({ error: "Plugin does not support upload" }, { status: 400 });
  }

  await client.uploadStorageObject(bucket, key, file);
  return NextResponse.json({ ok: true });
}
