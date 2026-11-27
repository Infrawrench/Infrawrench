/**
 * One Terraform workspace's state, as `@infrawrench/git-terraform`'s
 * `StateStore`: the lock, the current version and the catalogue of versions
 * in a Durable Object's SQLite, the bytes in R2.
 *
 * Written against `repo/do/platform.ts`, like the repository's storage, so
 * the tests run it in Node with the real `terraform` on the other end.
 *
 * **Why two writers cannot both win.** A Durable Object runs one event at a
 * time, but `commit` awaits R2 between the backend's read of the head and the
 * write, and another request runs in that gap. So the bytes go to R2 first,
 * under a key nothing else uses, and the head moves in one synchronous SQLite
 * transaction that checks the head is still what the backend decided on
 * (`HeadExpectation`). A commit that loses deletes the object it wrote.
 * Locking and unlocking are one synchronous step each.
 *
 * **Keys.** `terraform/<workspaceId>/<serial>-<versionId>.tfstate`. A key is
 * written once and never overwritten: a restore writes a new version.
 */
import type {
  CommitResult,
  HeadExpectation,
  HeldLock,
  NewStateVersion,
  PurgeResult,
  StateHead,
  StateStore,
  StateVersion,
  VersionPage,
} from "@infrawrench/git-terraform";
import type { Bucket, RepoStorage, SqlValue } from "../repo/do/platform";

/** What the object's storage and the bucket must do. A Durable Object's and R2 do; so do the tests'. */
export interface StateStorePlatform {
  readonly bucket: Bucket;
  readonly storage: Pick<RepoStorage, "sql" | "transactionSync" | "deleteAll">;
  readonly now?: () => number;
}

/** A stored version and where its bytes are. */
export interface StoredStateVersion extends StateVersion {
  readonly r2Key: string;
}

