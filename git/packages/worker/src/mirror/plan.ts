/**
 * What a push mirror's run has to do: the target's refs compared with this
 * repository's, as pushes in the order to make them.
 *
 * It runs in the repository's Durable Object, beside the commit graph: the
 * decisions need ancestry (is this a fast-forward) and how much history a
 * ref would bring, and a walk in the Worker would be a call an object.
 * Pure over a `CommitGraph`, so the tests run it in Node.
 *
 * **Stages.** A run is one push when there is little to send. A branch that
 * would bring more than `stepCommits` commits is pushed in parts instead,
 * oldest first, each part a commit further along its first-parent line and
 * each its own push to that branch, the way a person brings a long history
 * to a host that limits one push (the docs' "Push a long history"). The
 * target is left at a real commit of the branch after every part, so a run
 * that stops halfway is carried on by the next from where it got to.
 *
 * **Tags go a few at a time.** Some hosts tell nobody about tags that
 * arrive more than three in one push (GitHub creates no event for them, so
 * a release workflow would not start), hence `maxTagsPerPush`.
 */
import type { ObjectId, Ref } from "@infrawrench/git-core";
import { type CommitGraph, isAncestor, peelWant, selectCommits } from "@infrawrench/git-protocol";
import { excluder, isMirroredNamespace } from "./refs";

export interface MirrorPlanOptions {
  /** The target's refs, as its advertisement gave them. */
  readonly remote: ReadonlyArray<{ readonly name: string; readonly oid: ObjectId }>;
  /** Ref patterns left alone on both sides. */
  readonly exclude: readonly string[];
  /** Overwrite and delete on the target. Off: only create and fast-forward. */
  readonly force: boolean;
  /** A branch that would bring more commits than this goes in parts of about this many. */
  readonly stepCommits: number;
  readonly maxTagsPerPush: number;
  readonly maxRefsPerPush: number;
}

export const DEFAULT_MIRROR_PLAN = {
  stepCommits: 2000,
  maxTagsPerPush: 3,
  maxRefsPerPush: 500,
} as const;

export interface MirrorUpdate {
  readonly name: string;
  /** What the ref becomes on the target. */
  readonly oid: ObjectId;
  /** False for a part on the way to a branch's head: the ref is not yet what it is here. */
  readonly final: boolean;
}

export interface MirrorPlan {
  /** Refs to delete from the target, in one push before anything else. */
  readonly deletes: readonly string[];
  /** Pushes to make, in order. */
  readonly stages: ReadonlyArray<{ readonly updates: readonly MirrorUpdate[] }>;
  /** Refs that differ and are left alone, with why. */
  readonly skipped: ReadonlyArray<{ readonly ref: string; readonly reason: string }>;
  /** Objects the target showed that this repository has too: what a pack may leave out. */
  readonly haves: readonly ObjectId[];
  /** Branches and tags compared. */
  readonly refs: number;
}

export interface MirrorPlanInput {
  readonly graph: CommitGraph;
  /** This repository's refs, all of them. */
  readonly refs: readonly Ref[];
  /** `HEAD`'s branch (`refs/heads/main`), pushed first. */
  readonly head: string;
  /** Whether an object is stored here. */
  readonly has: (oid: ObjectId) => boolean;
}

/** The most of the target's objects offered as "already there". */
const MAX_HAVES = 5000;

const NONE: ReadonlySet<ObjectId> = new Set();

