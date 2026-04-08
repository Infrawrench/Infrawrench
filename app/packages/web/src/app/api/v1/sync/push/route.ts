import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources, dashboards, dashboardPins, associations } from "@/db/schema";
import { authenticateApiRequest, requireScope } from "@/auth/api-auth";
import { encrypt } from "@/services/encryption";
import { logAudit } from "@/services/audit";

interface PushPayload {
  accounts?: Array<{
    id: string;
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>; // plaintext (sent over TLS)
    updatedAt: string;
    deletedAt?: string | null;
  }>;
  resources?: Array<{
    id: string;
    pluginId: string;
    resourceTypeId: string;
    accountId: string;
    displayName: string;
    externalId?: string | null;
    fieldsJson: unknown;
    outputsJson: unknown;
    parentResourceId?: string | null;
    updatedAt: string;
    deletedAt?: string | null;
  }>;
  dashboards?: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    updatedAt: string;
    deletedAt?: string | null;
  }>;
  dashboardPins?: Array<{
    id: string;
    dashboardId: string;
    resourceId: string;
    gridX: number;
    gridY: number;
    gridW: number;
    gridH: number;
    deletedAt?: string | null;
  }>;
  associations?: Array<{
    id: string;
    consumerResourceId: string;
    consumerFieldKey: string;
    providerResourceId: string;
    providerOutputKey: string;
    updatedAt: string;
    deletedAt?: string | null;
  }>;
}

export async function POST(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  requireScope(auth, "sync:write");

  const payload = (await request.json()) as PushPayload;
  const orgId = auth.organizationId;

  // Upsert accounts
  if (payload.accounts) {
    for (const acct of payload.accounts) {
      const { ciphertext, iv } = await encrypt(JSON.stringify(acct.credentials));
      await db
        .insert(accounts)
        .values({
          id: acct.id,
          organizationId: orgId,
          pluginId: acct.pluginId,
          displayName: acct.displayName,
          encryptedCredentials: ciphertext,
          credentialsIv: iv,
          deletedAt: acct.deletedAt ? new Date(acct.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(acct.updatedAt),
        })
        .onConflictDoUpdate({
          target: accounts.id,
          set: {
            displayName: acct.displayName,
            encryptedCredentials: ciphertext,
            credentialsIv: iv,
            deletedAt: acct.deletedAt ? new Date(acct.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM accounts WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(acct.updatedAt),
          },
        });
    }
  }

  // Upsert resources
  if (payload.resources) {
    for (const res of payload.resources) {
      await db
        .insert(resources)
        .values({
          id: res.id,
          organizationId: orgId,
          pluginId: res.pluginId,
          resourceTypeId: res.resourceTypeId,
          accountId: res.accountId,
          displayName: res.displayName,
          externalId: res.externalId ?? null,
          fieldsJson: res.fieldsJson ?? {},
          outputsJson: res.outputsJson ?? {},
          parentResourceId: res.parentResourceId ?? null,
          deletedAt: res.deletedAt ? new Date(res.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(res.updatedAt),
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            displayName: res.displayName,
            fieldsJson: res.fieldsJson ?? {},
            outputsJson: res.outputsJson ?? {},
            deletedAt: res.deletedAt ? new Date(res.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(res.updatedAt),
          },
        });
    }
  }

  // Upsert dashboards
  if (payload.dashboards) {
    for (const dash of payload.dashboards) {
      await db
        .insert(dashboards)
        .values({
          id: dash.id,
          organizationId: orgId,
          name: dash.name,
          isDefault: dash.isDefault,
          deletedAt: dash.deletedAt ? new Date(dash.deletedAt) : null,
          syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM dashboards WHERE organization_id = ${orgId}), 0) + 1`,
          updatedAt: new Date(dash.updatedAt),
        })
        .onConflictDoUpdate({
          target: dashboards.id,
          set: {
            name: dash.name,
            isDefault: dash.isDefault,
            deletedAt: dash.deletedAt ? new Date(dash.deletedAt) : null,
            syncVersion: sql`COALESCE((SELECT MAX(sync_version) FROM dashboards WHERE organization_id = ${orgId}), 0) + 1`,
            updatedAt: new Date(dash.updatedAt),
          },
        });
    }
  }

  void logAudit({
    organizationId: orgId,
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    action: "sync.push",
    entityType: "sync",
    entityId: orgId,
    metadata: {
      accounts: payload.accounts?.length ?? 0,
      resources: payload.resources?.length ?? 0,
      dashboards: payload.dashboards?.length ?? 0,
    },
  });

  return NextResponse.json({ ok: true });
}
