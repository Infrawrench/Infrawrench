/**
 * Walking history: which commits a fetch must send, where a shallow clone
 * stops, whether one commit descends from another, and every tree and blob
 * behind a set of commits.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  decodeLatin1,
  parseTag,
} from "@infrawrench/git-core";
import { OidSet, forEachTreeEntry } from "./oid-set";

export interface CommitNode {
  readonly tree: ObjectId;
  readonly parents: readonly ObjectId[];
  /** The committer's timestamp, seconds. 0 when the line cannot be read. */
  readonly time: number;
}

/**
 * Reads only what a walk needs from a commit. `parseCommit` builds the whole
 * object, signature and message included, and a negotiation reads thousands.
 */
export function parseCommitNode(data: Uint8Array): CommitNode {
  let end = 0;
  // The headers end at the first blank line.
  while (end < data.length && !(data[end] === 0x0a && data[end + 1] === 0x0a)) end++;
  const lines = decodeLatin1(data.subarray(0, end)).split("\n");
  let tree = "";
  let time = 0;
  const parents: ObjectId[] = [];
  for (const line of lines) {
    if (line.startsWith("tree ")) tree = line.slice(5, 45);
    else if (line.startsWith("parent ")) parents.push(line.slice(7, 47));
    else if (line.startsWith("committer ")) {
      const match = / (\d+) [+-]\d+$/.exec(line);
      if (match) time = Number(match[1]);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new GitError("bad-object", "commit has no tree");
  return { tree, parents, time };
}

/** Commits read once per request. */
export class CommitGraph {
  private readonly nodes = new Map<ObjectId, CommitNode | null>();
  /** How many commits have been read from storage. */
  reads = 0;

  constructor(readonly reader: ObjectReader) {}

  /** The commit, or null when the object is missing or is not a commit. */
  async get(oid: ObjectId): Promise<CommitNode | null> {
    const known = this.nodes.get(oid);
    if (known !== undefined) return known;
    const object = await this.reader.read(oid);
    this.reads++;
    const node = object && object.type === "commit" ? parseCommitNode(object.data) : null;
    this.nodes.set(oid, node);
    return node;
  }
}

/** A max-heap of commits by time, so a walk visits newest first. */
class DateQueue {
  private readonly oids: ObjectId[] = [];
  private readonly times: number[] = [];

  get size(): number {
    return this.oids.length;
  }

  push(oid: ObjectId, time: number): void {
    let at = this.oids.length;
    this.oids.push(oid);
    this.times.push(time);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.times[parent]! >= time) break;
      this.oids[at] = this.oids[parent]!;
      this.times[at] = this.times[parent]!;
      at = parent;
    }
    this.oids[at] = oid;
    this.times[at] = time;
  }

  pop(): ObjectId {
    const top = this.oids[0]!;
    const oid = this.oids.pop()!;
    const time = this.times.pop()!;
    const n = this.oids.length;
    if (n > 0) {
      let at = 0;
      for (;;) {
        let child = at * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && this.times[child + 1]! > this.times[child]!) child++;
        if (this.times[child]! <= time) break;
        this.oids[at] = this.oids[child]!;
        this.times[at] = this.times[child]!;
        at = child;
      }
      this.oids[at] = oid;
      this.times[at] = time;
    }
    return top;
  }
}

export interface PeeledWant {
  /** The tag objects passed through on the way, outermost first. */
  readonly tags: readonly ObjectId[];
  readonly oid: ObjectId;
  readonly type: "commit" | "tree" | "blob";
}

/** Follows tags from `oid` to what they finally name. Null when an object on the way is missing. */
export async function peelWant(reader: ObjectReader, oid: ObjectId): Promise<PeeledWant | null> {
  const tags: ObjectId[] = [];
  let current = oid;
  for (let depth = 0; depth < 32; depth++) {
    const object = await reader.read(current);
    if (!object) return null;
    if (object.type !== "tag") return { tags, oid: current, type: object.type };
    tags.push(current);
    current = parseTag(object.data).object;
  }
  throw new GitError("bad-object", `tag ${oid} is nested too deeply`);
}

