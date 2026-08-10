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
 * The rows come from `local-dns.ts`, which reads exactly what both scans need:
 * the dangling-DNS finding is cross-resource, so the posture pass takes a DNS
 * inventory computed over the same snapshot. Dismissals are local too, in the
 * `posture_dismissals` table: accepting a finding on a workspace that has never
 * seen the cloud must not require an account.
 *
 * The renderer has its own twin (src/lib/local-posture.ts) because the GUI's
 * DB access goes over IPC; this one exists for the CLI, which has no
 * renderer.
 *
 * The client-core import is dynamic because this module graph is CommonJS and
 * client-core ships ESM (the same CJS→ESM bridge as local-expiring.ts);
 * electron-vite bundles it into the main chunk, so it resolves at build time
 * rather than being a runtime hop.
 *
 * No GUI side effects (no `ipcMain` import), per the rule in CLAUDE.md that
 * keeps electron/db.ts and its consumers importable from electron/cli/*.
 */
import { randomUUID } from "node:crypto";
import type { PostureDismissal, PostureListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { getDb } from "./main-utils";
import { localScanRows } from "./local-dns";

interface LocalDismissalRow {
  resource_id: string;
  rule_id: string;
  reason: string | null;
  updated_at: string;
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
  const [rows, dismissalRows, { computeDnsInventory, computePostureFindings }] = await Promise.all([
    localScanRows(),
    db.select<LocalDismissalRow[]>(
      `SELECT resource_id, rule_id, reason, updated_at FROM posture_dismissals`,
    ),
    import("@infrawrench/client-core"),
  ]);

  return computePostureFindings(
    { ...rows, dismissals: dismissalRows.map(toDismissal) },
    { dns: computeDnsInventory(rows) },
  );
}

/**
 * Accept a finding in the local workspace, or rewrite the note on one already
 * accepted. Idempotent on `(resource, rule)`, like the cloud route.
 *
 * The timestamps are written explicitly rather than left to the column
 * default: SQLite's `datetime('now')` produces `"YYYY-MM-DD HH:MM:SS"`, which
 * reads as a local-time instant everywhere the cloud path writes ISO.
 *
 * Returns the note as stored — trimmed, and `null` for a blank one — so the
 * CLI can report what was persisted rather than what it was handed.
 */
export async function dismissLocalPostureFinding(
  resourceId: string,
  ruleId: string,
  reason: string | null,
): Promise<string | null> {
  const db = await getDb();
  const now = new Date().toISOString();
  const trimmed = (reason ?? "").trim();
  const stored = trimmed === "" ? null : trimmed;
  await db.execute(
    `INSERT INTO posture_dismissals (id, resource_id, rule_id, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_id, rule_id)
     DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
    [randomUUID(), resourceId, ruleId, stored, now, now],
  );
  return stored;
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
