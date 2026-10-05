/**
 * Local-mode extended-support findings, for the `local_extended_support_list`
 * IPC channel and the CLI's `infrawrench extended-support --local`.
 *
 * The same computation the cloud runs (client-core's `computeExtendedSupport`
 * over the plugins' declared support calendars) against this machine's SQLite
 * workspace. Plugin *metadata* only: no plugin client, no credential
 * decryption, no provider call, so there is no billed overlay and every
 * figure is list price (the response carries no `billing` block, which is how
 * surfaces know).
 *
 * Like `local-orphans.ts`, the local `resources` table only holds what the app
 * created or pinned, so a local scan is narrow by construction.
 *
 * The client-core import is dynamic for the CJS→ESM reason documented in
 * `local-expiring.ts`. No GUI side effects (no `ipcMain` import here).
 */
import type { ExtendedSupportListResponse } from "@infrawrench/client-core" with {
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
  fields_json: string | null;
}

function parseBag(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** The local workspace's extended-support findings, most urgent first. */
export async function listLocalExtendedSupport(
  opts: { leadDays?: number } = {},
): Promise<ExtendedSupportListResponse> {
  const db = await getDb();
  const [resourceRows, accountRows, plugins] = await Promise.all([
    db.select<LocalResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name,
              external_id, fields_json
       FROM resources WHERE deleted_at IS NULL`,
    ),
    db.select<{ id: string; display_name: string; plugin_id: string }[]>(
      `SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL`,
    ),
    loadPlugins(),
  ]);

  const { computeExtendedSupport } = await import("@infrawrench/client-core");

  return computeExtendedSupport(
    {
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
        fields: parseBag(r.fields_json),
      })),
    },
    opts.leadDays !== undefined ? { leadDays: opts.leadDays } : {},
  );
}
