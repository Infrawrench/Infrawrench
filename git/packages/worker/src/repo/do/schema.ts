/**
 * The repository's tables in its Durable Object's SQLite.
 *
 * There is no row per object. An object is found through the `.idx` of each
 * pack, which lives in R2 beside the pack and is held in memory while the
 * object is awake (28 bytes an object). A row per object would cost a
 * billed row write for every object of every push and again at every
 * repack (a million-object import is a million writes, twice), and about 70
 * bytes of the object's 10 GB each; the `.idx` costs one R2 write per pack.
 * NOTES.md has the numbers.
 */
import type { RepoStorage, Sql } from "./platform";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
   CREATE TABLE refs (
     name TEXT PRIMARY KEY,
     oid TEXT NOT NULL,
     -- What an annotated tag finally names, so an advertisement reads no objects.
     peeled TEXT
   ) WITHOUT ROWID;
   CREATE TABLE packs (
     id TEXT PRIMARY KEY,
     -- Publication order. An object stored in several packs is read from the
     -- lowest, which is what keeps delta chains across packs free of cycles.
     seq INTEGER NOT NULL DEFAULT 0,
     -- incoming: being received, not readable. live: part of the repository.
     -- garbage: replaced by a repack or dropped, its files deleted after a grace period.
     state TEXT NOT NULL,
     checksum TEXT,
     size INTEGER NOT NULL DEFAULT 0,
     idx_size INTEGER NOT NULL DEFAULT 0,
     objects INTEGER NOT NULL DEFAULT 0,
     -- No delta in it leans on an object in another pack.
     self_contained INTEGER NOT NULL DEFAULT 0,
     -- The multipart upload while incoming, so an abandoned one can be aborted.
     upload_id TEXT,
     created_at INTEGER NOT NULL,
     state_at INTEGER NOT NULL
   ) WITHOUT ROWID;`,
];

/** Brings the schema up to date. Synchronous, so it runs in the constructor. */
export function migrate(storage: RepoStorage): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const [row] = sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray();
  let version = row?.version ?? 0;
  if (row === undefined) sql.exec("INSERT INTO schema_version (version) VALUES (0)");
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    storage.transactionSync(() => {
      // One statement a call: `exec` takes several, but a failure is easier to place this way.
      for (const statement of MIGRATIONS[version]!.split(";")) {
        if (statement.trim() !== "") sql.exec(statement);
      }
      sql.exec("UPDATE schema_version SET version = ?", next);
    });
    version = next;
  }
}

export function getMeta(sql: Sql, key: string): string | null {
  const [row] = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
  return row?.value ?? null;
}

export function setMeta(sql: Sql, key: string, value: string): void {
  sql.exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}
