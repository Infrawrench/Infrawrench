/**
 * The naming rules for namespaces and repositories, shared by the forms that
 * check a name as it is typed and the server that refuses it (git/README.md
 * "Identity, namespaces, access"). Pure functions, no schema: the API reads a
 * name as sent and answers its own `username_invalid` / `name_invalid`.
 */

export const NAME_MAX_LENGTH = 39;
export const REPOSITORY_NAME_MAX_LENGTH = 100;

const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Slugs no namespace may take: the site's own first path segments, and names
 * that would read as the site speaking. Compared lowercased.
 */
export const RESERVED_NAMESPACES: readonly string[] = [
  "about",
  "account",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "blog",
  "ci",
  "dashboard",
  "docs",
  "explore",
  "favicon.ico",
  "git",
  "help",
  "home",
  "infrawrench",
  "issues",
  "login",
  "logout",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "raw",
  "repos",
  "robots.txt",
  "search",
  "security",
  "settings",
  "sign-in",
  "sign-out",
  "signup",
  "static",
  "status",
  "support",
  "terraform",
  "user",
  "users",
  "well-known",
  ".well-known",
];

/**
 * Names no repository may take: the second path segment of a namespace's own
 * pages. Compared lowercased.
 */
export const RESERVED_REPOSITORY_NAMES: readonly string[] = [
  ".",
  "..",
  "-",
  "repositories",
  "settings",
  "stars",
];

export type NameProblem = "empty" | "too_long" | "characters" | "git_suffix" | "dots" | "reserved";

const shapeProblem = (name: string, maxLength: number): NameProblem | null => {
  if (name.length === 0) return "empty";
  if (name.length > maxLength) return "too_long";
  if (!NAME_PATTERN.test(name)) return "characters";
  const lower = name.toLowerCase();
  if (lower.endsWith(".git") || lower.endsWith(".wiki")) return "git_suffix";
  if (name.endsWith(".") || name.includes("..")) return "dots";
  return null;
};

/** Why `slug` cannot be a namespace, or null when it can (it may still be taken). */
export const namespaceSlugProblem = (slug: string): NameProblem | null =>
  shapeProblem(slug, NAME_MAX_LENGTH) ??
  (RESERVED_NAMESPACES.includes(slug.toLowerCase()) ? "reserved" : null);

/** Why `name` cannot be a repository's name, or null when it can. */
export const repositoryNameProblem = (name: string): NameProblem | null =>
  shapeProblem(name, REPOSITORY_NAME_MAX_LENGTH) ??
  (RESERVED_REPOSITORY_NAMES.includes(name.toLowerCase()) ? "reserved" : null);

/** A sentence for a {@link NameProblem}, as the API words it in `error`. */
export const nameProblemMessage = (problem: NameProblem, maxLength: number): string => {
  switch (problem) {
    case "empty":
      return "A name is required";
    case "too_long":
      return `Names are at most ${maxLength} characters`;
    case "characters":
      return "Names use letters, digits, dots, dashes and underscores, and start with a letter, digit or underscore";
    case "git_suffix":
      return "Names cannot end in .git or .wiki";
    case "dots":
      return "Names cannot end in a dot or contain two dots in a row";
    case "reserved":
      return "That name is reserved";
  }
};

/**
 * A slug to offer someone who has not picked one, from their email or display
 * name: the characters the rules allow, trimmed to length. May be empty, and
 * may be reserved or taken; the caller checks.
 */
export const suggestSlug = (source: string): string =>
  source
    .split("@")[0]!
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, NAME_MAX_LENGTH)
    .replace(/[.-]+$/g, "");

/**
 * Whether `name` is a ref name Git accepts for a branch or tag
 * (`git check-ref-format --branch`), enough for a form to check as it is
 * typed. The server checks again.
 */
export const isValidRefName = (name: string): boolean => {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock") || name === "@" || name === "HEAD") return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  // Control characters, space and the characters Git reserves.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
};
