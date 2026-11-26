/**
 * Versions of a branch: every push to a branch that is not the default
 * branch is recorded where the branch moves, in the same SQLite transaction,
 * so no push is missed and none is counted twice. The queue consumer copies
 * what is recorded here to Postgres (`events/versions.ts`); this is the
 * authority on which versions there are and how they are numbered.
 *
 * Each version's commit is kept by a ref under {@link VERSION_REF_PREFIX}.
 * That namespace is the server's: a push cannot name it (`policy.ts`
 * `namespaceRefusal`) and no client is shown it (`isHiddenRef`, applied to
 * what the protocol lists). The refs sit in the `refs` table with every
 * other ref, which is what makes a version's commit readable by id
 * (`Repository.isReachable`) after a forced push took it off its branch.
 *
 * They are not branches or tags, so they do not count as reaching anything
 * for the full-clone fast path: a commit only a version ref holds is a
 * leftover, and the forced push or deletion that left it there has already
 * said so (`Repository.changed`). Recording a version at a branch's new tip
 * changes nothing about what branches and tags reach.
 */
import type { ObjectId } from "@infrawrench/git-core";
import type { Sql } from "./platform";

/** `refs/infrawrench/versions/<lineage>/<number>/<branch>`. */
export const VERSION_REF_PREFIX = "refs/infrawrench/versions/";

/** Refs a client is never shown: the forge's own bookkeeping. `refs/pull/*` is shown, CI fetches it. */
export const isHiddenRef = (name: string): boolean => name.startsWith("refs/infrawrench/");

const BRANCH = "refs/heads/";

export const versionRefName = (branch: string, lineage: number, number: number): string =>
  `${VERSION_REF_PREFIX}${lineage}/${number}/${branch}`;

/** One recorded version, as the object keeps it. `branch` is short (`feature/x`). */
export interface StoredVersion {
  readonly branch: string;
  readonly lineage: number;
  readonly number: number;
  readonly tipOid: ObjectId;
  /** The branch's commit before the push; null for a lineage's first version. */
  readonly previousOid: ObjectId | null;
  readonly forced: boolean;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

interface Row {
  branch: string;
  lineage: number;
  number: number;
  tip: string;
  previous: string | null;
  forced: number;
  at: number;
}

const shape = (row: Row): StoredVersion => ({
  branch: row.branch,
  lineage: row.lineage,
  number: row.number,
  tipOid: row.tip,
  previousOid: row.previous,
  forced: row.forced === 1,
  at: row.at,
});

export interface BranchMove {
  /** Full ref name (`refs/heads/feature/x`). */
  readonly name: string;
  /** Null when the branch was created. */
  readonly oldOid: ObjectId | null;
  readonly newOid: ObjectId;
  readonly forced: boolean;
  /**
   * The branch was created at a commit that brings nothing of its own (it is
   * already on the default branch): a new lineage starts, and its first
   * version is the first push after this.
   */
  readonly nothingNew: boolean;
}

/**
 * Records the version a branch's move makes. Call inside the transaction
 * that moved the ref. Answers the version, or null when the move made none.
 */
export function recordVersion(sql: Sql, move: BranchMove, now: number): StoredVersion | null {
  const branch = move.name.slice(BRANCH.length);
  const [current] = sql
    .exec<{ lineage: number; number: number; tip: string | null }>(
      "SELECT lineage, number, tip FROM version_branches WHERE branch = ?",
      branch,
    )
    .toArray();
  let lineage = current?.lineage ?? 1;
  let number = (current?.number ?? 0) + 1;
  if (move.oldOid === null) {
    // Restored where it was: the same branch carries on, and nothing was pushed.
    if (current && current.tip === move.newOid) return null;
    lineage = current ? current.lineage + 1 : 1;
    number = 1;
    if (move.nothingNew) {
      sql.exec(
        "INSERT INTO version_branches (branch, lineage, number, tip) VALUES (?, ?, 0, NULL) ON CONFLICT (branch) DO UPDATE SET lineage = excluded.lineage, number = 0, tip = NULL",
        branch,
        lineage,
      );
      return null;
    }
  }
  sql.exec(
    "INSERT INTO version_branches (branch, lineage, number, tip) VALUES (?, ?, ?, ?) ON CONFLICT (branch) DO UPDATE SET lineage = excluded.lineage, number = excluded.number, tip = excluded.tip",
    branch,
    lineage,
    number,
    move.newOid,
  );
  sql.exec(
    "INSERT INTO versions (branch, lineage, number, tip, previous, forced, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    branch,
    lineage,
    number,
    move.newOid,
    move.oldOid,
    move.forced ? 1 : 0,
    now,
  );
  sql.exec(
    "INSERT INTO refs (name, oid, peeled) VALUES (?, ?, NULL) ON CONFLICT (name) DO UPDATE SET oid = excluded.oid, peeled = NULL",
    versionRefName(branch, lineage, number),
    move.newOid,
  );
  return {
    branch,
    lineage,
    number,
    tipOid: move.newOid,
    previousOid: move.oldOid,
    forced: move.forced,
    at: now,
  };
}

/** Most versions one call lists. */
export const MAX_LISTED_VERSIONS = 500;

/**
 * A branch's versions after a point, oldest first: those of a later lineage,
 * and those of `lineage` numbered above `number`. `after` omitted lists all.
 */
export function listVersions(
  sql: Sql,
  branch: string,
  after?: { readonly lineage: number; readonly number: number },
): StoredVersion[] {
  return sql
    .exec<Row>(
      "SELECT branch, lineage, number, tip, previous, forced, at FROM versions WHERE branch = ? AND (lineage > ? OR (lineage = ? AND number > ?)) ORDER BY lineage, number LIMIT ?",
      branch,
      after?.lineage ?? 0,
      after?.lineage ?? 0,
      after?.number ?? 0,
      MAX_LISTED_VERSIONS,
    )
    .toArray()
    .map(shape);
}

/**
 * Forgets versions: their rows and the refs that kept their commits. Call
 * inside a transaction. Answers how many refs went, so the caller knows
 * whether anything changed. The branch's lineage and count are kept, so
 * numbers are never given out twice.
 */
export function dropVersions(
  sql: Sql,
  branch: string,
  versions: ReadonlyArray<{ readonly lineage: number; readonly number: number }>,
): number {
  let dropped = 0;
  for (const { lineage, number } of versions) {
    sql.exec(
      "DELETE FROM versions WHERE branch = ? AND lineage = ? AND number = ?",
      branch,
      lineage,
      number,
    );
    const name = versionRefName(branch, lineage, number);
    const found = sql.exec<{ n: number }>("SELECT 1 AS n FROM refs WHERE name = ?", name).toArray();
    if (found.length > 0) {
      sql.exec("DELETE FROM refs WHERE name = ?", name);
      dropped++;
    }
  }
  return dropped;
}
