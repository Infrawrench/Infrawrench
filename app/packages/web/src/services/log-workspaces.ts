/**
 * Log-capable resource discovery for the log workspace picker.
 *
 * The `logs` capability lives on the *rendered* `DetailViewSchema` (a plugin
 * declares it per instance in `renderDetail`), never on the resource type —
 * so the only provider-agnostic way to know a resource can be tailed is to
 * render its stored row and look. `renderDetail` is pure and synchronous, so
 * this stays cheap: one client per account (only accounts whose client
 * implements `getLogs` are considered at all), then an in-memory render per
 * stored row.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { getClientForAccount } from "./plugin-clients";

/** One pickable log stream source. */
export interface LogCapableResource {
  resourceId: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
}

/** Hard ceiling so a huge org can't turn discovery into a slow scan. */
const MAX_RESULTS = 500;

export async function listLogCapableResources(
  organizationId: string,
): Promise<{ resources: LogCapableResource[] }> {
  const accountRows = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)))
    .orderBy(accounts.displayName);

  const out: LogCapableResource[] = [];
  for (const account of accountRows) {
    if (out.length >= MAX_RESULTS) break;
    let ctx: Awaited<ReturnType<typeof getClientForAccount>>;
    try {
      ctx = await getClientForAccount(account.id, organizationId);
    } catch {
      continue; // Broken credentials never break the picker for other accounts.
    }
    if (!ctx?.client.getLogs) continue;

    const rows = await db
      .select({
        id: resources.id,
        resourceTypeId: resources.resourceTypeId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        parentResourceId: resources.parentResourceId,
        fieldsJson: resources.fieldsJson,
        createdAt: resources.createdAt,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          eq(resources.accountId, account.id),
          // The synthetic account-root row is never a tailable stream —
          // matches the desktop discovery's filter.
          ne(resources.resourceTypeId, "__account__"),
          isNull(resources.deletedAt),
        ),
      )
      .orderBy(resources.displayName);

    for (const row of rows) {
      if (out.length >= MAX_RESULTS) break;
      const instance: ResourceInstance = {
        id: row.id,
        pluginId: account.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: account.id,
        displayName: row.displayName,
        fields: (row.fieldsJson ?? {}) as Record<string, string | number | boolean>,
        resolvedOutputs: {},
        secretStates: [],
        ...(row.externalId ? { externalId: row.externalId } : {}),
        ...(row.parentResourceId ? { parentResourceId: row.parentResourceId } : {}),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
      try {
        const schema = ctx.client.renderDetail(instance);
        if (!schema.logs) continue;
      } catch {
        continue; // A row a plugin can't render from stored fields is skipped.
      }
      out.push({
        resourceId: row.id,
        accountId: account.id,
        accountName: account.displayName,
        pluginId: account.pluginId,
        resourceTypeId: row.resourceTypeId,
        displayName: row.displayName,
      });
    }
  }
  return { resources: out };
}
