import { GitError } from "../errors";
import { isObjectId } from "../hex";
import { formatSignature, parseSignature } from "../signature";
import type { Commit, ObjectId } from "../types";
import { parseHeaderBlock, serializeHeaderBlock } from "./headers";

function oidHeader(value: string, what: string): ObjectId {
  if (!isObjectId(value)) throw new GitError("bad-object", `commit has a malformed ${what} id`);
  return value;
}

/**
 * Parses a commit. Headers are read in the order git writes them (`tree`,
 * `parent`s, `author`, `committer`); everything after `committer` is kept in
 * `extraHeaders` in order, so `serializeCommit` gives the same bytes back.
 */
export function parseCommit(data: Uint8Array): Commit {
  const { headers, message, latin1 } = parseHeaderBlock(data, "commit");
  let index = 0;
  const take = (key: string): string | null =>
    headers[index]?.[0] === key ? headers[index++]![1] : null;

  const tree = take("tree");
  if (tree === null) throw new GitError("bad-object", "commit has no tree");
  const parents: ObjectId[] = [];
  for (let parent = take("parent"); parent !== null; parent = take("parent")) {
    parents.push(oidHeader(parent, "parent"));
  }
  const author = take("author");
  if (author === null) throw new GitError("bad-object", "commit has no author");
  const committer = take("committer");
  if (committer === null) throw new GitError("bad-object", "commit has no committer");
  const commit: Commit = {
    tree: oidHeader(tree, "tree"),
    parents,
    author: parseSignature(author),
    committer: parseSignature(committer),
    message,
    extraHeaders: headers.slice(index),
  };
  return latin1 ? { ...commit, latin1: true } : commit;
}

export function serializeCommit(commit: Commit): Uint8Array {
  const headers: Array<[string, string]> = [["tree", commit.tree]];
  for (const parent of commit.parents) headers.push(["parent", parent]);
  headers.push(["author", formatSignature(commit.author)]);
  headers.push(["committer", formatSignature(commit.committer)]);
  for (const [key, value] of commit.extraHeaders) headers.push([key, value]);
  return serializeHeaderBlock({ headers, message: commit.message, latin1: commit.latin1 === true });
}

/** The value of an extra header (`gpgsig`, `encoding`, `mergetag`), or null. */
export function commitHeader(commit: Commit, key: string): string | null {
  for (const [name, value] of commit.extraHeaders) if (name === key) return value;
  return null;
}

/** The first line of the message, which is what lists show. */
export function messageSubject(message: string): string {
  const end = message.indexOf("\n");
  return end < 0 ? message : message.slice(0, end);
}
