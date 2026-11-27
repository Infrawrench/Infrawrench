/**
 * The Terraform state backend's vocabulary: what a workspace's state is, what
 * holds it, and the storage a host gives the backend. Nothing here knows about
 * HTTP (`http.ts`) or about where the bytes live (the worker's Durable Object
 * and R2 implement {@link StateStore}).
 */

/**
 * The lock info Terraform sends with a lock request and expects back, verbatim,
 * when the lock is already held. The keys are Terraform's own
 * (`statemgr.LockInfo`), capitalised as it writes them.
 */
export interface LockInfo {
  /** A UUID Terraform makes per lock. State writes carry it as `?ID=`. */
  readonly ID: string;
  /** `OperationTypePlan`, `OperationTypeApply`, `migration`, ... */
  readonly Operation: string;
  readonly Info: string;
  /** `user@host`, as the client reports it. Not an identity we checked. */
  readonly Who: string;
  /** The Terraform version holding the lock. */
  readonly Version: string;
  /** RFC 3339, the client's clock. */
  readonly Created: string;
  readonly Path: string;
}

/** A lock as the store keeps it: Terraform's info plus who we know took it. */
export interface HeldLock {
  readonly info: LockInfo;
  /** The authenticated principal that took the lock (a user, a token, a CI job). */
  readonly heldBy: string;
  /** ISO 8601, the server's clock. */
  readonly lockedAt: string;
}

/** One stored version of a workspace's state. The bytes are read by `id`. */
export interface StateVersion {
  /** Opaque and unique within the workspace; the store assigns it. */
  readonly id: string;
  /** Terraform's own counter, which goes up by one with each change. */
  readonly serial: number;
  /** Terraform's id for one state's whole history. A different lineage is a different state. */
  readonly lineage: string;
  readonly terraformVersion: string | null;
  /** Resource blocks in the document (managed and data), for listings. */
  readonly resourceCount: number;
  /** Bytes, as stored. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the bytes. */
  readonly sha256: string;
  /** ISO 8601, the server's clock. */
  readonly createdAt: string;
  /** The authenticated principal that wrote it. */
  readonly createdBy: string;
}

/** What the store assigns is left out: the backend fills in the rest. */
export type NewStateVersion = Omit<StateVersion, "id">;

/** A workspace's state right now. */
export interface StateHead {
  /** The newest version, or null when there is no state (never written, or purged). */
  readonly version: StateVersion | null;
  readonly lock: HeldLock | null;
}

/**
 * What the head must still be for a change to go through. The backend reads
 * the head, decides, and names what it decided on; the store applies the
 * change only if both still hold, in one step. That is what keeps two writers
 * from both winning when the store awaits object storage between its read and
 * its write.
 */
export interface HeadExpectation {
  /** The current version's id, or null for "no state". */
  readonly versionId: string | null;
  /** The held lock's `ID`, or null for "unlocked". */
  readonly lockId: string | null;
}

export type CommitResult =
  | { readonly ok: true; readonly version: StateVersion }
  | { readonly ok: false; readonly head: StateHead };

export type PurgeResult = { readonly ok: true } | { readonly ok: false; readonly head: StateHead };

export interface VersionPage {
  /** At most this many, newest first. */
  readonly limit: number;
  /** Only versions older than this one (a version id from the previous page). */
  readonly before?: string | undefined;
}

/**
 * Storage for one workspace's state. One instance per workspace: the worker's
 * is a Durable Object (lock and version catalogue in its SQLite, bytes in R2),
 * the tests' is {@link MemoryStateStore}.
 *
 * Every method is atomic on its own. Nothing here checks who is asking; the
 * caller resolved access before it got a store.
 */
export interface StateStore {
  head(): Promise<StateHead>;
  /** A version's bytes, or null when the store has no such version. */
  read(versionId: string): Promise<Uint8Array | null>;
  /** Stores the bytes and makes them the head, if the head is still as expected. */
  commit(
    version: NewStateVersion,
    bytes: Uint8Array,
    expect: HeadExpectation,
  ): Promise<CommitResult>;
  /**
   * Leaves the workspace with no current state, if the head is still as
   * expected. Stored versions stay listed and readable: a purge is undone by
   * restoring one.
   */
  purge(expect: HeadExpectation): Promise<PurgeResult>;
  versions(page: VersionPage): Promise<readonly StateVersion[]>;
  version(versionId: string): Promise<StateVersion | null>;
  /** Takes the lock when none is held and answers null; otherwise answers the holder. */
  acquireLock(lock: HeldLock): Promise<HeldLock | null>;
  /**
   * Releases the lock if its `ID` is `lockId`, or whatever lock is held when
   * `lockId` is null (a forced unlock). Answers the lock still held afterwards:
   * null when it was released or none was held.
   */
  releaseLock(lockId: string | null): Promise<HeldLock | null>;
}
