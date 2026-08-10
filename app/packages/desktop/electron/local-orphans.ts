/**
 * Local-mode orphan & idle resource scan.
 *
 * The cloud path (`GET /api/org/:orgId/orphans`) classifies an organization's
 * synced rows server-side. This is the same scan — plugin-base's
 * `collectOrphanGroups`, over the same declarative `orphanRule`s — run against
 * the desktop's local SQLite workspace instead, so a signed-out user gets the
 * Potential savings section and `infrawrench orphans --local` at all.
 *
 * Lives in the main process rather than the renderer because it has two
 * callers: the `local_orphans_list` IPC handler and the CLI, which has no
 * renderer. It reads the workspace and loads plugin *metadata* only — no
 * plugin client is constructed, no account credentials are decrypted, and no
 * provider is contacted. That is the whole point: classification is a property
 * of stored state, so it works with the network off.
 *
 * No GUI side effects (no `ipcMain` import), per the rule in CLAUDE.md that
 * keeps electron/db.ts and its consumers importable from electron/cli/*.
 */
import {
  collectOrphanGroups,
  countOrphans,
  type OrphanListResponse,
} from "@infrawrench/plugin-base";
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
  last_synced_at: string | null;
}

interface LocalAccountRow {
  id: string;
  display_name: string;
  plugin_id: string;
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
 * Flagged resources in the local workspace, grouped by account.
 *
 * `costWindowDays: 0` and `costBasis: "unavailable"` say what local mode
 * genuinely cannot do: the trailing-spend annotation comes from the cloud's
 * collected billing rows, which no local install has. Callers drop the cost
 * column rather than render a misleading zero.
 */
export async function listLocalOrphans(): Promise<OrphanListResponse> {
  const db = await getDb();

  // Independent reads; neither feeds the other's query.
  const [resourceRows, accountRows, plugins] = await Promise.all([
    db.select<LocalResourceRow[]>(
      `SELECT id, plugin_id, resource_type_id, account_id, display_name,
              external_id, fields_json, last_synced_at
       FROM resources WHERE deleted_at IS NULL`,
    ),
    db.select<LocalAccountRow[]>(
      `SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL`,
    ),
    loadPlugins(),
  ]);

  const accounts = collectOrphanGroups({
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
      lastSyncedAt: r.last_synced_at,
    })),
  });

  const totalCount = countOrphans(accounts);
  return {
    accounts,
    totalCount,
    // Ownership is a cloud record; a local workspace stores none, so every
    // flagged row is unattributed here. Reporting `totalCount` rather than 0
    // is the honest reading of "how many of these has nobody claimed" — the
    // local scan knows of no owners, which is not the same as knowing there
    // are none, and the surfaces say "unattributed" for exactly that reason.
    unownedCount: totalCount,
    costWindowDays: 0,
    costBasis: "unavailable",
    generatedAt: new Date().toISOString(),
  };
}