export interface ShallowCut {
  /** Commits sent whose parents are not: the client records them as shallow. */
  readonly boundary: Set<ObjectId>;
  /** Every commit within the cut. */
  readonly included: Set<ObjectId>;
}

/**
 * `deepen <n>`: the commits within `depth` steps of `starts`, a start being
 * at depth 1. A commit at the limit that has parents is a boundary.
 */
export async function shallowByDepth(
  graph: CommitGraph,
  starts: readonly ObjectId[],
  depth: number,
): Promise<ShallowCut> {
  const included = new Set<ObjectId>();
  const boundary = new Set<ObjectId>();
  let level = [...new Set(starts)];
  // Breadth-first, so a commit reachable at several depths is placed at its least.
  for (let at = 1; level.length > 0; at++) {
    const next: ObjectId[] = [];
    for (const oid of level) {
      if (included.has(oid)) continue;
      const node = await graph.get(oid);
      if (!node) continue;
      included.add(oid);
      if (at >= depth) {
        if (node.parents.length > 0) boundary.add(oid);
      } else {
        for (const parent of node.parents) if (!included.has(parent)) next.push(parent);
      }
    }
    level = next;
  }
  return { boundary, included };
}

/**
 * `deepen-since` and `deepen-not`: the commits reachable from `starts` that
 * are no older than `since` and not in `excluded`. A commit with a parent
 * left out is a boundary.
 */
export async function shallowByRule(
  graph: CommitGraph,
  starts: readonly ObjectId[],
  since: number | null,
  excluded: ReadonlySet<ObjectId>,
): Promise<ShallowCut> {
  const included = new Set<ObjectId>();
  const boundary = new Set<ObjectId>();
  const keep = (oid: ObjectId, node: CommitNode): boolean =>
    !excluded.has(oid) && (since === null || node.time >= since);
  const stack = [...new Set(starts)];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (included.has(oid)) continue;
    const node = await graph.get(oid);
    if (!node || !keep(oid, node)) continue;
    included.add(oid);
    for (const parent of node.parents) {
      const parentNode = await graph.get(parent);
      if (parentNode && keep(parent, parentNode)) stack.push(parent);
      else boundary.add(oid);
    }
  }
  return { boundary, included };
}

/** Every commit reachable from `starts`. Used for `deepen-not`, whose argument is a ref. */
export async function ancestorsOf(
  graph: CommitGraph,
  starts: readonly ObjectId[],
): Promise<Set<ObjectId>> {
  const seen = new Set<ObjectId>();
  const stack = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const node = await graph.get(oid);
    if (!node) continue;
    seen.add(oid);
    stack.push(...node.parents);
  }
  return seen;
}

const WANT = 1;
const HAVE = 2;

export interface CommitSelection {
  /** Commits to send, newest first. */
  readonly commits: ObjectId[];
  /** Commits the client has that are parents of commits being sent. */
  readonly edges: ObjectId[];
}

/**
 * The commits reachable from `wants` and not from `haves`.
 *
 * Both sides are walked together, newest first, and the walk ends when
 * everything left to visit is already known to the client. Clocks that run
 * backwards can make it send a commit the client has; that costs bytes and
 * nothing else.
 *
 * `wantStops` are commits whose parents are not sent (a shallow boundary);
 * `haveStops` are the client's own shallow commits, whose parents it does
 * not have; `passThrough` are those of them this fetch unshallows, whose
 * parents are therefore sent although the client has the commit itself.
 */
