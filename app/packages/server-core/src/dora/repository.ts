/**
 * Repository names arrive in every spelling a provider can think of: a clone
 * URL, a web URL, `github.com/owner/name`, `owner/name`. Scoping by
 * repository and resolving commit times both need one spelling, and the one
 * the GitHub API takes (`owner/name`) is the useful one.
 */
const HOSTS =
  /^(?:https?:\/\/|git@|ssh:\/\/git@)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)[/:]/i;

export function normalizeRepository(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  const m = HOSTS.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  // A web URL may carry a path past the repository (`/tree/main`).
  if (m && m[1]!.toLowerCase() === "github.com") s = s.split("/").slice(0, 2).join("/");
  return s || null;
}

/** Whether a normalized repository looks like a GitHub `owner/name`. */
export function isOwnerSlashName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}
