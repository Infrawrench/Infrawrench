/**
 * One repository's storage: refs and the pack catalogue in SQLite, packs in
 * R2. Everything a Durable Object does for a repository is here, written
 * against `./platform.ts` so the same code runs under Node in the tests.
 *
 * Nothing takes a lock. A push writes its pack under a key of its own and
 * touches nothing shared until `updateRefs`, which publishes the pack and
 * moves the refs in one synchronous SQLite transaction; each ref is compared
 * with the value the client saw, so of two pushes racing for a branch one
 * wins and the other is told its information is stale.
 */
import {
  type GitObject,
  type ObjectId,
  type ObjectReader,
  type ObjectType,
  type Ref,
  type RefUpdate,
  ZERO_OID,
  buildPack,
  buildTree,
  hashObjectSync,
  isObjectId,
  isValidRefName,
  peelTags,
  serializeCommit,
} from "@infrawrench/git-core";
import {
  CommitGraph,
  type IngestPackOptions,
  type IngestedPack,
  type PackRequest,
  type ReceiveHooks,
  type ReceiveUpdate,
  type RefUpdateResult,
  type RepositoryBackend,
  isAncestor,
  peelWant,
  reachableAmong,
  selectCommits,
  selectObjects,
} from "@infrawrench/git-protocol";
import type { GitEvent, GitEventActor } from "../../env";
import { type MirrorPlan, type MirrorPlanOptions, planMirror } from "../../mirror/plan";
import { type Ingested, ingestPack } from "./ingest";
import { type PackHandle, type PackRow, PackStore, repoPrefix } from "./pack-store";
import { selectByOid, selectEverything, streamPack, streamWhole } from "./pack-stream";
import type { Bucket, EventSink, RepoStorage, Sql } from "./platform";
import { type PushPolicy, checkPush } from "./policy";
import { getMeta, migrate, setMeta } from "./schema";
import {
  type StoredVersion,
  dropVersions,
  isHiddenRef,
  listVersions,
  recordVersion,
} from "./versions";

export interface RepositoryLimits {
  /** Largest pack a push may bring. */
  readonly maxPackBytes: number;
  /**
   * Most objects in one pack. The indexer holds about 55 bytes of table for
   * each, on top of roughly 85 MiB at its peak (NOTES.md "Memory"), and a
   * Durable Object has 128 MB: a pack past this is refused rather than left
   * to run out of memory halfway.
   */
  readonly maxObjectsPerPack: number;
  /** Replaced and dropped packs stay in R2 this long, for readers still streaming them. */
  readonly garbageGraceMs: number;
  /** A pack still `incoming` after this long was abandoned. */
  readonly incomingStaleMs: number;
  /** Repack once there are more live packs than this. */
  readonly repackAbovePacks: number;
  /** Packs larger than this are left alone by a repack. */
  readonly repackMaxPackBytes: number;
  /** A repack writes at most this much. */
  readonly repackMaxTotalBytes: number;
  /** Most bytes copied in from another repository for one pull request head or comparison. */
  readonly maxImportBytes: number;
  /**
   * Most bytes one received pack may inflate to and rebuild, its objects
   * together (core `PackIndexer` `maxInflatedBytes`). A repack is not held to it.
   */
  readonly maxInflatedBytes: number;
}

export const DEFAULT_LIMITS: RepositoryLimits = {
  maxPackBytes: 4 * 1024 * 1024 * 1024,
  maxObjectsPerPack: 500_000,
  garbageGraceMs: 24 * 60 * 60 * 1000,
  incomingStaleMs: 24 * 60 * 60 * 1000,
  repackAbovePacks: 12,
  repackMaxPackBytes: 256 * 1024 * 1024,
  repackMaxTotalBytes: 1024 * 1024 * 1024,
  maxImportBytes: 512 * 1024 * 1024,
  maxInflatedBytes: 8 * 1024 * 1024 * 1024,
};

/** Another repository, as far as this one ever needs it: its refs, and objects out of it. */
export interface PeerRepository {
  listRefs(): Promise<{ refs: Ref[]; head: string }>;
  /** What a fork of it copies. */
  forkManifest(): Promise<ForkManifest>;
  /**
   * A pack of everything `wants` (commits) reach that `haves` do not,
   * standing on its own. Null when a want is not there.
   */
  exportPack(
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
  ): Promise<ReadableStream<Uint8Array> | null>;
}

/** An object reader that can also say a size without a read (`@infrawrench/git-ops` `SizedReader`). */
export interface RepositoryObjects extends ObjectReader {
  hasSync(oid: ObjectId): boolean;
  size(oid: ObjectId): Promise<number | null>;
}

/** Most ref tips offered as "already have" when objects are copied from another repository. */
const MAX_IMPORT_HAVES = 2000;
/** Branches of one push whose trees are read ahead of the fetch that follows it. */
const WARM_BRANCHES = 2;

const isBranchOrTag = (name: string): boolean =>
  name.startsWith("refs/heads/") || name.startsWith("refs/tags/");

/**
 * `meta` keys behind the full-clone fast path. `unreachable` is `0` while
 * every stored object is known to be reachable from a branch or a tag, and
 * anything else once that may not hold. `generation` counts changes to refs
 * and packs, and `unreachable_checked` is the generation a walk last found
 * objects nothing reaches at, so the next clone does not walk to learn it
 * again.
 */
const UNREACHABLE = "unreachable";
const GENERATION = "generation";
const CHECKED = "unreachable_checked";

export interface RepositoryDeps {
  readonly bucket: Bucket;
  readonly storage: RepoStorage;
  /** Where pushes are announced. Null in tests that do not care. */
  readonly events: EventSink<GitEvent> | null;
  readonly limits?: Partial<RepositoryLimits>;
  readonly now?: () => number;
  /**
   * How to reach another repository (a fork, or a fork's parent). In the
   * Durable Object that is another object's stub; in tests, another
   * `Repository`. Without it nothing can be copied across.
   */
  readonly peer?: (repoId: string) => PeerRepository;
}

export interface InitOptions {
  /** A branch name (`main`), not a ref. */
  readonly defaultBranch?: string;
  /** "Initialise with a README": the first commit, made here. */
  readonly readme?: {
    readonly content: string;
    readonly authorName: string;
    readonly authorEmail: string;
    readonly message?: string;
  };
  /**
   * The first commit as any set of files at the root (a README, a
   * `.gitignore`, a `LICENSE`). Takes the place of `readme` when both are
   * given.
   */
  readonly initial?: {
    readonly files: ReadonlyArray<{ readonly name: string; readonly content: string }>;
    readonly authorName: string;
    readonly authorEmail: string;
    readonly message?: string;
  };
}

