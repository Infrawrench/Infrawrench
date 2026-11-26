/** Branches, tags and the ref changes the forge makes itself. */
import type { GitTag } from "@infrawrench/git-contract";
import {
  GitError,
  type ObjectId,
  type Ref,
  ZERO_OID,
  isValidRefName,
  parseTag,
} from "@infrawrench/git-core";
import { aheadBehind } from "@infrawrench/git-ops";
import type { GitEventActor } from "../../env";
import {
  type ListBranchesInput,
  type PageInput,
  type ReaderBranch,
  type ReaderPage,
  type ReaderRefs,
  RepoReaderError,
} from "../reader";
import {
  BRANCH,
  type ReaderContext,
  type Session,
  TAG,
  branchTip,
  commitOf,
  offsetOf,
  openSession,
  resolve,
  signatureOf,
  summaries,
  summaryOf,
} from "./session";

const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const contains = (name: string, q: string | undefined): boolean =>
  q === undefined || q === "" || name.toLowerCase().includes(q.toLowerCase());

/** Commit time of each ref's commit, 0 for one that leads to no commit. */
async function commitTimes(session: Session, refs: readonly Ref[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const ref of refs) {
    const commit = await commitOf(session, ref.peeled ?? ref.oid);
    times.set(ref.name, commit ? (await session.cache.node(commit)).time : 0);
  }
  return times;
}

/** The default branch first, then newest commit first; by name when there are too many to date. */
async function ordered(session: Session, refs: readonly Ref[]): Promise<Ref[]> {
  const byName = (a: Ref, b: Ref): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const first = (ref: Ref): number => (ref.name === session.head ? 0 : 1);
  if (refs.length > session.cx.limits.sortRefs) {
    return [...refs].sort((a, b) => first(a) - first(b) || byName(a, b));
  }
  const times = await commitTimes(session, refs);
  return [...refs].sort(
    (a, b) => first(a) - first(b) || times.get(b.name)! - times.get(a.name)! || byName(a, b),
  );
}

export async function listRefs(
  cx: ReaderContext,
  input: { readonly q?: string | undefined; readonly limit: number },
): Promise<ReaderRefs> {
  const session = await openSession(cx);
  const pick = async (prefix: string) => {
    const matching = session.refs.filter(
      (ref) => ref.name.startsWith(prefix) && contains(ref.name.slice(prefix.length), input.q),
    );
    const sorted = await ordered(session, matching);
    return {
      items: sorted.slice(0, input.limit).map((ref) => ({
        name: ref.name.slice(prefix.length),
        oid: ref.peeled ?? ref.oid,
      })),
      truncated: sorted.length > input.limit,
    };
  };
  const [branches, tags] = [await pick(BRANCH), await pick(TAG)];
  return {
    branches: branches.items,
    tags: tags.items,
    branchesTruncated: branches.truncated,
    tagsTruncated: tags.truncated,
  };
}

async function branchShape(session: Session, ref: Ref): Promise<ReaderBranch> {
  const name = ref.name.slice(BRANCH.length);
  const commit = summaryOf(ref.oid, await session.cache.commit(ref.oid));
  const defaultTip = session.refs.find((each) => each.name === session.head)?.oid;
  if (ref.name === session.head || defaultTip === undefined) {
    return { name, commit, ahead: null, behind: null };
  }
  try {
    const { ahead, behind } = await aheadBehind(session.cache, ref.oid, defaultTip);
    return { name, commit, ahead, behind };
  } catch (error) {
    // A history too large to walk within the bound: the branch is still listed.
    if (error instanceof GitError && error.code === "limit") {
      return { name, commit, ahead: 0, behind: 0 };
    }
    throw error;
  }
}

