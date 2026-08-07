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
import { randomUUID } from "node:crypto";
import type { PostureDismissal, PostureListResponse } from "@infrawrench/client-core" with {
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

interface LocalDismissalRow {
  resource_id: string;
  rule_id: string;
  reason: string | null;
  updated_at: string;
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

/** Local dismissals carry no author — the workspace is single-user. */
function toDismissal(row: LocalDismissalRow): PostureDismissal {
  return {
    resourceId: row.resource_id,
    ruleId: row.rule_id,
    reason: row.reason,
    dismissedBy: null,
    dismissedAt: row.updated_at,
  };
}

/** The local workspace's posture findings, worst severity first. */
export async function listLocalPosture(): Promise<PostureListResponse> {
  const db = await getDb();

  // Independent reads (and the lazy evaluator import); none feeds another.
  const [resourceRows, accountRows, dismissalRows, plugins, { computePostureFindings }] =
    await Promise.all([
      db.select<LocalResourceRow[]>(
        `SELECT id, plugin_id, resource_type_id, account_id, display_name,
              external_id, fields_json
       FROM resources WHERE deleted_at IS NULL`,
      ),
      db.select<{ id: string; display_name: string; plugin_id: string }[]>(
        `SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL`,
      ),
      db.select<LocalDismissalRow[]>(
        `SELECT resource_id, rule_id, reason, updated_at FROM posture_dismissals`,
      ),
      loadPlugins(),
      import("@infrawrench/client-core"),
    ]);

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
    dismissals: dismissalRows.map(toDismissal),
  });
}

/**
 * Accept a finding in the local workspace, or rewrite the note on one already
 * accepted. Idempotent on `(resource, rule)`, like the cloud route.
 *
 * The timestamps are written explicitly rather than left to the column
 * default: SQLite's `datetime('now')` produces `"YYYY-MM-DD HH:MM:SS"`, which
 * reads as a local-time instant everywhere the cloud path writes ISO.
 */
export async function dismissLocalPostureFinding(
  resourceId: string,
  ruleId: string,
  reason: string | null,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const trimmed = (reason ?? "").trim();
  await db.execute(
    `INSERT INTO posture_dismissals (id, resource_id, rule_id, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_id, rule_id)
     DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
    [randomUUID(), resourceId, ruleId, trimmed === "" ? null : trimmed, now, now],
  );
}

/**
 * Undo a local dismissal. Returns whether there was one to undo — the delete
 * is preceded by a read because the main-process `execute` reports no row
 * count, and "that finding is not dismissed" is worth saying out loud.
 */
export async function restoreLocalPostureFinding(
  resourceId: string,
  ruleId: string,
): Promise<boolean> {
  const db = await getDb();
  const existing = await db.select<{ id: string }[]>(
    `SELECT id FROM posture_dismissals WHERE resource_id = ? AND rule_id = ?`,
    [resourceId, ruleId],
  );
  if (existing.length === 0) return false;
  await db.execute(`DELETE FROM posture_dismissals WHERE resource_id = ? AND rule_id = ?`, [
    resourceId,
    ruleId,
  ]);
  return true;
}
