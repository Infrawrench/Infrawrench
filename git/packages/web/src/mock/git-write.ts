/**
 * Writing to a mock repository: what merging a pull request and updating its
 * branch need. A three-way merge by path (a file both sides changed is a
 * conflict; the mock never merges inside a file) and a commit of the result.
 */
import type { Signature, UserRef } from "@infrawrench/git-contract";
import { commitOf, flatten, mergeBase, type GitFixture } from "./git";

type Flat = Map<string, [string, string]>;

export interface TreeMerge {
  readonly files: Flat;
  readonly conflicts: string[];
}

const same = (a: [string, string] | undefined, b: [string, string] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1]);

/** `theirs` merged into `ours`, by path, against their merge base. */
export function mergeCommits(fx: GitFixture, ours: string, theirs: string): TreeMerge {
  const baseOid = mergeBase(fx, ours, theirs);
  const base: Flat = baseOid === null ? new Map() : flatten(fx, baseOid);
  const a: Flat = flatten(fx, ours);
  const b: Flat = flatten(fx, theirs);
  const files: Flat = new Map();
  const conflicts: string[] = [];
  for (const path of new Set([...base.keys(), ...a.keys(), ...b.keys()])) {
    const [o, x, y] = [base.get(path), a.get(path), b.get(path)];
    let pick: [string, string] | undefined;
    if (same(x, y)) pick = x;
    else if (same(o, x)) pick = y;
    else if (same(o, y)) pick = x;
    else {
      conflicts.push(path);
      pick = x;
    }
    if (pick !== undefined) files.set(path, pick);
  }
  return { files, conflicts: conflicts.sort() };
}

let counter = 0;
/** An object id that is not a hash of anything: the mock only needs it unique. */
export function fakeOid(): string {
  counter++;
  const tail = counter.toString(16).padStart(8, "0");
  let head = "";
  let seed = counter * 2654435761;
  while (head.length < 32) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    head += seed.toString(16).padStart(8, "0");
  }
  return head.slice(0, 32) + tail;
}

function writeTree(fx: GitFixture, files: Flat): string {
  const entries: Array<[string, string, string]> = [];
  const folders = new Map<string, Flat>();
  for (const [path, entry] of files) {
    const slash = path.indexOf("/");
    if (slash < 0) entries.push([entry[0], entry[1], path]);
    else {
      const name = path.slice(0, slash);
      let inner = folders.get(name);
      if (!inner) folders.set(name, (inner = new Map()));
      inner.set(path.slice(slash + 1), entry);
    }
  }
  for (const [name, inner] of folders) entries.push(["040000", writeTree(fx, inner), name]);
  entries.sort((x, y) => x[2].localeCompare(y[2]));
  const oid = fakeOid();
  fx.trees[oid] = entries;
  return oid;
}

const signature = (who: UserRef): Signature => ({
  name: who.displayName ?? who.username ?? "Someone",
  email: `${who.username ?? "someone"}@acme.example`,
  when: new Date().toISOString(),
  timezoneOffset: 0,
});

/** A new commit of `files` on top of `parents`; its changes are against the first parent. */
export function writeCommit(
  fx: GitFixture,
  files: Flat,
  parents: string[],
  message: string,
  who: UserRef,
): string {
  const oid = fakeOid();
  const before: Flat = parents[0] === undefined ? new Map() : flatten(fx, parents[0]);
  const changes = [];
  for (const path of new Set([...before.keys(), ...files.keys()])) {
    const [was, now] = [before.get(path), files.get(path)];
    if (same(was, now)) continue;
    changes.push({
      status: was === undefined ? "A" : now === undefined ? "D" : "M",
      path,
      oldPath: null,
      similarity: null,
      oldMode: was?.[0] ?? null,
      newMode: now?.[0] ?? null,
      oldOid: was?.[1] ?? null,
      newOid: now?.[1] ?? null,
    });
  }
  changes.sort((x, y) => x.path.localeCompare(y.path));
  const by = signature(who);
  fx.commits[oid] = {
    oid,
    tree: writeTree(fx, files),
    parents,
    author: by,
    committer: by,
    message,
    changes,
  };
  fx.order.unshift(oid);
  return oid;
}

/** The files of a commit, for a commit that reuses another's tree. */
export const filesOf = (fx: GitFixture, oid: string): Flat => flatten(fx, commitOf(fx, oid).oid);
