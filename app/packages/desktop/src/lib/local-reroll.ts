/**
 * A secret field's Reroll dialog for a resource stored on this machine: the
 * "From resource" list, and pointing the field at the picked output.
 *
 * The candidate rule is client-core's (`rerollSources` / `rerollCandidates`),
 * the same one the cloud route applies to the org's rows; here it reads the
 * local database and plugin registry. Cloud mode goes through the contract's
 * `associations` endpoints instead (`cloud-resources.ts`).
 */
import { rerollCandidates, rerollSources } from "@infrawrench/client-core";
import type { ProviderResource } from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import { createPluginClient } from "./plugin-client";
import { persistOutputRef } from "./sql-drivers";

interface ResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  fields_json: string | null;
}

function parseFields(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The local resources whose outputs can fill `fieldKey` of `consumer`. */
export async function loadLocalRerollCandidates(
  consumer: { id: string; pluginId: string; resourceTypeId: string },
  fieldKey: string,
): Promise<ProviderResource[]> {
  const plugins = await loadPlugins();
  const sources = rerollSources(
    plugins.map((p) => ({ pluginId: p.plugin.manifest.id, resourceTypes: p.plugin.resourceTypes })),
    consumer,
    fieldKey,
  );
  if (sources.length === 0) return [];
  const db = await getDb();
  const rows = await db.select<ResourceRow[]>(
    `SELECT id, plugin_id, resource_type_id, account_id, display_name, fields_json
     FROM resources WHERE deleted_at IS NULL`,
  );
  const logos = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin.manifest.logoSvg]));
  return rerollCandidates(
    sources,
    rows.map((r) => ({
      id: r.id,
      pluginId: r.plugin_id,
      resourceTypeId: r.resource_type_id,
      accountId: r.account_id,
      displayName: r.display_name,
      fields: parseFields(r.fields_json),
    })),
    consumer.id,
  ).map((c) => ({ ...c, pluginLogoSvg: logos.get(c.pluginId) ?? "" }));
}

/**
 * Point `resourceId`.`fieldKey` at a provider's output. The value is resolved
 * now so the reference has something to serve before the reconciler's next
 * pass, and so a provider that cannot produce it fails here, not later.
 */
export async function rerollLocalFieldToOutput(
  resourceId: string,
  fieldKey: string,
  provider: {
    providerResourceId: string;
    providerPluginId: string;
    providerResourceTypeId: string;
    providerAccountId: string;
    providerOutputKey: string;
  },
): Promise<void> {
  const client = await createPluginClient(provider.providerAccountId, provider.providerPluginId);
  const value = await client.resolveOutput(
    provider.providerResourceTypeId,
    provider.providerResourceId,
    provider.providerOutputKey,
    provider.providerAccountId,
  );
  if (!value) throw new Error(`The resource has no ${provider.providerOutputKey} to use.`);
  await persistOutputRef(resourceId, fieldKey, {
    pluginId: provider.providerPluginId,
    resourceTypeId: provider.providerResourceTypeId,
    resourceId: provider.providerResourceId,
    accountId: provider.providerAccountId,
    outputKey: provider.providerOutputKey,
    value,
  });
}
