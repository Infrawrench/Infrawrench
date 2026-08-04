/**
 * Local-mode posture findings for the CLI.
 *
 * The cloud path (`GET /api/org/:orgId/posture`) computes the findings
 * server-side over an organization's synced rows. This is the same
 * computation — client-core's `computePostureFindings`, over the same
 * declarative `postureChecks` rules — run against the desktop's local SQLite
 * workspace, so `infrawrench posture --local` works signed out. It reads the
 * workspace and loads plugin *metadata* only: no plugin client is
 * constructed, no account credentials are decrypted, and no provider is
 * contacted.
 *
 * The renderer has its own twin (src/lib/local-posture.ts) because the GUI's
 * DB access goes over IPC; this one exists for the CLI, which has no
 * renderer.
 *
 * The `computePostureFindings` import is dynamic because this module graph is
 * CommonJS and client-core ships ESM (the same CJS→ESM bridge as
 * local-expiring.ts); electron-vite bundles it into the main chunk, so it
 * resolves at build time rather than being a runtime hop.
 *
 * No GUI side effects (no `ipcMain` import), per the rule in CLAUDE.md that
 * keeps electron/db.ts and its consumers importable from electron/cli/*.
 */
import type { PostureListResponse } from "@infrawrench/client-core" with {
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

/** SQLite stores the fields bag as TEXT; a hand-edited row may not parse. */
function parseBag(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** The local workspace's posture findings, worst severity first. */
export async function listLocalPosture(): Promise<PostureListResponse> {
  const db = await getDb();

  // Independent reads; neither feeds the other's query.
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

  const { computePostureFindings } = await import("@infrawrench/client-core");

  return computePostureFindings({
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
  });
}
