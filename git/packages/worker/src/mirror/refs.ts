/**
 * Which refs a push mirror carries. Pure: the repository's Durable Object
 * reads it when it plans a run, and the API when it checks a pattern.
 *
 * A mirror carries branches and tags and nothing else: never
 * `refs/pull/*`, a version's ref, or anything a client could not have
 * pushed here. Of those, an exclude pattern leaves a ref alone on both
 * sides: it is not pushed, and it is not deleted from the target.
 */

export const MIRROR_LIMITS = {
  /** Exclude patterns a mirror may have. */
  maxPatterns: 50,
  maxPatternLength: 200,
} as const;

const HEADS = "refs/heads/";
const TAGS = "refs/tags/";

/** A branch or a tag: what a mirror may carry. */
export const isMirroredNamespace = (name: string): boolean =>
  name.startsWith(HEADS) || name.startsWith(TAGS);

/**
 * `*` matches within a path segment, `**` across segments, everything else
 * is literal (the rule protected branches use, `db/policy-rules.ts`).
 */
const patternSource = (pattern: string): string => {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  return source;
};

/** Why a pattern cannot be used, or null. */
export const patternProblem = (pattern: string): string | null => {
  if (pattern === "") return "A pattern cannot be empty";
  if (pattern.length > MIRROR_LIMITS.maxPatternLength) return "A pattern is too long";
  if (/[\u0000- \u007f~^:?[\\]/.test(pattern)) {
    return "A pattern is a ref name with * or ** in it, with no spaces";
  }
  if (pattern.startsWith("refs/") && !isMirroredNamespace(pattern)) {
    return "A pattern that starts with refs/ names branches (refs/heads/) or tags (refs/tags/)";
  }
  return null;
};

/**
 * A test for the refs a list of patterns excludes. A pattern that starts
 * with `refs/` is matched against the whole name; any other against the
 * short name of a branch or a tag alike (`dependabot/**`, `v0.*`).
 */
export const excluder = (patterns: readonly string[]): ((name: string) => boolean) => {
  const full: RegExp[] = [];
  const short: RegExp[] = [];
  for (const pattern of patterns) {
    if (patternProblem(pattern) !== null) continue;
    (pattern.startsWith("refs/") ? full : short).push(new RegExp(`^${patternSource(pattern)}$`));
  }
  return (name) => {
    if (full.some((rule) => rule.test(name))) return true;
    const rest = name.startsWith(HEADS)
      ? name.slice(HEADS.length)
      : name.startsWith(TAGS)
        ? name.slice(TAGS.length)
        : null;
    return rest !== null && short.some((rule) => rule.test(rest));
  };
};
