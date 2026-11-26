/** History: lists of commits, ranges of them, and blame. */
import type { Blame, BlameRange, Commit, CommitSummary } from "@infrawrench/git-contract";
import { GitError, type ObjectId, isObjectId } from "@infrawrench/git-core";
import { type LogOptions, blame as opsBlame, log, splitPath } from "@infrawrench/git-ops";
import {
  type CompareInput,
  type ListCommitsInput,
  type PageInput,
  type ReaderPage,
  type RefInput,
  RepoReaderError,
} from "../reader";
import { blobIn } from "./content";
import { headIn, scanCache } from "./diffs";
import {
  BRANCH,
  type ReaderContext,
  cleanPath,
  commitShape,
  offsetOf,
  openSession,
  resolve,
  summaries,
  summaryOf,
} from "./session";

/** Commits looked at per step when a page has to be filtered out of a longer walk. */
const FILTER_CHUNK = 500;
/** Other branches a new branch's commits are told apart from. */
const MAX_EXCLUDED_TIPS = 200;
/** The most `base..head` holds before a page of it is cut. */
const MAX_RANGE_COMMITS = 10_000;

const seconds = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
};

export async function listCommits(
  cx: ReaderContext,
  input: ListCommitsInput,
): Promise<ReaderPage<CommitSummary>> {
  const session = await openSession(cx);
  const ref = await resolve(session, input.ref);
  const path = cleanPath(input.path ?? "");
  const emails =
    input.authorEmails && input.authorEmails.length > 0
      ? new Set(input.authorEmails.map((email) => email.toLowerCase()))
      : null;
  const since = seconds(input.since);
  const until = seconds(input.until);
  const filtered = emails !== null || since !== null || until !== null;
  const cache = scanCache(session);
  const deadline = Date.now() + cx.limits.logScanMillis;
  const items: CommitSummary[] = [];
  let offset = offsetOf(input.cursor);

  for (;;) {
    const options: LogOptions = {
      skip: offset,
      limit: filtered ? FILTER_CHUNK : input.limit - items.length,
      ...(path !== "" ? { path, followRenames: input.follow === true } : {}),
    };
    const found = await log(cache, ref.commitOid, options);
    let taken = 0;
    let ended = false;
    for (const entry of found.entries) {
      taken++;
      const time = entry.commit.committer.timestamp;
      // History is walked newest first, so the first commit older than `since` ends it, as in git.
      if (since !== null && time < since) {
        ended = true;
        break;
      }
      if (until !== null && time > until) continue;
      if (emails !== null && !emails.has(entry.commit.author.email.toLowerCase())) continue;
      items.push(summaryOf(entry.oid, entry.commit));
      if (items.length >= input.limit) break;
    }
    offset += taken;
    const more = taken < found.entries.length || found.hasMore;
    if (ended || !more) return { items, nextCursor: null };
    // A page may be short when the filter is sparse: the cursor says where to carry on.
    if (items.length >= input.limit || Date.now() >= deadline) {
      return { items, nextCursor: String(offset) };
    }
  }
}

export async function commits(
  cx: ReaderContext,
  oids: readonly string[],
): Promise<readonly CommitSummary[]> {
  const session = await openSession(cx);
  const found = await summaries(session, oids.filter(isObjectId));
  return oids.flatMap((oid) => found.get(oid) ?? []);
}

export async function commitsBetween(
  cx: ReaderContext,
  input: CompareInput,
  page: PageInput,
): Promise<ReaderPage<CommitSummary>> {
  const first = await openSession(cx);
  const base = await resolve(first, input.base);
  const { ref: head, session } = await headIn(first, input.head, input.headRepositoryId);
  const found = await log(scanCache(session), head.commitOid, {
    exclude: [base.commitOid],
    limit: MAX_RANGE_COMMITS,
  });
  // Oldest first, as a pull request reads.
  const all = found.entries.reverse();
  const offset = offsetOf(page.cursor);
  return {
    items: all
      .slice(offset, offset + page.limit)
      .map((entry) => summaryOf(entry.oid, entry.commit)),
    nextCursor: offset + page.limit < all.length ? String(offset + page.limit) : null,
  };
}

export async function commitRange(
  cx: ReaderContext,
  input: { readonly base: string | null; readonly head: string; readonly limit: number },
): Promise<readonly Commit[]> {
  const session = await openSession(cx);
  if (!isObjectId(input.head) || !(await session.objects.has(input.head))) return [];
  let exclude: ObjectId[];
  if (input.base !== null && isObjectId(input.base) && (await session.objects.has(input.base))) {
    exclude = [input.base];
  } else {
    // A new branch: what it has that no other branch does.
    exclude = [
      ...new Set(
        session.refs
          .filter((ref) => ref.name.startsWith(BRANCH) && ref.oid !== input.head)
          .map((ref) => ref.oid),
      ),
    ].slice(0, MAX_EXCLUDED_TIPS);
  }
  const found = await log(scanCache(session), input.head, {
    limit: input.limit,
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  return found.entries.reverse().map((entry) => commitShape(entry.oid, entry.commit));
}

export async function blame(
  cx: ReaderContext,
  input: { readonly ref: RefInput; readonly path: string },
): Promise<Blame> {
  const session = await openSession(cx);
  const ref = await resolve(session, input.ref);
  const path = cleanPath(input.path);
  // Refuses a directory or a missing path the way the file view does.
  const file = await blobIn(session, ref, path);
  if (file.binary) throw new RepoReaderError("not_a_file", "A binary file has no lines to blame");
  let result: Awaited<ReturnType<typeof opsBlame>>;
  try {
    result = await opsBlame(session.cache, ref.commitOid, path, {
      maxCommits: cx.limits.blameCommits,
      maxMillis: cx.limits.blameMillis,
    });
  } catch (error) {
    if (error instanceof GitError && error.code === "limit") {
      throw new RepoReaderError("too_large", error.message);
    }
    throw error;
  }
  if (result.binary) throw new RepoReaderError("not_a_file", "A binary file has no lines to blame");
  if (result.tooLarge) throw new RepoReaderError("too_large", "This file is too large to blame");

  // Where to blame from to see the lines before: the first parent that had the file.
  const previous = new Map<string, ObjectId | null>();
  const previousOf = async (commit: ObjectId, at: string): Promise<ObjectId | null> => {
    const key = `${commit}\0${at}`;
    const known = previous.get(key);
    if (known !== undefined) return known;
    let found: ObjectId | null = null;
    for (const parent of (await session.cache.node(commit)).parents) {
      const tree = (await session.cache.node(parent)).tree;
      if ((await session.cache.entryAt(tree, splitPath(at))) !== null) {
        found = parent;
        break;
      }
    }
    previous.set(key, found);
    return found;
  };
  const ranges: BlameRange[] = [];
  for (const range of result.ranges) {
    ranges.push({
      startLine: range.start,
      lineCount: range.lines,
      commitOid: range.commit,
      originalStartLine: range.originalStart,
      originalPath: range.path,
      previousCommitOid: await previousOf(range.commit, range.path),
    });
  }
  const found = await summaries(
    session,
    result.ranges.map((range) => range.commit),
  );
  return { ref, path, ranges, commits: Object.fromEntries(found), blob: file };
}