export async function selectCommits(
  graph: CommitGraph,
  wants: readonly ObjectId[],
  haves: readonly ObjectId[],
  wantStops: ReadonlySet<ObjectId>,
  haveStops: ReadonlySet<ObjectId>,
  passThrough: ReadonlySet<ObjectId> = new Set(),
): Promise<CommitSelection> {
  const flags = new Map<ObjectId, number>();
  const queue = new DateQueue();
  const queued = new Set<ObjectId>();
  /** Commits whose parents have been told the client has them, and that they are wanted. */
  const toldHave = new Set<ObjectId>();
  const toldWant = new Set<ObjectId>();
  /** Queued commits that still have want-side work: the walk ends when there are none. */
  const open = new Set<ObjectId>();
  const wantSet = new Set(wants);

  // The want side goes on past a commit the client has only where the
  // client's copy is shallow and this fetch deepens beyond it.
  const wantWork = (oid: ObjectId, flag: number): boolean =>
    (flag & WANT) !== 0 && !toldWant.has(oid) && ((flag & HAVE) === 0 || passThrough.has(oid));
  const haveWork = (oid: ObjectId, flag: number): boolean =>
    (flag & HAVE) !== 0 && !toldHave.has(oid);
  const sync = (oid: ObjectId): void => {
    if (queued.has(oid) && wantWork(oid, flags.get(oid)!)) open.add(oid);
    else open.delete(oid);
  };
  const mark = async (oid: ObjectId, flag: number): Promise<void> => {
    const before = flags.get(oid) ?? 0;
    if ((before & flag) === flag) return;
    const node = await graph.get(oid);
    if (!node) {
      // A parent the repository does not have is the far side of its own shallow history.
      if (flag === WANT && wantSet.has(oid)) {
        throw new GitError("missing-object", `commit ${oid} is missing`);
      }
      return;
    }
    const now = before | flag;
    flags.set(oid, now);
    if (!queued.has(oid) && (wantWork(oid, now) || haveWork(oid, now))) {
      queued.add(oid);
      queue.push(oid, node.time);
    }
    sync(oid);
  };
  for (const oid of haves) await mark(oid, HAVE);
  for (const oid of wants) await mark(oid, WANT);
  // The client may be up to date above these, so nothing wanted would reach them.
  for (const oid of passThrough) await mark(oid, WANT);

  const commits: ObjectId[] = [];
  while (queue.size > 0 && open.size > 0) {
    const oid = queue.pop();
    queued.delete(oid);
    const flag = flags.get(oid)!;
    const node = (await graph.get(oid))!;
    const passWant = wantWork(oid, flag);
    if (haveWork(oid, flag)) {
      toldHave.add(oid);
      if (!haveStops.has(oid)) for (const parent of node.parents) await mark(parent, HAVE);
    }
    if (passWant) {
      toldWant.add(oid);
      if ((flag & HAVE) === 0) commits.push(oid);
      if (!wantStops.has(oid)) for (const parent of node.parents) await mark(parent, WANT);
    }
    sync(oid);
  }

  const edges: ObjectId[] = [];
  const edgeSeen = new Set<ObjectId>();
  const sent: ObjectId[] = [];
  for (const oid of commits) {
    // A commit visited as wanted before the have side reached it: the client has it after all.
    if (flags.get(oid)! & HAVE) {
      if (!edgeSeen.has(oid)) {
        edgeSeen.add(oid);
        edges.push(oid);
      }
      continue;
    }
    sent.push(oid);
    if (wantStops.has(oid)) continue;
    for (const parent of (await graph.get(oid))!.parents) {
      if ((flags.get(parent) ?? 0) & HAVE && !edgeSeen.has(parent)) {
        edgeSeen.add(parent);
        edges.push(parent);
      }
    }
  }
  return { commits: sent, edges };
}

/**
 * Whether `ancestor` is reachable from `descendant`. Walks newest first and
 * gives up on anything older than the ancestor by more than a month, the
 * allowance for clocks that disagree.
 */
export async function isAncestor(
  graph: CommitGraph,
  ancestor: ObjectId,
  descendant: ObjectId,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const target = await graph.get(ancestor);
  if (!target) return false;
  const floor = target.time - 30 * 86400;
  const seen = new Set<ObjectId>([descendant]);
  const queue = new DateQueue();
  const start = await graph.get(descendant);
  if (!start) return false;
  queue.push(descendant, start.time);
  while (queue.size > 0) {
    const oid = queue.pop();
    const node = (await graph.get(oid))!;
    for (const parent of node.parents) {
      if (parent === ancestor) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      const parentNode = await graph.get(parent);
      if (parentNode && parentNode.time >= floor) queue.push(parent, parentNode.time);
    }
  }
  return false;
}

/** Whether the commit `target` is reachable from any of `tips`. */
export async function reachableFromAny(
  graph: CommitGraph,
  tips: readonly ObjectId[],
  target: ObjectId,
): Promise<boolean> {
  return (await reachableAmong(graph, tips, [target])).has(target);
}

