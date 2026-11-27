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
} from "./types.js";

/**
 * A {@link StateStore} in memory: the reference for what the interface means,
 * and what the tests run Terraform against. The worker's store does the same
 * with a Durable Object's SQLite and R2.
 */
export class MemoryStateStore implements StateStore {
  /** Oldest first. */
  private readonly history: { version: StateVersion; bytes: Uint8Array }[] = [];
  private current: StateVersion | null = null;
  private lock: HeldLock | null = null;
  private nextId = 1;

  private matches(expect: HeadExpectation): boolean {
    return (
      (this.current?.id ?? null) === expect.versionId &&
      (this.lock?.info.ID ?? null) === expect.lockId
    );
  }

  private snapshot(): StateHead {
    return { version: this.current, lock: this.lock };
  }

  head(): Promise<StateHead> {
    return Promise.resolve(this.snapshot());
  }

  read(versionId: string): Promise<Uint8Array | null> {
    const entry = this.history.find((item) => item.version.id === versionId);
    return Promise.resolve(entry ? entry.bytes.slice() : null);
  }

  commit(
    version: NewStateVersion,
    bytes: Uint8Array,
    expect: HeadExpectation,
  ): Promise<CommitResult> {
    if (!this.matches(expect)) return Promise.resolve({ ok: false, head: this.snapshot() });
    const stored: StateVersion = { ...version, id: `v${this.nextId++}` };
    this.history.push({ version: stored, bytes: bytes.slice() });
    this.current = stored;
    return Promise.resolve({ ok: true, version: stored });
  }

  purge(expect: HeadExpectation): Promise<PurgeResult> {
    if (!this.matches(expect)) return Promise.resolve({ ok: false, head: this.snapshot() });
    this.current = null;
    return Promise.resolve({ ok: true });
  }

  versions(page: VersionPage): Promise<readonly StateVersion[]> {
    const newestFirst = this.history.map((item) => item.version).reverse();
    const from =
      page.before === undefined
        ? 0
        : newestFirst.findIndex((version) => version.id === page.before) + 1;
    return Promise.resolve(newestFirst.slice(from, from + Math.max(0, page.limit)));
  }

  version(versionId: string): Promise<StateVersion | null> {
    return Promise.resolve(
      this.history.find((item) => item.version.id === versionId)?.version ?? null,
    );
  }

  acquireLock(lock: HeldLock): Promise<HeldLock | null> {
    if (this.lock) return Promise.resolve(this.lock);
    this.lock = lock;
    return Promise.resolve(null);
  }

  releaseLock(lockId: string | null): Promise<HeldLock | null> {
    if (this.lock && (lockId === null || this.lock.info.ID === lockId)) this.lock = null;
    return Promise.resolve(this.lock);
  }
}
