/**
 * Local-mode DNS inventory assembly. Mirrors the server's `/dns` endpoint
 * against the desktop SQLite: the same shared `computeDnsInventory` from
 * client-core (imported through `@infrawrench/ui`, the renderer convention),
 * run over this workspace's stored accounts and resources plus the `dnsRole`
 * and `dnsServiceHosts` declarations of the locally loaded plugins.
 * Credential-free — the classification is a property of stored state, so it
 * works with the network off, and no DNS is resolved either way. The CLI's
 * `--local` twin lives in electron/local-dns.ts, which has no renderer to call
 * into.
 */
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import {
  computeDnsInventory,
  type DnsInventoryResponse,
  type DnsScanResource,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { loadPlugins } from "../plugins/loader";

interface ResourceRow {
  id: string;
  plugin_id: string;
  resource_type_id: string;
  account_id: string;
  display_name: string;
  external_id: string | null;
  parent_resource_id: string | null;
  fields_json: string | null;
}

/** SQLite stores the fields bag as TEXT; a hand-edited row may not parse. */
function parseBag(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The rows both local scans read. Carries the plugins' full resource-type
 * definitions rather than either scan's narrowed view, so one query feeds
 * `computeDnsInventory` and `computePostureFindings` alike — reading them
 * twice would let the two disagree about what is synced, and the posture pass
 * takes the DNS inventory as an input.
 */
export interface LocalScanRows {
  plugins: { id: string; displayName: string; resourceTypes: readonly ResourceTypeDefinition[] }[];
  accounts: { id: string; displayName: string; pluginId: string }[];
  resources: DnsScanResource[];
}

export async function localScanRows(): Promise<LocalScanRows> {
  const db = await getDb();

  // Independent reads; neither feeds the other's query.
  const [resourceRows, accountRows, plugins] = await Promise.all([
    db.select<ResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name,
              external_id, parent_resource_id, fields_json
       FROM resources WHERE deleted_at IS NULL`,
    ),
    db.select<{ id: string; display_name: string; plugin_id: string }[]>(
      `SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL`,
    ),
    loadPlugins(),
  ]);

  return {
    plugins: plugins.map(({ plugin }) => ({
      id: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      resourceTypes: plugin.resourceTypes,
    })),
    accounts: accountRows.map((a) => ({
      id: a.id,
      displayName: a.display_name,
      pluginId: a.plugin_id,
    })),
    resources: resourceRows.map((r) => ({
      id: r.id,
      pluginId: r.plugin_id,
      resourceTypeId: r.resource_type_id,
      accountId: r.account_id,
      displayName: r.display_name,
      externalId: r.external_id,
      parentResourceId: r.parent_resource_id,
      fields: parseBag(r.fields_json),
    })),
  };
}

export async function loadLocalDns(): Promise<DnsInventoryResponse> {
  return computeDnsInventory(await localScanRows());
}