export interface RepoStats {
  readonly refs: number;
  readonly branches: number;
  readonly tags: number;
  readonly livePacks: number;
  /** Objects across live packs. An object stored in two packs counts twice. */
  readonly objects: number;
  /** Bytes in R2 the repository is using now: live packs and their indexes. */
  readonly liveBytes: number;
  /** Bytes waiting to be deleted, and packs being received. */
  readonly pendingBytes: number;
  /** What storage is metered on: `liveBytes + pendingBytes`. */
  readonly sizeBytes: number;
  readonly empty: boolean;
}

/** What one repository hands another to be forked from. */
export interface ForkManifest {
  readonly repoId: string;
  readonly head: string;
  readonly refs: ReadonlyArray<{ name: string; oid: ObjectId; peeled: ObjectId | null }>;
  readonly packs: ReadonlyArray<{
    readonly id: string;
    readonly checksum: string | null;
    readonly size: number;
    readonly idxSize: number;
    readonly objects: number;
    readonly selfContained: boolean;
  }>;
}

interface StagedPack extends IngestedPack {
  readonly ingested: Ingested;
}

export interface UpdateRefsOptions {
  readonly atomic?: boolean;
  /** Who is making the change, for the event. Null for the forge itself. */
  readonly actor?: GitEventActor | null;
  /** Announce the change on the events queue. Default true. */
  readonly notify?: boolean;
  /** Apply protected-branch rules, as for a push. Without it the update is the forge's own. */
  readonly policy?: PushPolicy | null;
}

export class Repository {
  readonly limits: RepositoryLimits;
  private readonly sql: Sql;
  private readonly now: () => number;
  private store: PackStore | null = null;
  private repacking: Promise<boolean> | null = null;

  constructor(private readonly deps: RepositoryDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.sql = deps.storage.sql;
    this.now = deps.now ?? Date.now;
    migrate(deps.storage);
    const repoId = getMeta(this.sql, "repo_id");
    if (repoId !== null) this.store = new PackStore(deps.bucket, this.sql, repoId);
  }

  /**
   * Binds this storage to its repository id on first use. A Durable Object
   * cannot be told its own name, so every caller says which repository it
   * means; a second, different id would be a routing bug and is refused.
   */
  open(repoId: string): PackStore {
    if (this.store) {
      if (this.store.repoId !== repoId) {
        throw new Error(`this object holds repository ${this.store.repoId}, not ${repoId}`);
      }
      return this.store;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(repoId)) throw new Error("invalid repository id");
    setMeta(this.sql, "repo_id", repoId);
    if (getMeta(this.sql, "head") === null) setMeta(this.sql, "head", "refs/heads/main");
    this.store = new PackStore(this.deps.bucket, this.sql, repoId);
    return this.store;
  }

  /** The reading of trees a push started, while it runs (`warm`). */
  private warming: Promise<void> | null = null;

  private get packs(): PackStore {
    if (!this.store) throw new Error("repository is not open");
    return this.store;
  }

  // Refs

  listRefs(): Ref[] {
    return this.sql
      .exec<{ name: string; oid: string; peeled: string | null }>(
        "SELECT name, oid, peeled FROM refs ORDER BY name",
      )
      .toArray()
      .map((row): Ref =>
        row.peeled
          ? { name: row.name, oid: row.oid, peeled: row.peeled }
          : { name: row.name, oid: row.oid },
      );
  }

  head(): string {
    return getMeta(this.sql, "head") ?? "refs/heads/main";
  }

  setHead(ref: string): void {
    if (!ref.startsWith("refs/heads/") || !isValidRefName(ref)) {
      throw new Error("HEAD must name a branch");
    }
    setMeta(this.sql, "head", ref);
  }

  /** Another repository, as this one was given the means to reach it. */
  peer(repoId: string): PeerRepository {
    if (!this.deps.peer) throw new Error("this repository cannot reach another one");
    return this.deps.peer(repoId);
  }

  /** The id this storage is bound to, or null before `open`. */
  get repoId(): string | null {
    return this.store?.repoId ?? null;
  }

  /** `ctx.storage.sql`, for the reader's own small tables (`schema.ts`). */
  get database(): Sql {
    return this.sql;
  }

  /**
   * Whether this is a repository somebody made: `init` or a fork has run,
   * or something has been pushed. An object that was only ever asked about
   * (a row whose storage was never created, or was destroyed) is not.
   */
  isReady(): boolean {
    if (getMeta(this.sql, "ready") !== null) return true;
    const [row] = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM refs").toArray();
    return (row?.n ?? 0) > 0;
  }

  // Objects

  async readObject(oid: ObjectId): Promise<GitObject | null> {
    if (!isObjectId(oid)) return null;
    return this.packs.read(await this.packs.live(), oid);
  }

  async hasObject(oid: ObjectId): Promise<boolean> {
    return isObjectId(oid) && this.packs.has(await this.packs.live(), oid);
  }

