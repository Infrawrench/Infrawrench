import { NextResponse } from "next/server";
import { eq, gt, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources, dashboards, dashboardPins, associations } from "@/db/schema";
import { authenticateApiRequest, requireScope } from "@/auth/api-auth";

export async function POST(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  requireScope(auth, "sync:read");

  const body = (await request.json()) as { lastSyncVersion: number };
  const { lastSyncVersion } = body;
  const orgId = auth.organizationId;

  const [accountRows, resourceRows, dashboardRows, pinRows, assocRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
        encryptedCredentials: accounts.encryptedCredentials,
        credentialsIv: accounts.credentialsIv,
        syncVersion: accounts.syncVersion,
        deletedAt: accounts.deletedAt,
        updatedAt: accounts.updatedAt,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, orgId), gt(accounts.syncVersion, lastSyncVersion))),
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
        parentResourceId: resources.parentResourceId,
        syncVersion: resources.syncVersion,
        deletedAt: resources.deletedAt,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, orgId), gt(resources.syncVersion, lastSyncVersion))),
    db
      .select({
        id: dashboards.id,
        name: dashboards.name,
        isDefault: dashboards.isDefault,
        syncVersion: dashboards.syncVersion,
        deletedAt: dashboards.deletedAt,
        updatedAt: dashboards.updatedAt,
      })
      .from(dashboards)
      .where(and(eq(dashboards.organizationId, orgId), gt(dashboards.syncVersion, lastSyncVersion))),
    db
      .select()
      .from(dashboardPins)
      .where(gt(dashboardPins.syncVersion, lastSyncVersion)),
    db
      .select()
      .from(associations)
      .where(gt(associations.syncVersion, lastSyncVersion)),
  ]);

  return NextResponse.json({
    accounts: accountRows,
    resources: resourceRows,
    dashboards: dashboardRows,
    dashboardPins: pinRows,
    associations: assocRows,
  });
}
