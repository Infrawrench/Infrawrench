"use server";

import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { requireAuth } from "@/auth/session";
import { getPlugin } from "@/plugins/loader";
import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ResourceSummary {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: unknown;
  outputsJson: unknown;
  parentResourceId: string | null;
}

export async function listResources(accountId: string, topLevelOnly = false): Promise<ResourceSummary[]> {
  const session = await requireAuth();
  const conditions = [
    eq(resources.accountId, accountId),
    eq(resources.organizationId, session.organizationId),
    isNull(resources.deletedAt),
  ];
  if (topLevelOnly) conditions.push(isNull(resources.parentResourceId));
  const rows = await db
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
    })
    .from(resources)
    .where(and(...conditions));
  return rows;
}

export async function syncResources(accountId: string): Promise<{ synced: number }> {
  const session = await requireAuth();

  // Get account + credentials
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, session.organizationId)));
  if (!account) throw new Error("Account not found");

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);

  const client = loaded.plugin.createClient(credentials);

  // Sync ALL resource types — plugins handle their own listing logic
  const allTypes = loaded.plugin.resourceTypes;

  const results = await Promise.allSettled(
    allTypes.map((t) => client.listResources(t.id, accountId)),
  );

  let synced = 0;
  const allResources: ResourceInstance[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") allResources.push(...r.value);
  }

  for (const resource of allResources) {
    // Use the plugin-generated ID directly — plugins already produce
    // unique IDs in the format "accountId:typeId:externalId"
    await db
      .insert(resources)
      .values({
        id: resource.id,
        organizationId: session.organizationId,
        pluginId: account.pluginId,
        resourceTypeId: resource.resourceTypeId,
        accountId,
        displayName: resource.displayName,
        externalId: resource.externalId ?? null,
        fieldsJson: resource.fields,
        outputsJson: resource.resolvedOutputs ?? {},
        parentResourceId: resource.parentResourceId ?? null,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: {
          displayName: resource.displayName,
          fieldsJson: resource.fields,
          outputsJson: resource.resolvedOutputs ?? {},
          parentResourceId: resource.parentResourceId ?? null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    synced++;
  }

  return { synced };
}