/**
 * Which of the commits `targets` are reachable from `tips`, in one walk for
 * all of them. It goes newest first and gives up below the oldest target's
 * date less a month, the allowance for clocks that disagree, so a target it
 * misses is only ever refused, never wrongly let through. One walk rather
 * than one per target: a request can name thousands.
 */
export async function reachableAmong(
  graph: CommitGraph,
  tips: readonly ObjectId[],
  targets: readonly ObjectId[],
): Promise<Set<ObjectId>> {
  const found = new Set<ObjectId>();
  const wanted = new Set<ObjectId>();
  let floor = Infinity;
  for (const target of new Set(targets)) {
    const node = await graph.get(target);
    if (!node) continue;
    wanted.add(target);
    floor = Math.min(floor, node.time - 30 * 86400);
  }
  if (wanted.size === 0) return found;
  const seen = new Set<ObjectId>();
  const queue = new DateQueue();
  const reach = async (oid: ObjectId): Promise<void> => {
    if (seen.has(oid)) return;
    seen.add(oid);
    if (wanted.has(oid)) found.add(oid);
    const node = await graph.get(oid);
    if (node && node.time >= floor) queue.push(oid, node.time);
  };
  for (const tip of tips) await reach(tip);
  while (queue.size > 0 && found.size < wanted.size) {
    const node = (await graph.get(queue.pop()))!;
    for (const parent of node.parents) await reach(parent);
  }
  return found;
}

/**
 * Whether every want already has an ancestor among the commits both sides
 * have, which is when more `have` lines stop making the pack smaller. Looks
 * at no more than `budget` commits; running out counts as yes, so a
 * negotiation is always bounded.
 */
