/**
 * What names a branch's page on git.infrawrench.com, in a link and in an API
 * path: the branch itself. Pure, and here rather than in the forge's
 * contract because the app links to a branch's page too (CI runs, the
 * Agents page's `?git=owner/repo&branch=`) and its contract imports nothing
 * from the forge. The forge's contract re-exports these.
 *
 * A key is `[<owner>/<name>:]<branch>[~<n>]`:
 *
 * - `feature/a`: the page of that branch of the repository in the path.
 * - `bob/infra:feature/a`: the page of a branch of the fork `bob/infra`,
 *   proposed to the repository in the path. `-:feature/a` when the fork is
 *   gone.
 * - `feature/a~2`: the second page that name had (counted from the first,
 *   oldest first). The bare name is the open page, or the newest when none
 *   is open, so `~n` is only written for an earlier page of a name that was
 *   used again.
 *
 * A branch's name holds neither `:` nor `~` (git's own rule), and a
 * namespace is never `-`, so nothing inside a key is escaped.
 */

/** The fork a page's branch is in: its `owner/name`, or `"gone"` once deleted. */
export type GitBranchKeyFork = { readonly owner: string; readonly name: string } | "gone";

export interface GitBranchKey {
  /** Null for a branch of the repository the page is in. */
  readonly fork: GitBranchKeyFork | null;
  readonly branch: string;
  /** Which page of the name, 1 for its first. Null for the open or newest one. */
  readonly ordinal: number | null;
}

const ORDINAL = /~([1-9][0-9]{0,8})$/;

/** Null for text that is no key: an empty branch, a fork that is not `owner/name`. */
export function parseGitBranchKey(key: string): GitBranchKey | null {
  const ordinal = ORDINAL.exec(key);
  const rest = ordinal ? key.slice(0, ordinal.index) : key;
  const colon = rest.indexOf(":");
  const branch = colon === -1 ? rest : rest.slice(colon + 1);
  if (branch === "" || branch.includes(":") || branch.includes("~")) return null;
  let fork: GitBranchKeyFork | null = null;
  if (colon !== -1) {
    const named = rest.slice(0, colon);
    if (named === "-") {
      fork = "gone";
    } else {
      const parts = named.split("/");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
      fork = { owner: parts[0]!, name: parts[1]! };
    }
  }
  return { fork, branch, ordinal: ordinal ? Number(ordinal[1]) : null };
}

export function formatGitBranchKey(key: {
  readonly fork?: GitBranchKeyFork | null | undefined;
  readonly branch: string;
  readonly ordinal?: number | null | undefined;
}): string {
  const fork =
    key.fork == null ? "" : key.fork === "gone" ? "-:" : `${key.fork.owner}/${key.fork.name}:`;
  return `${fork}${key.branch}${key.ordinal == null ? "" : `~${key.ordinal}`}`;
}

/**
 * The path of a branch's page: `/:owner/:repo/branches/<key>`, the key's
 * slashes kept as the path's own, so `feature/a` reads as it is written.
 */
export function gitBranchPagePath(owner: string, repo: string, key: string): string {
  const segments = key.split("/").map((segment) => encodeURIComponent(segment));
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${segments.join("/")}`;
}
