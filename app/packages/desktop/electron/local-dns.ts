/**
 * Local-mode DNS inventory for the CLI.
 *
 * The cloud path (`GET /api/org/:orgId/dns`) computes the inventory
 * server-side over an organization's synced rows. This is the same
 * computation — client-core's `computeDnsInventory`, over the same declarative
 * `dnsRole` / `dnsServiceHosts` rules — run against the desktop's local SQLite
 * workspace, so `infrawrench dns --local` works signed out. It reads the
 * workspace and loads plugin *metadata* only: no plugin client is constructed,
 * no account credentials are decrypted, no provider is contacted, and no DNS
 * is resolved.
 *
 * The renderer has its own twin (src/lib/local-dns.ts) because the GUI's DB
 * access goes over IPC; this one exists for the CLI, which has no renderer.
 *
 * The `computeDnsInventory` import is dynamic because this module graph is
 * CommonJS and client-core ships ESM (the same CJS→ESM bridge as
 * local-posture.ts); electron-vite bundles it into the main chunk, so it
 * resolves at build time rather than being a runtime hop.
 *
 * No GUI side effects (no `ipcMain` import), per the rule in CLAUDE.md that
 * keeps electron/db.ts and its consumers importable from electron/cli/*.
 */
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import type { DnsInventoryResponse, DnsScanResource } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { getDb } from "./main-utils";
import { loadPlugins } from "../src/plugins/loader";

interface LocalResourceRow {
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
 * `computeDnsInventory` and `computePostureFindings` alike — the posture pass
 * takes the DNS inventory as an input, and reading the rows twice would let
 * the two disagree about what is synced.
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
    db.select<LocalResourceRow[]>(
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

/** The local workspace's DNS inventory, worst-status records first. */
export async function listLocalDns(): Promise<DnsInventoryResponse> {
  const [input, { computeDnsInventory }] = await Promise.all([
    localScanRows(),
    import("@infrawrench/client-core"),
  ]);
  return computeDnsInventory(input);
}