export async function listBranches(
  cx: ReaderContext,
  input: ListBranchesInput,
): Promise<ReaderPage<ReaderBranch>> {
  const session = await openSession(cx);
  let refs = await ordered(
    session,
    session.refs.filter(
      (ref) => ref.name.startsWith(BRANCH) && contains(ref.name.slice(BRANCH.length), input.q),
    ),
  );
  const view = input.view ?? "all";
  if (view === "active" || view === "stale") {
    const cutoff = Math.floor((cx.now() - STALE_AFTER_MS) / 1000);
    const times = await commitTimes(session, refs);
    refs = refs.filter((ref) => times.get(ref.name)! >= cutoff === (view === "active"));
  } else if (view === "mine") {
    const emails = new Set((input.authorEmails ?? []).map((email) => email.toLowerCase()));
    const mine: Ref[] = [];
    for (const ref of refs) {
      const commit = await session.cache.commit(ref.oid);
      if (emails.has(commit.author.email.toLowerCase())) mine.push(ref);
    }
    refs = mine;
  }
  const offset = offsetOf(input.cursor);
  const page = refs.slice(offset, offset + input.limit);
  const items: ReaderBranch[] = [];
  for (const ref of page) items.push(await branchShape(session, ref));
  return {
    items,
    nextCursor: offset + input.limit < refs.length ? String(offset + input.limit) : null,
  };
}

export async function getBranch(cx: ReaderContext, name: string): Promise<ReaderBranch | null> {
  const session = await openSession(cx);
  const ref = session.refs.find((each) => each.name === BRANCH + name);
  return ref ? branchShape(session, ref) : null;
}

interface TagOrder {
  readonly name: string;
  readonly time: number;
}

export async function listTags(
  cx: ReaderContext,
  input: PageInput & { readonly q?: string | undefined },
): Promise<ReaderPage<GitTag>> {
  const session = await openSession(cx);
  const tags = session.refs.filter((ref) => ref.name.startsWith(TAG));
  const byName = new Map(tags.map((ref) => [ref.name, ref]));

  /** The annotated tag's own date when it has one, else its commit's. */
  const dateOf = async (ref: Ref): Promise<number> => {
    if (ref.peeled !== undefined) {
      const object = await session.cache.read(ref.oid);
      if (object?.type === "tag") {
        const tagger = parseTag(object.data).tagger;
        if (tagger) return tagger.timestamp;
      }
    }
    const commit = await commitOf(session, ref.peeled ?? ref.oid);
    return commit ? (await session.cache.node(commit)).time : 0;
  };
  // Sorting reads every tag once; the order is kept until a tag changes.
  let signature = 0;
  for (const ref of tags) {
    for (let i = 0; i < 8; i++) signature = (signature * 31 + ref.oid.charCodeAt(i)) | 0;
    signature = (signature * 31 + ref.name.length) | 0;
  }
  const order = await cx.state.remember<TagOrder[]>(
    `tags:${tags.length}:${signature}`,
    async () => {
      const dated: TagOrder[] = [];
      if (tags.length > cx.limits.sortRefs * 5) {
        // Too many to read: by name, newest-looking first.
        return tags.map((ref) => ({ name: ref.name, time: 0 })).reverse();
      }
      for (const ref of tags) dated.push({ name: ref.name, time: await dateOf(ref) });
      return dated.sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
    },
  );

  const matching = order.filter(
    (tag) => byName.has(tag.name) && contains(tag.name.slice(TAG.length), input.q),
  );
  const offset = offsetOf(input.cursor);
  const items: GitTag[] = [];
  for (const { name } of matching.slice(offset, offset + input.limit)) {
    const ref = byName.get(name)!;
    const object = ref.peeled !== undefined ? await session.cache.read(ref.oid) : null;
    const tag = object?.type === "tag" ? parseTag(object.data) : null;
    const commit = await commitOf(session, ref.peeled ?? ref.oid);
    items.push({
      name: name.slice(TAG.length),
      oid: ref.oid,
      annotated: tag !== null,
      tagger: tag?.tagger ? signatureOf(tag.tagger) : null,
      message: tag ? tag.message : null,
      commit: commit ? ((await summaries(session, [commit])).get(commit) ?? null) : null,
    });
  }
  return {
    items,
    nextCursor: offset + input.limit < matching.length ? String(offset + input.limit) : null,
  };
}

export async function setDefaultBranch(cx: ReaderContext, name: string): Promise<void> {
  const session = await openSession(cx);
  if (branchTip(session, name) === null) {
    throw new RepoReaderError("ref_not_found", `There is no branch ${JSON.stringify(name)}`);
  }
  cx.repo.setHead(BRANCH + name);
}