export async function planMirror(
  input: MirrorPlanInput,
  options: MirrorPlanOptions,
): Promise<MirrorPlan> {
  const { graph } = input;
  const excluded = excluder(options.exclude);
  const carried = (name: string): boolean => isMirroredNamespace(name) && !excluded(name);

  const local = input.refs.filter((ref) => carried(ref.name));
  const localNames = new Set(local.map((ref) => ref.name));
  const remote = new Map<string, ObjectId>();
  for (const ref of options.remote) remote.set(ref.name, ref.oid);

  // What the target has that is also here, as commits a walk can stop at.
  const haves: ObjectId[] = [];
  const haveCommits: ObjectId[] = [];
  const seenHave = new Set<ObjectId>();
  for (const ref of options.remote) {
    if (haves.length >= MAX_HAVES) break;
    if (seenHave.has(ref.oid) || !input.has(ref.oid)) continue;
    seenHave.add(ref.oid);
    haves.push(ref.oid);
    const peeled = await peelWant(graph.reader, ref.oid);
    if (peeled?.type === "commit") haveCommits.push(peeled.oid);
  }

  const skipped: Array<{ ref: string; reason: string }> = [];
  const deletes: string[] = [];
  for (const [name] of remote) {
    if (!carried(name) || localNames.has(name)) continue;
    if (options.force) deletes.push(name);
    else skipped.push({ ref: name, reason: "only on the target, and the mirror does not delete" });
  }
  deletes.sort();

  // HEAD's branch first (it is what most other refs hang off), then branches, then tags.
  const rank = (name: string): number =>
    name === input.head ? 0 : name.startsWith("refs/heads/") ? 1 : 2;
  const ordered = [...local].sort(
    (a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const stages: Array<{ updates: MirrorUpdate[] }> = [];
  let batch: MirrorUpdate[] = [];
  let batchCommits = 0;
  let batchTags = 0;
  const flush = (): void => {
    if (batch.length > 0) stages.push({ updates: batch });
    batch = [];
    batchCommits = 0;
    batchTags = 0;
  };

  for (const ref of ordered) {
    const there = remote.get(ref.name);
    if (there === ref.oid) continue;
    const isTag = ref.name.startsWith("refs/tags/");
    const peeled = await peelWant(graph.reader, ref.oid);
    if (peeled === null) {
      skipped.push({ ref: ref.name, reason: "its object is missing here" });
      continue;
    }
    if (there !== undefined && !options.force) {
      const thereCommit = input.has(there) ? await peelWant(graph.reader, there) : null;
      const forward =
        !isTag &&
        peeled.type === "commit" &&
        thereCommit?.type === "commit" &&
        (await isAncestor(graph, thereCommit.oid, peeled.oid));
      if (!forward) {
        skipped.push({
          ref: ref.name,
          reason: isTag
            ? "the tag differs on the target, and the mirror does not overwrite"
            : "the target has commits this branch does not, and the mirror does not overwrite",
        });
        continue;
      }
    }

    let bringing = 0;
    let parts: ObjectId[] = [];
    if (peeled.type === "commit") {
      const selection = await selectCommits(graph, [peeled.oid], haveCommits, NONE, NONE);
      bringing = selection.commits.length;
      if (!isTag && bringing > options.stepCommits) {
        parts = await partsAlong(graph, peeled.oid, selection.commits, options.stepCommits);
      }
      haveCommits.push(peeled.oid);
    }

    if (parts.length > 0) {
      flush();
      for (const oid of parts) stages.push({ updates: [{ name: ref.name, oid, final: false }] });
      stages.push({ updates: [{ name: ref.name, oid: ref.oid, final: true }] });
      continue;
    }
    if (
      batch.length >= options.maxRefsPerPush ||
      (isTag && batchTags >= options.maxTagsPerPush) ||
      (batch.length > 0 && batchCommits + bringing > options.stepCommits)
    ) {
      flush();
    }
    batch.push({ name: ref.name, oid: ref.oid, final: true });
    batchCommits += bringing;
    if (isTag) batchTags++;
  }
  flush();

  return { deletes, stages, skipped, haves, refs: local.length };
}

/**
 * Commits to stop at on the way to `tip`, oldest first: points along its
 * first-parent line that cut what it brings into parts of about
 * `stepCommits`. The line is the branch's own history, so each part is a
 * commit the branch really was at.
 */
async function partsAlong(
  graph: CommitGraph,
  tip: ObjectId,
  bringing: readonly ObjectId[],
  stepCommits: number,
): Promise<ObjectId[]> {
  const sent = new Set(bringing);
  const line: ObjectId[] = [];
  for (let at: ObjectId | undefined = tip; at !== undefined && sent.has(at);) {
    line.push(at);
    at = (await graph.get(at))?.parents[0];
  }
  const pieces = Math.ceil(bringing.length / stepCommits);
  const parts: ObjectId[] = [];
  for (let piece = 1; piece < pieces; piece++) {
    // `line` is newest first: the oldest part is the furthest along it.
    const index = line.length - 1 - Math.floor((piece * (line.length - 1)) / pieces);
    const oid = line[index];
    if (oid !== undefined && oid !== tip && parts[parts.length - 1] !== oid) parts.push(oid);
  }
  return parts;
}
