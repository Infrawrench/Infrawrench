/**
 * What the reader keeps between requests, for as long as the Durable Object
 * is awake: the commit graph, sizes, and the answers that cost a history
 * walk. All of it can be thrown away at any time. Two answers are also
 * written down (`reader_cache`, `do/schema.ts`), because working them out
 * walks the whole history and they are on a repository's front page: the
 * file table's "last commit" column, and how many commits a ref reaches.
 */
import type { ObjectId } from "@infrawrench/git-core";
import type { CommitGraphSource, CommitNode, LastCommitsContinuation } from "@infrawrench/git-ops";
import type { Sql } from "../do/platform";

/** A small least-recently-used map. */
export class Lru<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Parents, tree and commit time of every commit a walk has visited. About
 * 200 bytes a commit, so the cap is some 40 MB of a Durable Object's 128;
 * past it the older half goes.
 */
class GraphCache implements CommitGraphSource {
  private readonly nodes = new Map<ObjectId, CommitNode>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.nodes.size;
  }

  get(oid: ObjectId): CommitNode | undefined {
    return this.nodes.get(oid);
  }

  set(node: CommitNode): void {
    if (this.nodes.size >= this.max) {
      let drop = this.nodes.size >> 1;
      for (const key of this.nodes.keys()) {
        if (drop-- <= 0) break;
        this.nodes.delete(key);
      }
    }
    this.nodes.set(node.oid, node);
  }

  clear(): void {
    this.nodes.clear();
  }
}

/** A walk for one directory at one commit: what is settled, and where to carry on. */
export interface LastCommitsProgress {
  readonly resolved: Map<string, ObjectId>;
  /** Absent once every name is settled. */
  continuation?: LastCommitsContinuation;
}

/** Rows of `reader_cache` kept per repository; the oldest go first. */
const CACHE_ROWS = 128;

const walkKey = (commit: ObjectId, path: string): string => `${commit}\0${path}`;

export class ReaderState {
  readonly graph = new GraphCache(200_000);
  /** Object sizes: a blob's never changes. */
  readonly sizes = new Lru<number>(50_000);
  /** Whatever else is worth keeping, by a key that names its inputs' ids. */
  readonly memo = new Lru<unknown>(256);
  /** Changed-file lists with their counts: few, because one can be thousands of entries. */
  readonly diffs = new Lru<unknown>(8);
  /** Terraform snapshots by tree: very few, because one can hold megabytes of text. */
  readonly terraform = new Lru<unknown>(4);
  private readonly walks = new Lru<LastCommitsProgress>(128);
  /** Per directory: the commits `reader_cache` has a finished answer for. */
  private readonly finished = new Lru<Set<ObjectId>>(128);

  /** Calls `compute` unless the answer for `key` is still here. */
  async remember<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const known = this.memo.get(key);
    if (known !== undefined) return known as T;
    const made = await compute();
    this.memo.set(key, made);
    return made;
  }

  /** The walk in flight (or finished) for a directory at a commit. */
  walk(commit: ObjectId, path: string): LastCommitsProgress | undefined {
    return this.walks.get(walkKey(commit, path));
  }

  setWalk(commit: ObjectId, path: string, progress: LastCommitsProgress): void {
    this.walks.set(walkKey(commit, path), progress);
  }

  /** A finished answer for a directory at exactly this commit, from memory or the table. */
  answers(sql: Sql, commit: ObjectId, path: string): Map<string, ObjectId> | undefined {
    const walk = this.walks.get(walkKey(commit, path));
    if (walk && !walk.continuation) return walk.resolved;
    if (!this.stored(sql, path).has(commit)) return undefined;
    const value = this.load(sql, "last", path, commit);
    if (value === undefined) return undefined;
    const resolved = new Map(Object.entries(value as Record<string, ObjectId>));
    this.walks.set(walkKey(commit, path), { resolved });
    return resolved;
  }

  private stored(sql: Sql, path: string): Set<ObjectId> {
    let known = this.finished.get(path);
    if (!known) {
      known = new Set(
        sql
          .exec<{
            commit_oid: string;
          }>("SELECT commit_oid FROM reader_cache WHERE kind = 'last' AND key = ?", path)
          .toArray()
          .map((row) => row.commit_oid),
      );
      this.finished.set(path, known);
    }
    return known;
  }

  /** Writes a finished walk down. */
  saveAnswers(
    sql: Sql,
    commit: ObjectId,
    path: string,
    resolved: Map<string, ObjectId>,
    now: number,
  ): void {
    if (this.stored(sql, path).has(commit)) return;
    this.save(sql, "last", path, commit, Object.fromEntries(resolved), now);
    this.stored(sql, path).add(commit);
  }

  /** The newest commit counts written down, newest first: `[commit, count]`. */
  counts(sql: Sql): Array<readonly [ObjectId, number]> {
    return sql
      .exec<{
        commit_oid: string;
        value: string;
      }>("SELECT commit_oid, value FROM reader_cache WHERE kind = 'count' ORDER BY at DESC LIMIT 8")
      .toArray()
      .map((row) => [row.commit_oid, Number(row.value)] as const);
  }

  saveCount(sql: Sql, commit: ObjectId, count: number, now: number): void {
    this.save(sql, "count", "", commit, count, now);
  }

  private load(sql: Sql, kind: string, key: string, commit: ObjectId): unknown {
    const [row] = sql
      .exec<{
        value: string;
      }>(
        "SELECT value FROM reader_cache WHERE kind = ? AND key = ? AND commit_oid = ?",
        kind,
        key,
        commit,
      )
      .toArray();
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }

  /** One row, and the oldest rows dropped past the cap. */
  private save(
    sql: Sql,
    kind: string,
    key: string,
    commit: ObjectId,
    value: unknown,
    now: number,
  ): void {
    sql.exec(
      "INSERT INTO reader_cache (kind, key, commit_oid, value, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key, commit_oid) DO UPDATE SET value = excluded.value, at = excluded.at",
      kind,
      key,
      commit,
      JSON.stringify(value),
      now,
    );
    const [count] = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM reader_cache").toArray();
    const over = (count?.n ?? 0) - CACHE_ROWS;
    if (over <= 0) return;
    sql.exec(
      "DELETE FROM reader_cache WHERE (kind, key, commit_oid) IN (SELECT kind, key, commit_oid FROM reader_cache ORDER BY at ASC LIMIT ?)",
      over,
    );
    this.finished.clear();
  }

  /** Everything, after the repository is destroyed. */
  clear(): void {
    this.graph.clear();
    this.sizes.clear();
    this.memo.clear();
    this.diffs.clear();
    this.walks.clear();
    this.finished.clear();
  }
}
