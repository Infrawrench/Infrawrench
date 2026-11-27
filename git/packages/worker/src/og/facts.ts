/**
 * What a link preview says about a page: plain data, read as a signed-out
 * visitor would see it (`./lookup.ts`), kept in the edge cache as JSON and
 * drawn by `./meta.ts` (the tags) and `./card.ts` (the image). Nothing here
 * is more than the page itself shows that visitor.
 */

/** A person or a bot where one is named: the name the page shows, and their picture. */
export interface PersonFacts {
  readonly name: string;
  /** An address on another site (fetched through `./images.ts`), or a file of this site's. */
  readonly avatarUrl: string | null;
}

export interface RepositoryFacts {
  readonly owner: string;
  readonly ownerKind: "user" | "org";
  readonly ownerAvatarUrl: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  /** Bytes by language on the default branch, most first, at most {@link MAX_LANGUAGES}. */
  readonly languages: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
  readonly stars: number;
  readonly forks: number;
  readonly openIssues: number;
  readonly openBranches: number;
  readonly archived: boolean;
  readonly issues: boolean;
}

/** Open findings on a branch, by severity. */
export interface FindingsFacts {
  readonly mustFix: number;
  readonly shouldFix: number;
  readonly note: number;
}

export type BranchState = "open" | "draft" | "merged" | "closed";

export type OgFacts =
  | {
      readonly kind: "namespace";
      readonly slug: string;
      readonly namespaceKind: "user" | "org" | "bot";
      readonly displayName: string | null;
      readonly description: string | null;
      readonly avatarUrl: string | null;
      /** Public repositories. Null for a bot, which owns none. */
      readonly repositories: number | null;
    }
  | { readonly kind: "repository"; readonly repository: RepositoryFacts }
  | {
      readonly kind: "commit";
      readonly repository: RepositoryFacts;
      readonly sha: string;
      readonly summary: string;
      readonly author: PersonFacts;
      /** ISO 8601. */
      readonly authoredAt: string;
      readonly filesChanged: number;
      readonly additions: number;
      readonly deletions: number;
    }
  | {
      readonly kind: "issue";
      readonly repository: RepositoryFacts;
      readonly number: number;
      readonly title: string;
      readonly state: "open" | "closed";
      readonly closedAs: "completed" | "not_planned" | null;
      readonly comments: number;
      readonly author: PersonFacts | null;
    }
  | {
      readonly kind: "branch";
      readonly repository: RepositoryFacts;
      /** The page's canonical key, what its path is made of. */
      readonly key: string;
      readonly title: string;
      readonly state: BranchState;
      readonly headRef: string;
      readonly baseRef: string;
      /** Its newest version. Null before the first push is recorded. */
      readonly versions: number | null;
      readonly findings: FindingsFacts;
      /** The first line of the page's description, which an agent's ask becomes. */
      readonly ask: string | null;
      readonly author: PersonFacts | null;
      /** The agent that writes the branch, when one is connected. */
      readonly agent: PersonFacts | null;
      readonly commits: number;
      readonly additions: number;
      readonly deletions: number;
    };

export const MAX_LANGUAGES = 6;

/** The first line of Markdown that says something, without its markers, or null. */
export const firstLine = (markdown: string, max = 200): string | null => {
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s{0,3}(?:-{3,}|={3,}|\*{3,})\s*$/.test(raw)) continue;
    const line = raw
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`|<!--.*?-->/g, "")
      .trim();
    if (line !== "") return clip(line, max);
  }
  return null;
};

/** `text` cut to `max` characters at a word where it can be, with an ellipsis. */
export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