  /** Full ids that start with `prefix` (at least four hex digits), at most `limit`. */
  async resolvePrefix(prefix: string, limit = 2): Promise<ObjectId[]> {
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) return [];
    const found = new Set<ObjectId>();
    for (const pack of await this.packs.live()) {
      for (const oid of pack.index.findByPrefix(prefix, limit)) found.add(oid);
    }
    return [...found].slice(0, limit);
  }

  private reader(packs: readonly PackHandle[]): RepositoryObjects {
    const store = this.packs;
    return {
      read: (oid) => store.read(packs, oid),
      has: async (oid) => store.has(packs, oid),
      hasSync: (oid) => store.has(packs, oid),
      size: (oid) => store.size(packs, oid),
    };
  }

  /**
   * The repository's objects as they are now: one list of packs for as long
   * as the reader is used, so a repack that finishes meanwhile changes
   * nothing under an operation. Take a new one after writing objects.
   */
  async objects(): Promise<RepositoryObjects> {
    return this.reader(await this.packs.live());
  }

  // Receiving

  async ingest(
    pack: ReadableStream<Uint8Array>,
    trusted = false,
    maxPackBytes = this.limits.maxPackBytes,
    /** A push: held to git's object checks (`IngestOptions.fsck`). */
    fsck = false,
    /** How the pack arrives: whole (HTTPS) or followed by more (SSH), and who to tell once it is in. */
    arrival: IngestPackOptions | null = null,
  ): Promise<StagedPack> {
    const store = this.packs;
    const live = await store.live();
    // Before the first byte: if this object dies mid-push, the alarm is what
    // finds the half-uploaded pack and removes it.
    if ((await this.deps.storage.getAlarm()) === null) {
      await this.deps.storage.setAlarm(this.now() + this.limits.incomingStaleMs + 60_000);
    }
    const ingested = await ingestPack(store, pack, {
      existing: this.reader(live),
      maxPackBytes,
      maxObjects: this.limits.maxObjectsPerPack,
      maxInflatedBytes: this.limits.maxInflatedBytes,
      trusted,
      fsck,
      ...(arrival ? { whole: arrival.whole, onReceived: arrival.onReceived } : {}),
    });
    const visible = ingested.handle ? [...live, ingested.handle] : live;
    return {
      objectCount: ingested.objectCount,
      size: ingested.size,
      reader: this.reader(visible),
      ingested,
    };
  }

  async discard(pack: IngestedPack): Promise<void> {
    const handle = (pack as StagedPack).ingested.handle;
    if (!handle) return;
    this.sql.exec("DELETE FROM packs WHERE id = ? AND state = 'incoming'", handle.id);
    this.packs.forget(handle.id);
    await this.packs.deleteFiles(handle.id).catch(() => undefined);
  }

  /** Makes an `incoming` pack part of the repository. Call inside a transaction. */
  private publish(packId: string): void {
    const [row] = this.sql
      .exec<{ next: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM packs WHERE state = 'live'",
      )
      .toArray();
    this.sql.exec(
      "UPDATE packs SET state = 'live', seq = ?, state_at = ? WHERE id = ? AND state = 'incoming'",
      row?.next ?? 1,
      this.now(),
      packId,
    );
  }

  /**
   * Records, inside a transaction, that refs or packs changed. `reachable`
   * says the change cannot have left an object that no branch or tag
   * reaches; otherwise the next full clone walks instead of sending the
   * stored packs (`everythingReachable`).
   */
  private changed(reachable: boolean): void {
    const generation = Number(getMeta(this.sql, GENERATION) ?? "0") + 1;
    setMeta(this.sql, GENERATION, String(generation));
    if (!reachable) setMeta(this.sql, UNREACHABLE, "1");
  }

  /**
   * Refuses creating a ref where another is in the way, as git does:
   * `refs/heads/a` and `refs/heads/a/b` cannot both exist, because a clone
   * stores refs as files and one would have to be a file and a directory at
   * once. A ref deleted in the same change is out of the way. Call inside
   * the transaction; it rewrites `results` in place.
   */
  private refuseNameConflicts(updates: readonly RefUpdate[], results: RefUpdateResult[]): void {
    const removed = new Set<string>();
    updates.forEach((update, index) => {
      if (results[index]!.error === null && update.newOid === ZERO_OID) removed.add(update.name);
    });
    const exists = (name: string): boolean =>
      !removed.has(name) &&
      this.sql.exec<{ n: number }>("SELECT 1 AS n FROM refs WHERE name = ?", name).toArray()
        .length > 0;
    const below = (name: string): string | null => {
      // Every name that starts with `name/`: from `name/` up to, not including, `name0`.
      for (const row of this.sql
        .exec<{ name: string }>(
          "SELECT name FROM refs WHERE name >= ? AND name < ? LIMIT 64",
          `${name}/`,
          `${name}0`,
        )
        .toArray()) {
        if (!removed.has(row.name)) return row.name;
      }
      return null;
    };
    const created: string[] = [];
    updates.forEach((update, index) => {
      if (results[index]!.error !== null) return;
      if (update.oldOid !== ZERO_OID || update.newOid === ZERO_OID) return;
      let clash: string | null = null;
      for (let at = update.name.indexOf("/"); at > 0 && clash === null;) {
        const parent = update.name.slice(0, at);
        if (exists(parent) || created.includes(parent)) clash = parent;
        at = update.name.indexOf("/", at + 1);
      }
      clash ??=
        below(update.name) ?? created.find((name) => name.startsWith(`${update.name}/`)) ?? null;
      if (clash === null) {
        created.push(update.name);
        return;
      }
      results[index] = {
        name: update.name,
        error: `'${clash}' exists; cannot create '${update.name}'`,
      };
    });
  }

  /**
   * Compare-and-swap. The pack, when there is one, is published in the same
   * transaction as the refs that reach it, and dropped when no ref moves.
   */
  async updateRefs(
    updates: readonly RefUpdate[],
    options: { readonly atomic: boolean; readonly pack?: IngestedPack | null },
  ): Promise<RefUpdateResult[]> {
    const staged = (options.pack as StagedPack | null | undefined) ?? null;
    const handle = staged?.ingested.handle ?? null;
    // What each new tip peels to is read before the transaction, which must not await.
    const live = await this.packs.live();
    const reader = staged?.reader ?? this.reader(live);
    // The pack's roots that were not stored already: each must become a branch or tag tip.
    const roots = staged?.ingested.roots ?? null;
    const newRoots = roots === null ? null : roots.filter((oid) => !this.packs.has(live, oid));
    const peeled = new Map<string, ObjectId | null>();
    for (const update of updates) {
      if (update.newOid === ZERO_OID) continue;
      const object = await reader.read(update.newOid);
      if (!object) {
        peeled.set(update.name, null);
        continue;
      }
      peeled.set(
        update.name,
        object.type === "tag" ? (await peelTags(reader, update.newOid)).oid : update.newOid,
      );
    }
    const nothingNew = await this.bringNothing(updates, reader);

    const outcome = this.deps.storage.transactionSync(() => {
      const results = updates.map((update): RefUpdateResult => {
        if (update.newOid !== ZERO_OID && peeled.get(update.name) == null) {
          return { name: update.name, error: "missing necessary objects" };
        }
        const [row] = this.sql
          .exec<{ oid: string }>("SELECT oid FROM refs WHERE name = ?", update.name)
          .toArray();
        const current = row?.oid ?? ZERO_OID;
        if (current === update.oldOid) return { name: update.name, error: null };
        if (update.oldOid === ZERO_OID)
          return { name: update.name, error: "reference already exists" };
        return {
          name: update.name,
          error: current === ZERO_OID ? "reference does not exist" : "stale info",
        };
      });
      this.refuseNameConflicts(updates, results);
      const failed = results.some((result) => result.error !== null);
      if (options.atomic && failed) {
        return {
          published: false,
          results: results.map((result) => ({
            name: result.name,
            error: result.error ?? "atomic push failure",
          })),
        };
      }
      if (results.every((result) => result.error !== null)) return { published: false, results };
      if (handle) this.publish(handle.id);
      updates.forEach((update, index) => {
        if (results[index]!.error !== null) return;
        if (update.newOid === ZERO_OID) {
          this.sql.exec("DELETE FROM refs WHERE name = ?", update.name);
          return;
        }
        const target = peeled.get(update.name)!;
        this.sql.exec(
          "INSERT INTO refs (name, oid, peeled) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET oid = excluded.oid, peeled = excluded.peeled",
          update.name,
          update.newOid,
          target === update.newOid ? null : target,
        );
      });
      const applied = updates.filter((_, index) => results[index]!.error === null);
      this.recordVersions(applied, nothingNew);
      const tips = new Set(
        applied
          .filter((update) => isBranchOrTag(update.name) && update.newOid !== ZERO_OID)
          .map((update) => update.newOid),
      );
      this.changed(
        // Reachability only grows when every change is a new branch or tag, or a branch
        // moved forward, and everything the pack brought hangs off a tip that moved.
        applied.every(
          (update) =>
            isBranchOrTag(update.name) &&
            (update.oldOid === ZERO_OID ||
              (update.newOid !== ZERO_OID &&
                update.name.startsWith("refs/heads/") &&
                (update as { readonly forced?: boolean }).forced === false)),
        ) &&
          (handle === null || (newRoots !== null && newRoots.every((oid) => tips.has(oid)))),
      );
      return { published: handle !== null, results };
    });

    if (outcome.published) {
      this.packs.invalidate();
      await this.scheduleMaintenance();
    } else if (staged) {
      await this.discard(staged);
    }
    return outcome.results;
  }

  // Versions of branches (`versions.ts`)

  /**
   * The branches among `updates` that are being created at a commit the
   * default branch already has: a branch made to start work from, which is
   * not yet a version of anything. Read before the transaction, which must
   * not await. A walk that gives up counts as bringing something.
   */
  private async bringNothing(
    updates: readonly RefUpdate[],
    reader: ObjectReader,
  ): Promise<Set<string>> {
    const none = new Set<string>();
    const head = this.head();
    const created = updates.filter(
      (update) =>
        update.name.startsWith("refs/heads/") &&
        update.name !== head &&
        update.oldOid === ZERO_OID &&
        update.newOid !== ZERO_OID,
    );
    if (created.length === 0) return none;
    const [tip] = this.sql
      .exec<{ oid: string }>("SELECT oid FROM refs WHERE name = ?", head)
      .toArray();
    if (!tip) return none;
    const graph = new CommitGraph(reader);
    for (const update of created) {
      try {
        if (update.newOid === tip.oid || (await isAncestor(graph, update.newOid, tip.oid))) {
          none.add(update.name);
        }
      } catch {
        // Too long a walk to say: recorded as a version, which loses nothing.
      }
    }
    return none;
  }

  /**
   * Records a version for every branch that moved, other than the default
   * branch. Call inside the transaction that moved them. The version's ref
   * points at the branch's new tip, so nothing becomes reachable or
   * unreachable by it and `changed` needs no telling.
   */
  private recordVersions(applied: readonly RefUpdate[], nothingNew: ReadonlySet<string>): void {
    const head = this.head();
    for (const update of applied) {
      if (!update.name.startsWith("refs/heads/") || update.name === head) continue;
      if (update.newOid === ZERO_OID) continue;
      recordVersion(
        this.sql,
        {
          name: update.name,
          oldOid: update.oldOid === ZERO_OID ? null : update.oldOid,
          newOid: update.newOid,
          forced: (update as { readonly forced?: boolean }).forced === true,
          nothingNew: nothingNew.has(update.name),
        },
        this.now(),
      );
    }
  }

  /** A branch's recorded versions after a point, oldest first. `branch` is short. */
  versions(
    branch: string,
    after?: { readonly lineage: number; readonly number: number },
  ): StoredVersion[] {
    return listVersions(this.sql, branch, after);
  }

  /**
   * Forgets versions and the refs that kept their commits. What only those
   * refs held is a leftover now (it was one for full clones already, and
   * stops being readable by id), so the reachability answer is asked again.
   */
  pruneVersions(
    branch: string,
    versions: ReadonlyArray<{ readonly lineage: number; readonly number: number }>,
  ): number {
    return this.deps.storage.transactionSync(() => {
      const dropped = dropVersions(this.sql, branch, versions);
      if (dropped > 0) this.changed(false);
      return dropped;
    });
  }

  // The protocol's view

  /** The repository as `@infrawrench/git-protocol` sees it. */
  backend(): RepositoryBackend {
    const store = this.packs;
    return {
      read: (oid) => this.readObject(oid),
      has: (oid) => this.hasObject(oid),
      // The forge's own refs are never advertised: a client neither sees nor asks for them.
      listRefs: async () => this.listRefs().filter((ref) => !isHiddenRef(ref.name)),
      head: async () => this.head(),
      ingestPack: (pack, arrival) =>
        this.ingest(pack, false, this.limits.maxPackBytes, true, arrival ?? null),
      updateRefs: (updates, options) => this.updateRefs(updates, options),
      discardPack: (pack) => this.discard(pack),
      packObjects: (request: PackRequest) => {
        // The list of packs is read when the stream starts, so the stream is the only thing that waits.
        let inner: ReadableStreamDefaultReader<Uint8Array> | null = null;
        return new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              if (!inner) {
                const packs = await store.live();
                inner = streamPack(store, packs, selectByOid(store, packs, request.objects), {
                  thinBases: request.thinBases,
                  ofsDelta: request.ofsDelta,
                }).getReader();
              }
              const { done, value } = await inner.read();
              if (done) controller.close();
              else controller.enqueue(value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel: async () => {
            await inner?.cancel();
          },
        });
      },
      packEverything: async ({ ofsDelta }) => {
        const packs = await store.live();
        if (packs.length === 0) return null;
        if (!(await this.everythingReachable(packs))) return null;
        const only = packs.length === 1 ? packs[0]! : null;
        if (only && only.selfContained && ofsDelta) {
          // One pack that stands alone is already the answer: R2 to the client, untouched.
          return { stream: streamWhole(only), objectCount: only.index.count };
        }
        const selection = selectEverything(packs);
        return {
          stream: streamPack(store, packs, selection, { thinBases: null, ofsDelta }),
          objectCount: selection.count,
        };
      },
    };
  }

  /**
   * Whether every object in `packs` is reachable from a branch or a tag,
   * which is when a full clone may be sent the stored packs as they are.
   * Known without a walk while nothing has happened since that could leave
   * an object behind (`changed`); otherwise one walk over the history
   * decides, and its answer is kept until refs or packs change again. A
   * repository that holds leftovers is walked by every full clone, as git
   * does, rather than sending them: what a forced push removed, what only
   * `refs/pull/*` reaches, and commits copied in from forks.
   */
  private async everythingReachable(packs: readonly PackHandle[]): Promise<boolean> {
    if (getMeta(this.sql, UNREACHABLE) === "0") return true;
    const generation = getMeta(this.sql, GENERATION) ?? "0";
    if (getMeta(this.sql, CHECKED) === generation) return false;
    let reachable: number;
    try {
      reachable = await this.countReachable(packs);
    } catch {
      // A push landed while this looked: its refs name a pack this list does not have.
      return false;
    }
    const clean = reachable === selectEverything(packs).count;
    this.deps.storage.transactionSync(() => {
      if ((getMeta(this.sql, GENERATION) ?? "0") !== generation) return;
      if (clean) setMeta(this.sql, UNREACHABLE, "0");
      else setMeta(this.sql, CHECKED, generation);
    });
    return clean;
  }

  /** How many objects of `packs` the branches and tags reach, tag objects included. */
  private async countReachable(packs: readonly PackHandle[]): Promise<number> {
    const reader = this.reader(packs);
    const graph = new CommitGraph(reader);
    const commits: ObjectId[] = [];
    const tags: ObjectId[] = [];
    const trees: ObjectId[] = [];
    const blobs: ObjectId[] = [];
    for (const ref of this.listRefs()) {
      if (!isBranchOrTag(ref.name)) continue;
      const peeled = await peelWant(reader, ref.oid);
      if (!peeled) throw new Error(`${ref.name} names a missing object`);
      tags.push(...peeled.tags);
      if (peeled.type === "commit") commits.push(peeled.oid);
      else if (peeled.type === "tree") trees.push(peeled.oid);
      else blobs.push(peeled.oid);
    }
    const none = new Set<ObjectId>();
    const selection = await selectCommits(graph, commits, [], none, none);
    const { objects } = await selectObjects(graph, {
      commits: selection.commits,
      edges: [],
      tags,
      trees,
      blobs,
    });
    return objects.size;
  }

  /**
   * Whether `oid` may be read by id from outside: a ref's tip, what a tag
   * ref peels to, or a commit some ref reaches. Not what a forced push left
   * behind, nor what was copied in from another repository and never given
   * a ref. Used for the raw-file and archive routes, which name a commit.
   */
  async isReachable(oid: ObjectId): Promise<boolean> {
    if (!isObjectId(oid)) return false;
    const tips = new Set<ObjectId>();
    for (const ref of this.listRefs()) {
      tips.add(ref.oid);
      if (ref.peeled) tips.add(ref.peeled);
    }
    if (tips.has(oid)) return true;
    const graph = new CommitGraph(await this.objects());
    return (await reachableAmong(graph, [...tips], [oid])).has(oid);
  }

  /** The policy around a push: protected branches before, the event after. */
  hooks(actor: GitEventActor | null, policy: PushPolicy | null): ReceiveHooks {
    return {
      // Without a policy the namespace rule still holds: a push never writes `refs/pull/*`.
      check: async (updates) => checkPush(policy, updates),
      after: async (applied) => {
        // Not waited for: the push is answered while the trees are read.
        this.warm(applied);
        await this.announce(actor, applied);
      },
    };
  }

  /**
   * Reads the trees of the branches a push just moved, so they are in memory
   * when the fetch that follows asks (`PackStore.read` keeps them). What
   * follows a push within seconds is a CI runner fetching the new commit, and
   * choosing its objects reads every tree of the commit: thousands of them
   * in a monorepo, and from an object the push has just woken, each from the
   * bucket (#1447). The push changed a handful; the rest are read here, once,
   * while the event is still on its way to CI. Nothing depends on it: a walk
   * that fails or is cut short only leaves the next fetch to read for itself.
   */
  private warm(applied: readonly ReceiveUpdate[]): void {
    const tips = applied
      .filter((update) => update.kind !== "delete" && update.name.startsWith("refs/heads/"))
      .slice(0, WARM_BRANCHES)
      .map((update) => update.newOid);
    if (tips.length === 0) return;
    const walk = (async () => {
      const graph = new CommitGraph(this.reader(await this.packs.live()));
      const commits: ObjectId[] = [];
      for (const tip of tips) if (await graph.get(tip)) commits.push(tip);
      await selectObjects(graph, { commits, edges: [], tags: [], trees: [], blobs: [] });
    })().catch(() => undefined);
    const warming = (this.warming = Promise.all([this.warming, walk]).then(() => {
      if (this.warming === warming) this.warming = null;
    }));
  }

  /** Settles when the trees a push asked to have read have been. For tests: nothing waits on it. */
  async warmed(): Promise<void> {
    await this.warming;
  }

  private async announce(
    actor: GitEventActor | null,
    applied: readonly ReceiveUpdate[],
  ): Promise<void> {
    if (!this.deps.events || applied.length === 0) return;
    await this.deps.events.send({
      type: "push",
      repoId: this.packs.repoId,
      actor,
      updates: applied.map(({ name, oldOid, newOid, forced }) => ({
        name,
        oldOid,
        newOid,
        forced,
      })),
      at: this.now(),
    });
  }

  /**
   * A ref change made by the forge (a merge, a web edit, a branch deleted in
   * the UI), or on someone's behalf with `policy`. Same compare-and-swap as
   * a push, and the same event afterwards.
   */
  async applyUpdates(
    updates: readonly RefUpdate[],
    options: UpdateRefsOptions = {},
  ): Promise<RefUpdateResult[]> {
    const reader = this.reader(await this.packs.live());
    const graph = new CommitGraph(reader);
    const classified: ReceiveUpdate[] = [];
    const early = new Map<string, string>();
    const head = this.head();
    for (const update of updates) {
      if (!update.name.startsWith("refs/") || !isValidRefName(update.name)) {
        early.set(update.name, "invalid ref name");
        continue;
      }
      // The same rule a push keeps: HEAD never names a branch that is gone.
      if (update.name === head && update.newOid === ZERO_OID) {
        early.set(update.name, "deletion of the current branch prohibited");
        continue;
      }
      const kind =
        update.oldOid === ZERO_OID ? "create" : update.newOid === ZERO_OID ? "delete" : "update";
      const forced = kind === "update" && !(await isAncestor(graph, update.oldOid, update.newOid));
      classified.push({ ...update, kind, forced });
    }
    if (options.policy) {
      for (const [name, reason] of checkPush(options.policy, classified)) early.set(name, reason);
    }
    if (options.atomic && early.size > 0) {
      return updates.map((update) => ({
        name: update.name,
        error: early.get(update.name) ?? "atomic push failure",
      }));
    }
    const ready = classified.filter((update) => !early.has(update.name));
    const results = new Map(
      (ready.length > 0
        ? await this.updateRefs(ready, { atomic: options.atomic ?? false })
        : []
      ).map((result) => [result.name, result.error]),
    );
    if (options.notify !== false) {
      await this.announce(
        options.actor ?? null,
        ready.filter((update) => results.get(update.name) === null),
      ).catch(() => undefined);
    }
    return updates.map((update) => ({
      name: update.name,
      error: early.get(update.name) ?? results.get(update.name) ?? null,
    }));
  }

  /**
   * Stores objects made on the server (a merge commit, a file edited in the
   * browser) as one small pack. They are part of the repository at once, and
   * unreachable until a ref is moved to them.
   */
  async writeObjects(
    objects: ReadonlyArray<{ readonly type: ObjectType; readonly data: Uint8Array }>,
  ): Promise<ObjectId[]> {
    const oids = objects.map((object) => hashObjectSync(object.type, object.data));
    const live = await this.packs.live();
    const fresh = objects.filter((_, index) => !this.packs.has(live, oids[index]!));
    if (fresh.length === 0) return oids;
    const built = await buildPack(
      fresh.map((object) => ({ type: object.type, data: object.data })),
    );
    await this.adopt(
      await this.ingest(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(built.pack);
            controller.close();
          },
        }),
      ),
    );
    return oids;
  }

  /** Makes a received pack part of the repository with no ref pointing into it yet. */
  private async adopt(staged: StagedPack): Promise<void> {
    const handle = staged.ingested.handle;
    if (!handle) return;
    this.deps.storage.transactionSync(() => {
      this.publish(handle.id);
      // Objects with no ref yet, and maybe never one (a merge attempt that lost, a fork's commits).
      this.changed(false);
    });
    this.packs.invalidate();
    await this.scheduleMaintenance();
  }

  // Objects across repositories

  /**
   * A pack of what `wants` reach and `haves` do not, for another repository
   * to take in: the commits of a fork's pull request, as the base repository
   * needs them. It stands on its own (no delta leans on an object left
   * out), because the receiver's copy of a base may be packed differently.
   * Null when a want is not a commit this repository's branches or tags
   * reach.
   */
  async exportPack(
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
  ): Promise<ReadableStream<Uint8Array> | null> {
    const store = this.packs;
    const packs = await store.live();
    const graph = new CommitGraph(this.reader(packs));
    for (const want of wants) {
      if (!isObjectId(want) || (await graph.get(want)) === null) return null;
    }
    // Only what this repository's own branches and tags reach leaves it: not a
    // commit a forced push removed, nor one copied in here from somewhere else.
    const tips = this.listRefs()
      .filter((ref) => isBranchOrTag(ref.name))
      .map((ref) => ref.peeled ?? ref.oid);
    const reachable = await reachableAmong(graph, tips, wants);
    if (!wants.every((want) => reachable.has(want))) return null;
    const known = haves.filter((oid) => isObjectId(oid) && store.has(packs, oid));
    const none = new Set<ObjectId>();
    const commits = await selectCommits(graph, wants, known, none, none);
    const { objects } = await selectObjects(graph, {
      commits: commits.commits,
      edges: commits.edges,
      tags: [],
      trees: [],
      blobs: [],
    });
    return streamPack(store, packs, selectByOid(store, packs, objects), {
      thinBases: null,
      ofsDelta: true,
    });
  }

  // Push mirrors

  /**
   * What a push mirror's run has to do against a target whose refs are
   * `options.remote` (`mirror/plan.ts`): read here because only here is the
   * commit graph at hand.
   */
  async mirrorPlan(options: MirrorPlanOptions): Promise<MirrorPlan> {
    const store = this.packs;
    const packs = await store.live();
    return planMirror(
      {
        graph: new CommitGraph(this.reader(packs)),
        refs: this.listRefs(),
        head: this.head(),
        has: (oid) => isObjectId(oid) && store.has(packs, oid),
      },
      options,
    );
  }

  /**
   * A pack for one push of a mirror: everything `wants` reach that `haves`
   * do not. A want is a ref's value (so an annotated tag brings its tag
   * object) or a commit on the way to a branch's head. The pack stands on
   * its own, like `exportPack`'s, because nothing is known of how the
   * target stores a base.
   *
   * Null when a want is not something this repository's branches and tags
   * reach any more: a branch that was forced away while the mirror ran is
   * not sent, and the run that follows the force sends what replaced it.
   */
  async mirrorPack(
    wants: readonly ObjectId[],
    haves: readonly ObjectId[],
    options: { readonly ofsDelta: boolean },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const store = this.packs;
    const packs = await store.live();
    const reader = this.reader(packs);
    const graph = new CommitGraph(reader);
    const refs = this.listRefs().filter((ref) => isBranchOrTag(ref.name));
    const refValues = new Set(refs.map((ref) => ref.oid));
    const commits: ObjectId[] = [];
    const tags: ObjectId[] = [];
    const trees: ObjectId[] = [];
    const blobs: ObjectId[] = [];
    for (const want of wants) {
      if (!isObjectId(want)) return null;
      const peeled = await peelWant(reader, want);
      if (peeled === null) return null;
      // A tag object, a tree or a blob leaves only as the value of a ref.
      if ((peeled.tags.length > 0 || peeled.type !== "commit") && !refValues.has(want)) return null;
      tags.push(...peeled.tags);
      if (peeled.type === "commit") commits.push(peeled.oid);
      else if (peeled.type === "tree") trees.push(peeled.oid);
      else blobs.push(peeled.oid);
    }
    const tips = refs.map((ref) => ref.peeled ?? ref.oid);
    const reachable = await reachableAmong(graph, tips, commits);
    if (!commits.every((commit) => reachable.has(commit))) return null;

    const known = new Set<ObjectId>();
    const knownCommits: ObjectId[] = [];
    for (const have of haves) {
      if (!isObjectId(have) || known.has(have) || !store.has(packs, have)) continue;
      known.add(have);
      const peeled = await peelWant(reader, have);
      if (peeled === null) continue;
      for (const tag of peeled.tags) known.add(tag);
      if (peeled.type === "commit") knownCommits.push(peeled.oid);
    }
    const none = new Set<ObjectId>();
    const selected = await selectCommits(graph, commits, knownCommits, none, none);
    const { objects } = await selectObjects(graph, {
      commits: selected.commits,
      edges: selected.edges,
      tags: tags.filter((tag) => !known.has(tag)),
      trees,
      blobs,
    });
    return streamPack(store, packs, selectByOid(store, packs, objects), {
      thinBases: null,
      ofsDelta: options.ofsDelta,
    });
  }

  /**
   * Copies in, from another repository, whatever `wants` (commits) need
   * that is not here yet. This is how a fork's pull request becomes
   * something the base repository can diff, merge and hand to CI: once its
   * head is here, every operation reads one repository. The objects are
   * unreachable until a ref (`refs/pull/<n>/head`) points at them. Answers
   * false when the source does not have a want.
   */
  async importFrom(sourceRepoId: string, wants: readonly ObjectId[]): Promise<boolean> {
    const store = this.packs;
    if (sourceRepoId === store.repoId) return this.hasAll(wants);
    const live = await store.live();
    const missing = wants.filter((oid) => !store.has(live, oid));
    if (missing.length === 0) return true;
    if (!missing.every(isObjectId)) return false;
    const peer = this.peer(sourceRepoId);
    // Tips, newest packs' worth first: enough for the source to leave out shared history.
    const haves = this.sql
      .exec<{ oid: string }>(
        "SELECT DISTINCT COALESCE(peeled, oid) AS oid FROM refs WHERE name LIKE 'refs/heads/%' OR name LIKE 'refs/pull/%' LIMIT ?",
        MAX_IMPORT_HAVES,
      )
      .toArray()
      .map((row) => row.oid);
    const pack = await peer.exportPack(missing, haves);
    if (!pack) return false;
    await this.adopt(await this.ingest(pack, false, this.limits.maxImportBytes));
    return this.hasAll(wants);
  }

  private async hasAll(oids: readonly ObjectId[]): Promise<boolean> {
    const live = await this.packs.live();
    return oids.every((oid) => this.packs.has(live, oid));
  }

  /** Sets up a new repository: HEAD, and a first commit when asked for one. */
  async init(options: InitOptions = {}): Promise<{ head: string; commit: ObjectId | null }> {
    const branch = options.defaultBranch ?? "main";
    const ref = `refs/heads/${branch}`;
    this.setHead(ref);
    setMeta(this.sql, "ready", "1");
    const first =
      options.initial ??
      (options.readme
        ? {
            ...options.readme,
            files: [{ name: "README.md", content: options.readme.content }],
          }
        : null);
    if (!first || first.files.length === 0 || this.listRefs().length > 0) {
      return { head: ref, commit: null };
    }
    const { authorName, authorEmail } = first;
    const blobs = first.files.map((file) => {
      const data = new TextEncoder().encode(file.content);
      return { name: file.name, data, oid: hashObjectSync("blob", data) };
    });
    const tree = buildTree(
      blobs.map((blob) => ({ mode: "100644" as const, name: blob.name, oid: blob.oid })),
    );
    const treeOid = hashObjectSync("tree", tree);
    const who = {
      name: authorName,
      email: authorEmail,
      timestamp: Math.floor(this.now() / 1000),
      timezoneOffset: 0,
    };
    const commit = serializeCommit({
      tree: treeOid,
      parents: [],
      author: who,
      committer: who,
      message: `${first.message ?? "Initial commit"}\n`,
      extraHeaders: [],
    });
    const commitOid = (
      await this.writeObjects([
        ...blobs.map((blob) => ({ type: "blob" as const, data: blob.data })),
        { type: "tree", data: tree },
        { type: "commit", data: commit },
      ])
    ).at(-1);
    const [result] = await this.applyUpdates(
      [{ name: ref, oldOid: ZERO_OID, newOid: commitOid! }],
      { notify: false },
    );
    if (result?.error) throw new Error(`could not create ${ref}: ${result.error}`);
    return { head: ref, commit: commitOid! };
  }

  // Housekeeping

  /** Range reads of the bucket's packs since this object woke: how many, and their bytes. */
  bucketReads(): { readonly gets: number; readonly bytes: number } {
    return { ...this.packs.reads };
  }

  stats(): RepoStats {
    const packs = this.sql.exec<PackRow>("SELECT * FROM packs").toArray();
    const refs = this.listRefs();
    let liveBytes = 0;
    let pendingBytes = 0;
    let objects = 0;
    let livePacks = 0;
    for (const pack of packs) {
      const bytes = pack.size + pack.idx_size;
      if (pack.state === "live") {
        liveBytes += bytes;
        objects += pack.objects;
        livePacks++;
      } else {
        pendingBytes += bytes;
      }
    }
    return {
      refs: refs.length,
      branches: refs.filter((ref) => ref.name.startsWith("refs/heads/")).length,
      tags: refs.filter((ref) => ref.name.startsWith("refs/tags/")).length,
      livePacks,
      objects,
      liveBytes,
      pendingBytes,
      sizeBytes: liveBytes + pendingBytes,
      empty: refs.length === 0,
    };
  }

  /** Makes sure the alarm is set for the next thing that needs doing. */
  async scheduleMaintenance(): Promise<void> {
    const now = this.now();
    let due: number | null = null;
    const sooner = (at: number): void => {
      due = due === null ? at : Math.min(due, at);
    };
    const live = this.packs.rows("live").length;
    if (live > this.limits.repackAbovePacks) sooner(now + 30_000);
    for (const row of this.packs.rows("garbage")) sooner(row.state_at + this.limits.garbageGraceMs);
    for (const row of this.packs.rows("incoming"))
      sooner(row.created_at + this.limits.incomingStaleMs);
    if (due === null) return;
    const current = await this.deps.storage.getAlarm();
    if (current === null || current > due)
      await this.deps.storage.setAlarm(Math.max(due, now + 1000));
  }

  /** The alarm's work: delete what is past its grace period, then repack if packs have piled up. */
  async maintain(): Promise<{ deleted: number; repacked: boolean }> {
    if (!this.store) return { deleted: 0, repacked: false };
    const store = this.packs;
    const now = this.now();
    let deleted = 0;
    const expired = [
      ...store.rows("garbage").filter((row) => row.state_at + this.limits.garbageGraceMs <= now),
      ...store
        .rows("incoming")
        .filter((row) => row.created_at + this.limits.incomingStaleMs <= now),
    ];
    for (const row of expired) {
      if (row.upload_id) {
        const key = `${repoPrefix(store.repoId)}packs/pack-${row.id}.pack`;
        await store.bucket
          .resumeMultipartUpload(key, row.upload_id)
          .abort()
          .catch(() => undefined);
      }
      await store.deleteFiles(row.id);
      this.sql.exec("DELETE FROM packs WHERE id = ?", row.id);
      store.forget(row.id);
      deleted++;
    }
    const repacked =
      store.rows("live").length > this.limits.repackAbovePacks ? await this.repack() : false;
    await this.scheduleMaintenance();
    return { deleted, repacked };
  }

  /**
   * Merges the newest run of small packs into one. A run, never a scattered
   * set: an object in several packs is read from the oldest, and that rule
   * only keeps delta chains free of cycles while the merged pack takes the
   * place of packs that were next to each other.
   *
   * Safe by construction: the new pack is written and verified beside the
   * old ones, the catalogue switches in one transaction, and the old files
   * stay for the grace period so a clone still streaming them finishes.
   */
  repack(): Promise<boolean> {
    this.repacking ??= this.repackOnce().finally(() => {
      this.repacking = null;
    });
    return this.repacking;
  }

  private async repackOnce(): Promise<boolean> {
    const store = this.packs;
    const rows = store.rows("live");
    const live = await store.live();
    const byId = new Map(live.map((handle) => [handle.id, handle]));
    const run: PackRow[] = [];
    let bytes = 0;
    let objects = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (
        row.size > this.limits.repackMaxPackBytes ||
        bytes + row.size > this.limits.repackMaxTotalBytes ||
        objects + row.objects > this.limits.maxObjectsPerPack
      ) {
        break;
      }
      run.unshift(row);
      bytes += row.size;
      objects += row.objects;
    }
    if (run.length < 2) return false;
    const handles = run.map((row) => byId.get(row.id)).filter((handle) => handle !== undefined);
    if (handles.length !== run.length) return false;

    const selection = selectEverything(handles);
    const merged = await ingestPack(
      store,
      streamPack(store, handles, selection, { thinBases: null, ofsDelta: true }),
      {
        existing: this.reader(live),
        maxPackBytes: Number.MAX_SAFE_INTEGER,
        maxObjects: this.limits.maxObjectsPerPack,
        trusted: true,
      },
    );
    if (!merged.handle) return false;
    const mergedId = merged.handle.id;
    const ids = run.map((row) => row.id);
    const switched = this.deps.storage.transactionSync(() => {
      const still = this.sql
        .exec<{ id: string }>("SELECT id FROM packs WHERE state = 'live'")
        .toArray()
        .map((row) => row.id);
      // A pack of the run is gone (another repack, a delete): this result describes a past that no longer is.
      if (!ids.every((id) => still.includes(id))) return false;
      const now = this.now();
      for (const id of ids) {
        this.sql.exec("UPDATE packs SET state = 'garbage', state_at = ? WHERE id = ?", now, id);
      }
      this.sql.exec(
        "UPDATE packs SET state = 'live', seq = ?, state_at = ? WHERE id = ?",
        run[0]!.seq,
        now,
        mergedId,
      );
      return true;
    });
    if (!switched) {
      this.sql.exec("DELETE FROM packs WHERE id = ?", mergedId);
      store.forget(mergedId);
      await store.deleteFiles(mergedId).catch(() => undefined);
      return false;
    }
    store.invalidate();
    return true;
  }

  /** Deletes everything: every file under the repository's prefix, then the tables. */
  async destroy(): Promise<{ deletedFiles: number }> {
    const store = this.store;
    let deletedFiles = 0;
    if (store) {
      let cursor: string | undefined;
      do {
        const page = await store.bucket.list({
          prefix: repoPrefix(store.repoId),
          limit: 1000,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        const keys = page.objects.map((object) => object.key);
        if (keys.length > 0) await store.bucket.delete(keys);
        deletedFiles += keys.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      store.clearCaches();
    }
    await this.deps.storage.deleteAlarm();
    await this.deps.storage.deleteAll();
    // The tables went with the data; the object may be asked to hold a new repository at once.
    migrate(this.deps.storage);
    this.store = null;
    return { deletedFiles };
  }

  // Forks

  /** What a fork copies: the live packs, and the branches and tags. */
  forkManifest(): ForkManifest {
    return {
      repoId: this.packs.repoId,
      head: this.head(),
      refs: this.sql
        .exec<{ name: string; oid: string; peeled: string | null }>(
          "SELECT name, oid, peeled FROM refs WHERE name LIKE 'refs/heads/%' OR name LIKE 'refs/tags/%' ORDER BY name",
        )
        .toArray(),
      packs: this.packs.rows("live").map((row) => ({
        id: row.id,
        checksum: row.checksum,
        size: row.size,
        idxSize: row.idx_size,
        objects: row.objects,
        selfContained: row.self_contained === 1,
      })),
    };
  }

  /**
   * Becomes a fork of another repository by copying its packs, R2 to R2.
   *
   * Copied, not shared. A fork that read its parent's packs would make every
   * repack and every delete of the parent depend on its forks (reference
   * counts across Durable Objects, with no transaction to keep them right),
   * and a parent's storage would be billed to whoever was forked from. A
   * copy costs storage and one pass of R2 traffic, and afterwards the two
   * repositories know nothing of each other.
   */
  async importFork(manifest: ForkManifest): Promise<void> {
    const store = this.packs;
    if (this.listRefs().length > 0 || store.rows("live").length > 0) {
      throw new Error("a fork must start empty");
    }
    const source = (id: string, extension: string): string =>
      `${repoPrefix(manifest.repoId)}packs/pack-${id}.${extension}`;
    const target = (id: string, extension: string): string =>
      `${repoPrefix(store.repoId)}packs/pack-${id}.${extension}`;
    const now = this.now();
    const copied: string[] = [];
    try {
      for (const pack of manifest.packs) {
        for (const extension of ["pack", "idx"]) {
          const object = await store.bucket.get(source(pack.id, extension));
          if (!object) throw new Error(`pack ${pack.id} of the parent is gone`);
          await store.bucket.put(target(pack.id, extension), object.body);
        }
        copied.push(pack.id);
      }
    } catch (error) {
      for (const id of copied) await store.deleteFiles(id).catch(() => undefined);
      throw error;
    }
    this.deps.storage.transactionSync(() => {
      manifest.packs.forEach((pack, index) => {
        this.sql.exec(
          "INSERT INTO packs (id, seq, state, checksum, size, idx_size, objects, self_contained, created_at, state_at) VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?)",
          pack.id,
          index + 1,
          pack.checksum,
          pack.size,
          pack.idxSize,
          pack.objects,
          pack.selfContained ? 1 : 0,
          now,
          now,
        );
      });
      for (const ref of manifest.refs) {
        this.sql.exec(
          "INSERT INTO refs (name, oid, peeled) VALUES (?, ?, ?)",
          ref.name,
          ref.oid,
          ref.peeled,
        );
      }
      setMeta(this.sql, "head", manifest.head);
      setMeta(this.sql, "ready", "1");
      // The packs come whole: whatever the parent held that its branches do not reach came too.
      this.changed(false);
    });
    store.invalidate();
    await this.scheduleMaintenance();
  }
}