export async function wantsCovered(
  graph: CommitGraph,
  wants: readonly ObjectId[],
  common: ReadonlySet<ObjectId>,
  budget: number | { left: number },
): Promise<boolean> {
  // An object is a budget shared with the caller, which then sees what was spent.
  const counter = typeof budget === "number" ? { left: budget } : budget;
  if (common.size === 0) return false;
  let oldest = Infinity;
  for (const oid of common) {
    const node = await graph.get(oid);
    if (node) oldest = Math.min(oldest, node.time);
  }
  const cleared = new Set<ObjectId>();
  for (const want of wants) {
    const seen = new Set<ObjectId>([want]);
    const stack = [want];
    let found = false;
    while (stack.length > 0 && !found) {
      const oid = stack.pop()!;
      if (common.has(oid) || cleared.has(oid)) {
        found = true;
        break;
      }
      if (counter.left-- <= 0) return true;
      const node = await graph.get(oid);
      // Not a commit (a tag's blob, say): nothing a have could cover.
      if (!node) continue;
      if (node.time < oldest) continue;
      for (const parent of node.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    if (!found) return false;
    cleared.add(want);
  }
  return true;
}

/** How many of a shallow client's commits are looked at for what it already has. */
const MAX_SHALLOW_EDGES = 32;

/**
 * The edges of a fetch into a shallow clone: `edges`, and the newest of the
 * commits the client said it has.
 *
 * An edge is normally a commit the client has that is a parent of one being
 * sent, and its trees and blobs are left out of the pack. A shallow fetch
 * stops at its boundary, so the walk never looks at the parents of what it
 * sends and finds no edge at all: a client that has yesterday's commit and
 * asks for today's at depth 1 was sent every file again, where it needed
 * the handful that changed. Git answers this the same way (`rev-list
 * --objects-edge-aggressive`, which upload-pack passes for a shallow
 * client): every commit the client names counts, parent or not. A client
 * has the whole tree of any commit it has, shallow or not, so this only
 * ever leaves out objects it holds.
 */
export async function shallowEdges(
  graph: CommitGraph,
  edges: readonly ObjectId[],
  haves: readonly ObjectId[],
): Promise<ObjectId[]> {
  const seen = new Set(edges);
  const dated: Array<{ readonly oid: ObjectId; readonly time: number }> = [];
  for (const oid of haves) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    const node = await graph.get(oid);
    if (node) dated.push({ oid, time: node.time });
  }
  // Newest first: the nearest thing to what is being sent shares the most with it.
  dated.sort((a, b) => b.time - a.time);
  return [...edges, ...dated.slice(0, MAX_SHALLOW_EDGES).map((each) => each.oid)];
}

export interface ObjectSelection {
  /** Everything to send, commits first. */
  readonly objects: OidSet;
  /** Trees and blobs of the edge commits: what the client certainly has. */
  readonly have: OidSet;
}

/**
 * Trees read at once while a tree is walked. Storage answers each read with
 * a round trip to an object store, so a walk that waits for one tree before
 * asking for the next takes as many round trips as there are trees: a
 * monorepo has thousands under one commit. The order trees are visited in
 * changes nothing about what is selected.
 */
const TREES_AT_ONCE = 32;

/** Takes the next batch off the stack and reads it: null where an object is missing. */
async function readBatch(
  reader: ObjectReader,
  stack: ObjectId[],
): Promise<Array<{ readonly oid: ObjectId; readonly object: GitObject | null }>> {
  const batch = stack.splice(Math.max(0, stack.length - TREES_AT_ONCE));
  const objects = await Promise.all(batch.map((oid) => reader.read(oid)));
  return batch.map((oid, index) => ({ oid, object: objects[index]! }));
}

/** Marks a tree and everything under it. */
async function markTree(reader: ObjectReader, root: ObjectId, into: OidSet): Promise<void> {
  if (!into.add(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    for (const { object } of await readBatch(reader, stack)) {
      // An edge commit's tree may be past the repository's own shallow point.
      if (!object || object.type !== "tree") continue;
      const subtrees: number[] = [];
      forEachTreeEntry(object.data, (isTree, source, at) => {
        if (into.addBytes(source, at) && isTree) subtrees.push(into.size - 1);
      });
      for (const index of subtrees) stack.push(into.list.hexAt(index));
    }
  }
}

/** Adds a tree and everything under it that the client lacks. */
async function addTree(
  reader: ObjectReader,
  root: ObjectId,
  objects: OidSet,
  have: OidSet,
): Promise<void> {
  if (have.has(root) || !objects.add(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    for (const { oid, object } of await readBatch(reader, stack)) {
      if (!object) throw new GitError("missing-object", `tree ${oid} is missing`);
      if (object.type !== "tree") throw new GitError("bad-object", `${oid} is not a tree`);
      const subtrees: number[] = [];
      forEachTreeEntry(object.data, (isTree, source, at) => {
        if (have.hasBytes(source, at)) return;
        if (objects.addBytes(source, at) && isTree) subtrees.push(objects.size - 1);
      });
      for (const index of subtrees) stack.push(objects.list.hexAt(index));
    }
  }
}

export interface SelectObjectsInput {
  readonly commits: readonly ObjectId[];
  readonly edges: readonly ObjectId[];
  /** Tag objects to send as they are. */
  readonly tags: readonly ObjectId[];
  /** Trees wanted directly (a tag of a tree). */
  readonly trees: readonly ObjectId[];
  /** Blobs wanted directly. */
  readonly blobs: readonly ObjectId[];
  /** Called now and then with the number of objects found so far. */
  readonly onProgress?: (count: number) => void;
}

/** Every object behind a selection of commits, less what the edges show the client has. */
export async function selectObjects(
  graph: CommitGraph,
  input: SelectObjectsInput,
): Promise<ObjectSelection> {
  const reader = graph.reader;
  const have = new OidSet();
  for (const edge of input.edges) {
    const node = await graph.get(edge);
    if (node) await markTree(reader, node.tree, have);
  }
  const objects = new OidSet(input.commits.length * 4);
  for (const oid of input.tags) objects.add(oid);
  for (const oid of input.commits) objects.add(oid);
  let reported = 0;
  for (const oid of input.commits) {
    const node = (await graph.get(oid))!;
    await addTree(reader, node.tree, objects, have);
    if (input.onProgress && objects.size - reported >= 5000) {
      reported = objects.size;
      input.onProgress(reported);
    }
  }
  for (const oid of input.trees) await addTree(reader, oid, objects, have);
  for (const oid of input.blobs) if (!have.has(oid)) objects.add(oid);
  return { objects, have };
}
