/**
 * What the code pages ask for, in one place, so a link that prefetches on
 * hover fills exactly the cache entry the page then reads, and a click shows
 * the folder or the file at once.
 *
 * Neither the listing nor the file walks history: their header's commit (and
 * the root's commit count) is `latestCommit`, asked once the page shows, and
 * the listing's per-entry commits are `treeLastCommits`.
 */
import { queries, queryClient } from "../../api/queries";
import type { RepoRef } from "../../lib/paths";

export const treeQuery = (repo: RepoRef, ref: string, path: string) =>
  queries.contents.tree({ params: repo, query: { ref, path, lastCommits: "false" } });

export const blobQuery = (repo: RepoRef, ref: string, path: string) =>
  queries.contents.blob({ params: repo, query: { ref, path, lastCommit: "false" } });

/** A path's newest commit, and the commit count at the root. Ask it by commit id: the answer never changes. */
export const latestCommitQuery = (repo: RepoRef, commitOid: string, path: string) => ({
  ...queries.contents.latestCommit({ params: repo, query: { ref: commitOid, path } }),
  staleTime: Infinity,
});

/**
 * Starts loading a folder or a file the pointer rests on (or the keyboard
 * reaches), so it is usually there by the click. Already cached and fresh:
 * nothing is sent.
 */
export function prefetchEntry(
  repo: RepoRef,
  ref: string,
  entry: { readonly type: "tree" | "blob" | "symlink" | "submodule"; readonly path: string },
): void {
  if (entry.type === "tree") void queryClient.prefetchQuery(treeQuery(repo, ref, entry.path));
  else if (entry.type === "blob" || entry.type === "symlink") {
    void queryClient.prefetchQuery(blobQuery(repo, ref, entry.path));
  }
}