interface VersionRow extends Record<string, SqlValue> {
  seq: number;
  id: string;
  serial: number;
  lineage: string;
  terraform_version: string | null;
  resource_count: number;
  size: number;
  sha256: string;
  created_at: string;
  created_by: string;
  r2_key: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS versions (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     serial INTEGER NOT NULL,
     lineage TEXT NOT NULL,
     terraform_version TEXT,
     resource_count INTEGER NOT NULL,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     r2_key TEXT NOT NULL
   )`,
];

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sorts by time, then random: 9 characters of milliseconds, 13 of randomness. */
const newVersionId = (now: number): string => {
  let time = "";
  let rest = Math.max(0, Math.floor(now));
  for (let i = 0; i < 9; i++) {
    time = ALPHABET[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(13));
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 32];
  return `${time}${tail}`;
};

const toVersion = (row: VersionRow): StoredStateVersion => ({
  id: row.id,
  serial: row.serial,
  lineage: row.lineage,
  terraformVersion: row.terraform_version,
  resourceCount: row.resource_count,
  size: row.size,
  sha256: row.sha256,
  createdAt: row.created_at,
  createdBy: row.created_by,
  r2Key: row.r2_key,
});

/** `terraform/<workspaceId>/`: everything a workspace keeps in the bucket. */
export const workspacePrefix = (workspaceId: string): string => `terraform/${workspaceId}/`;

export const stateKey = (workspaceId: string, serial: number, versionId: string): string =>
  `${workspacePrefix(workspaceId)}${serial}-${versionId}.tfstate`;

export class WorkspaceStateStore implements StateStore {
  private workspaceId: string | null = null;
  private ready = false;

  constructor(private readonly platform: StateStorePlatform) {}

  /**
   * Says which workspace this is. A Durable Object is not told the name it
   * was looked up by, and the id is the R2 prefix, so the caller says it and
   * the store refuses to be another workspace than it first was.
   */
  open(workspaceId: string): this {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId)) {
      throw new Error("That is not a workspace id");
    }
    if (this.workspaceId === workspaceId) return this;
    const { sql } = this.platform.storage;
    if (!this.ready) {
      for (const statement of SCHEMA) sql.exec(statement);
      this.ready = true;
    }
    const known = this.meta("workspace_id");
    if (known === null) {
      sql.exec(`INSERT INTO meta (key, value) VALUES ('workspace_id', ?)`, workspaceId);
    } else if (known !== workspaceId) {
      throw new Error("This object holds another workspace's state");
    }
    this.workspaceId = workspaceId;
    return this;
  }

  private id(): string {
    if (this.workspaceId === null) throw new Error("The state store was not opened");
    return this.workspaceId;
  }

  private meta(key: string): string | null {
    const [row] = this.platform.storage.sql
      .exec<{ value: string | null }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray();
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    this.platform.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private row(versionId: string): VersionRow | null {
    const [row] = this.platform.storage.sql
      .exec<VersionRow>(`SELECT * FROM versions WHERE id = ?`, versionId)
      .toArray();
    return row ?? null;
  }

  private lockNow(): HeldLock | null {
    const stored = this.meta("lock");
    return stored === null ? null : (JSON.parse(stored) as HeldLock);
  }

  /** The head, read in one synchronous step. */
  headNow(): { version: StoredStateVersion | null; lock: HeldLock | null } {
    this.id();
    const current = this.meta("current_version_id");
    const row = current === null ? null : this.row(current);
    return { version: row ? toVersion(row) : null, lock: this.lockNow() };
  }

  private matches(expect: HeadExpectation): boolean {
    const head = this.headNow();
    return (
      (head.version?.id ?? null) === expect.versionId &&
      (head.lock?.info.ID ?? null) === expect.lockId
    );
  }

  head(): Promise<StateHead> {
    return Promise.resolve(this.headNow());
  }

  async read(versionId: string): Promise<Uint8Array | null> {
    this.id();
    const row = this.row(versionId);
    if (!row) return null;
    const object = await this.platform.bucket.get(row.r2_key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async commit(
    version: NewStateVersion,
    bytes: Uint8Array,
    expect: HeadExpectation,
  ): Promise<CommitResult> {
    const workspaceId = this.id();
    // Refused before anything is uploaded when it already cannot win.
    if (!this.matches(expect)) return { ok: false, head: this.headNow() };
    const id = newVersionId(this.platform.now?.() ?? Date.now());
    const key = stateKey(workspaceId, version.serial, id);
    await this.platform.bucket.put(key, bytes);
    const stored: StoredStateVersion = { ...version, id, r2Key: key };
    const won = this.platform.storage.transactionSync(() => {
      if (!this.matches(expect)) return false;
      this.platform.storage.sql.exec(
        `INSERT INTO versions
           (id, serial, lineage, terraform_version, resource_count, size, sha256, created_at, created_by, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        version.serial,
        version.lineage,
        version.terraformVersion,
        version.resourceCount,
        version.size,
        version.sha256,
        version.createdAt,
        version.createdBy,
        key,
      );
      this.setMeta("current_version_id", id);
      return true;
    });
    if (!won) {
      // Somebody else's write or lock landed while the bytes were uploading.
      await this.platform.bucket.delete(key).catch(() => {});
      return { ok: false, head: this.headNow() };
    }
    return { ok: true, version: stored };
  }

  purge(expect: HeadExpectation): Promise<PurgeResult> {
    this.id();
    const done = this.platform.storage.transactionSync(() => {
      if (!this.matches(expect)) return false;
      this.setMeta("current_version_id", null);
      return true;
    });
    return Promise.resolve(done ? { ok: true } : { ok: false, head: this.headNow() });
  }

  versions(page: VersionPage): Promise<readonly StoredStateVersion[]> {
    this.id();
    const limit = Math.max(0, Math.min(Math.floor(page.limit), 500));
    const before = page.before === undefined ? null : (this.row(page.before)?.seq ?? 0);
    const rows = this.platform.storage.sql
      .exec<VersionRow>(
        `SELECT * FROM versions WHERE (?1 IS NULL OR seq < ?1) ORDER BY seq DESC LIMIT ?2`,
        before,
        limit,
      )
      .toArray();
    return Promise.resolve(rows.map(toVersion));
  }

  version(versionId: string): Promise<StoredStateVersion | null> {
    this.id();
    const row = this.row(versionId);
    return Promise.resolve(row ? toVersion(row) : null);
  }

  acquireLock(lock: HeldLock): Promise<HeldLock | null> {
    this.id();
    const holder = this.platform.storage.transactionSync(() => {
      const held = this.lockNow();
      if (held) return held;
      this.setMeta("lock", JSON.stringify(lock));
      return null;
    });
    return Promise.resolve(holder);
  }

  releaseLock(lockId: string | null): Promise<HeldLock | null> {
    this.id();
    const remaining = this.platform.storage.transactionSync(() => {
      const held = this.lockNow();
      if (held && (lockId === null || held.info.ID === lockId)) {
        this.setMeta("lock", null);
        return null;
      }
      return held;
    });
    return Promise.resolve(remaining);
  }

  /** Deletes every stored version's bytes and every row. The object is empty afterwards. */
  async destroy(): Promise<{ deletedFiles: number }> {
    const prefix = workspacePrefix(this.id());
    let deletedFiles = 0;
    let cursor: string | undefined;
    do {
      const listing = await this.platform.bucket.list({
        prefix,
        limit: 1000,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const keys = listing.objects.map((object) => object.key);
      if (keys.length > 0) await this.platform.bucket.delete(keys);
      deletedFiles += keys.length;
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor !== undefined);
    await this.platform.storage.deleteAll();
    this.ready = false;
    this.workspaceId = null;
    return { deletedFiles };
  }
}