/** One compare-and-swap, with the storage's refusal as the reader's. */
export async function moveRef(
  cx: ReaderContext,
  update: { readonly name: string; readonly oldOid: ObjectId; readonly newOid: ObjectId },
  options: { readonly actor: GitEventActor | null; readonly notify: boolean },
): Promise<"moved" | "exists" | "missing" | "stale"> {
  const [result] = await cx.repo.applyUpdates([update], {
    actor: options.actor,
    notify: options.notify,
  });
  switch (result?.error ?? null) {
    case null:
      return "moved";
    case "reference already exists":
      return "exists";
    case "reference does not exist":
      return "missing";
    case "stale info":
      return "stale";
    case "invalid ref name":
      throw new RepoReaderError("invalid_ref", "That is not a name Git accepts for a ref");
    default:
      throw new Error(`could not update ${update.name}: ${result?.error}`);
  }
}

export async function createBranch(
  cx: ReaderContext,
  input: { readonly name: string; readonly from: string; readonly actor: GitEventActor | null },
): Promise<ReaderBranch> {
  if (!isValidRefName(BRANCH + input.name)) {
    throw new RepoReaderError("invalid_ref", "That is not a name Git accepts for a branch");
  }
  const session = await openSession(cx);
  // A writer may name a commit no ref reaches any more: that is how a deleted branch comes back.
  const from = await resolve(session, input.from, { unreachable: true });
  const moved = await moveRef(
    cx,
    { name: BRANCH + input.name, oldOid: ZERO_OID, newOid: from.commitOid },
    { actor: input.actor, notify: true },
  );
  if (moved !== "moved") {
    throw new RepoReaderError("ref_exists", `There is already a branch ${input.name}`);
  }
  return (await getBranch(cx, input.name))!;
}

export async function deleteBranch(
  cx: ReaderContext,
  input: {
    readonly name: string;
    readonly expectedOid?: string | undefined;
    readonly actor: GitEventActor | null;
  },
): Promise<{ readonly oid: string }> {
  const session = await openSession(cx);
  const oid = branchTip(session, input.name);
  if (oid === null) {
    throw new RepoReaderError("ref_not_found", `There is no branch ${JSON.stringify(input.name)}`);
  }
  if (input.expectedOid !== undefined && input.expectedOid !== oid) {
    throw new RepoReaderError("head_moved", "The branch has moved since it was looked at");
  }
  const moved = await moveRef(
    cx,
    { name: BRANCH + input.name, oldOid: oid, newOid: ZERO_OID },
    { actor: input.actor, notify: true },
  );
  if (moved === "missing") {
    throw new RepoReaderError("ref_not_found", `There is no branch ${JSON.stringify(input.name)}`);
  }
  if (moved !== "moved") {
    throw new RepoReaderError("head_moved", "The branch has moved since it was looked at");
  }
  return { oid };
}

/**
 * `refs/pull/<n>/head`, in the base repository. A fork's head is copied in
 * first, so the ref never points at something this repository lacks; that
 * copy is also what later lets the pull request be compared and merged here.
 */
export async function setPullRef(
  cx: ReaderContext,
  input: {
    readonly number: number;
    readonly headRepositoryId: string;
    readonly oid: string | null;
  },
): Promise<void> {
  if (!cx.repo.isReady()) return;
  const name = `refs/pull/${input.number}/head`;
  if (input.oid !== null && !(await cx.repo.importFrom(input.headRepositoryId, [input.oid]))) {
    throw new RepoReaderError("ref_not_found", "The branch's head commit is not there");
  }
  // Whoever else moved it in between was writing the same pull request's head: once more settles it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = cx.repo.listRefs().find((ref) => ref.name === name)?.oid ?? ZERO_OID;
    const next = input.oid ?? ZERO_OID;
    if (current === next) return;
    const moved = await moveRef(
      cx,
      { name, oldOid: current, newOid: next },
      { actor: null, notify: false },
    );
    if (moved === "moved") return;
  }
  throw new RepoReaderError("head_moved", "The branch page's ref kept moving");
}
