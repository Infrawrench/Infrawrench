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
 *
 * Stored rows aren't the whole story: a managed cluster's pods live behind
 * its `kubernetes` peer integration, not in the resources table. The sidecar
 * scan (`discoverSidecarLogStreams`, shared with desktop local mode) walks
 * stored parents, builds each log-capable peer plugin's client through
 * `getClientForResource`, and lists the peer streams — a live-provider call,
 * bounded per parent and fail-soft so one broken cluster never empties the
 * picker.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { discoverSidecarLogStreams, type SidecarLogParent } from "@infrawrench/client-core";
import { getPlugin } from "../plugins/loader";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { getClientForAccount, getClientForResource } from "./plugin-clients";

/** One pickable log stream source. */
export interface LogCapableResource {
  resourceId: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  /** Set for sidecar streams: the stored parent the peer client is built through. */
  parentResourceId?: string;
  parentDisplayName?: string;
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
  /** Stored rows whose type declares peer integrations — the sidecar scan's roots. */
  const sidecarParents: SidecarLogParent[] = [];
  for (const account of accountRows) {
    if (out.length >= MAX_RESULTS) break;
    let ctx: Awaited<ReturnType<typeof getClientForAccount>>;
    try {
      ctx = await getClientForAccount(account.id, organizationId);
    } catch {
      continue; // Broken credentials never break the picker for other accounts.
    }
    if (!ctx) continue;
    const peerTypeDefs = ctx.plugin.resourceTypes.filter(
      (t) => (t.peerIntegrations?.length ?? 0) > 0,
    );
    // Rows feed both scans; skip the query when neither applies.
    if (!ctx.client.getLogs && peerTypeDefs.length === 0) continue;

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
      const fields = (row.fieldsJson ?? {}) as Record<string, string | number | boolean>;
      const peerTypeDef = peerTypeDefs.find((t) => t.id === row.resourceTypeId);
      if (peerTypeDef) {
        sidecarParents.push({
          accountId: account.id,
          accountName: account.displayName,
          resourceId: row.id,
          displayName: row.displayName,
          fields,
          integrations: peerTypeDef.peerIntegrations ?? [],
        });
      }
      if (!ctx.client.getLogs || out.length >= MAX_RESULTS) continue;
      const instance: ResourceInstance = {
        id: row.id,
        pluginId: account.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: account.id,
        displayName: row.displayName,
        fields,
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

  // Sidecar streams (pods inside a managed cluster, …) — live peer listings,
  // appended after the stored rows so a slow cluster only delays its own
  // entries' spot in the cap, never the cheap half of the picker.
  if (out.length < MAX_RESULTS && sidecarParents.length > 0) {
    const sidecars = await discoverSidecarLogStreams(sidecarParents, {
      async getPeerClient(parent, pluginId) {
        const peer = await getClientForResource(
          pluginId,
          parent.accountId,
          organizationId,
          parent.resourceId,
        );
        return peer?.client ?? null;
      },
      async peerResourceTypeIds(pluginId) {
        const loaded = await getPlugin(pluginId);
        return loaded ? loaded.plugin.resourceTypes.map((t) => t.id) : [];
      },
      warn: (message) => console.warn(`[log-workspaces] ${message}`),
      maxResults: MAX_RESULTS - out.length,
    });
    out.push(...sidecars);
  }
  return { resources: out };
}
