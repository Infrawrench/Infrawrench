/**
 * Local-mode posture-finding assembly. Mirrors the server's `/posture`
 * endpoint against the desktop SQLite: the same shared
 * `computePostureFindings` from client-core (imported through
 * `@infrawrench/ui`, the renderer convention), run over this workspace's
 * stored accounts and resources plus the `postureChecks` declarations of the
 * locally loaded plugins. Credential-free — classification is a property of
 * stored state, so it works with the network off. The CLI's `--local` twin
 * lives in electron/local-posture.ts, which has no renderer to call into.
 *
 * The rows come from `local-dns.ts` because the dangling-DNS finding is
 * cross-resource: it needs the whole workspace's DNS inventory, computed over
 * exactly the rows this scan sees. Dismissals are local too, in the
 * `posture_dismissals` table: accepting a finding on a workspace that has never
 * seen the cloud must not require an account. Cloud mode records the same
 * decision through the API instead (lib/cloud-resources.ts), because there it
 * is org state.
 */
import {
  computeDnsInventory,
  computePostureFindings,
  type PostureDismissal,
  type PostureListResponse,
} from "@infrawrench/ui";
import { getDb } from "../db/client";
import { localScanRows } from "./local-dns";

interface DismissalRow {
  resource_id: string;
  rule_id: string;
  reason: string | null;
  updated_at: string;
}

/**
 * The local workspace is single-user, so a dismissal has no author to name —
 * `dismissedBy` is null and the shared section simply omits the "by …" half.
 */
function toDismissal(row: DismissalRow): PostureDismissal {
  return {
    resourceId: row.resource_id,
    ruleId: row.rule_id,
    reason: row.reason,
    dismissedBy: null,
    dismissedAt: row.updated_at,
  };
}

export async function loadLocalPosture(): Promise<PostureListResponse> {
  const db = await getDb();

  // Independent reads; neither feeds the other's query.
  const [rows, dismissalRows] = await Promise.all([
    localScanRows(),
    db.select<DismissalRow[]>(
      `SELECT resource_id, rule_id, reason, updated_at FROM posture_dismissals`,
    ),
  ]);

  return computePostureFindings(
    { ...rows, dismissals: dismissalRows.map(toDismissal) },
    { dns: computeDnsInventory(rows) },
  );
}

/**
 * Accept a finding in the local workspace. Idempotent on `(resource, rule)`,
 * like the cloud route: dismissing twice rewrites the note.
 *
 * The timestamps are written explicitly rather than left to the column
 * default, because SQLite's `datetime('now')` produces `"YYYY-MM-DD HH:MM:SS"`
 * — which the shared section would render as a local-time instant and sort
 * against ISO strings from the cloud path.
 */
export async function dismissLocalPostureFinding(
  resourceId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const trimmed = reason.trim();
  await db.execute(
    `INSERT INTO posture_dismissals (id, resource_id, rule_id, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_id, rule_id)
     DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), resourceId, ruleId, trimmed === "" ? null : trimmed, now, now],
  );
}

/** Undo a local dismissal. */
export async function restoreLocalPostureFinding(
  resourceId: string,
  ruleId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM posture_dismissals WHERE resource_id = ? AND rule_id = ?`, [
    resourceId,
    ruleId,
  ]);
}
