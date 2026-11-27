/**
 * The naming rules for git.infrawrench.com's namespaces and repositories,
 * shared by the forms that check a name as it is typed and the servers that
 * refuse it (git/README.md "Identity, namespaces, access"). Pure functions,
 * no schema: an API reads a name as sent and answers its own refusal.
 *
 * Here rather than in `@infrawrench/git-contract` because the app claims and
 * renames an organisation's namespace too (Settings > Git, the `git` API
 * domain), and the app's contract imports nothing from the forge. The forge's
 * contract re-exports these, so there is one list.
 */
import { gitBotByUsername } from "./git-bots";

export const GIT_NAME_MAX_LENGTH = 39;
export const GIT_REPOSITORY_NAME_MAX_LENGTH = 100;

const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Slugs no namespace may take: the site's own first path segments, and names
 * that would read as the site speaking. Compared lowercased.
 */
export const GIT_RESERVED_NAMESPACES: readonly string[] = [
  "about",
  "account",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "blog",
  "changes",
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
  "mcp",
  "mentions",
  "new",
  "notifications",
  "oauth",
  "onboarding",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "raw",
  "repos",
  "reviews",
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
export const GIT_RESERVED_REPOSITORY_NAMES: readonly string[] = [
  ".",
  "..",
  "-",
  "repositories",
  "settings",
  "stars",
];

export type GitNameProblem =
  "empty" | "too_long" | "characters" | "git_suffix" | "dots" | "reserved" | "bot";

// Note: the checks run in this order on purpose, so a name with several
// problems reports the most basic one first (an empty name is "empty", not
// "characters").
const shapeProblem = (name: string, maxLength: number): GitNameProblem | null => {
  if (name.length === 0) return "empty";
  if (name.length > maxLength) return "too_long";
  if (!NAME_PATTERN.test(name)) return "characters";
  const lower = name.toLowerCase();
  // Note: compared lowercased, so `Foo.GIT` is refused as well. A `foo.git`
  // repository would read like the clone address of a repository `foo`.
  if (lower.endsWith(".git") || lower.endsWith(".wiki")) return "git_suffix";
  if (name.endsWith(".") || name.includes("..")) return "dots";
  return null;
};

/**
 * Why `slug` cannot be a namespace, or null when it can (it may still be
 * taken). `bot` is a bot account's username (`git-bots.ts`): unlike
 * `reserved`, nobody is let past it, a platform admin included.
 */
export const gitNamespaceSlugProblem = (slug: string): GitNameProblem | null =>
  shapeProblem(slug, GIT_NAME_MAX_LENGTH) ??
  (gitBotByUsername(slug) !== null
    ? "bot"
    : GIT_RESERVED_NAMESPACES.includes(slug.toLowerCase())
      ? "reserved"
      : null);

/** Why `name` cannot be a repository's name, or null when it can. */
export const gitRepositoryNameProblem = (name: string): GitNameProblem | null =>
  shapeProblem(name, GIT_REPOSITORY_NAME_MAX_LENGTH) ??
  (GIT_RESERVED_REPOSITORY_NAMES.includes(name.toLowerCase()) ? "reserved" : null);

/** A sentence for a {@link GitNameProblem}, as the API words it in `error`. */
export const gitNameProblemMessage = (problem: GitNameProblem, maxLength: number): string => {
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
    case "bot":
      return "That name belongs to a bot account";
  }
};

/**
 * A slug to offer someone who has not picked one, from their email or display
 * name: the characters the rules allow, trimmed to length. May be empty, and
 * may be reserved or taken; the caller checks.
 */
export const suggestGitSlug = (source: string): string =>
  // Note: NFKD splits an accented letter into its base letter and a combining
  // mark, so "José" becomes "Jose" plus a mark; the mark turns into a dash
  // below and the trailing dash is trimmed, leaving "Jose".
  source
    .split("@")[0]!
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, GIT_NAME_MAX_LENGTH)
    .replace(/[.-]+$/g, "");

/**
 * Whether `name` is a ref name Git accepts for a branch or tag
 * (`git check-ref-format --branch`), enough for a form to check as it is
 * typed. The server checks again.
 */
export const isValidGitRefName = (name: string): boolean => {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock") || name === "@" || name === "HEAD") return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  // Control characters, space and the characters Git reserves.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
};
