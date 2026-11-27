/**
 * Which page of the UI a path is, as far as its link preview cares: the
 * thing it shows (a namespace, a repository, a commit, an issue, a branch
 * page) or none. One pure function over the path, beside the UI's own
 * routes (`git/packages/web/src/routes/`) and its titles (`lib/title.ts`).
 *
 * A page that only a signed-in person uses (settings, a new repository, the
 * reader's own lists) is `generic`: it gets the site's tags and nothing of
 * the path, so a preview never says more than a signed-out visitor sees.
 */
import { parseBranchKey } from "@infrawrench/git-contract";

/** A repository's pages that show the repository and nothing narrower. */
export const REPOSITORY_SECTIONS = {
  commits: "Commits",
  branches: "Branches",
  tags: "Tags",
  issues: "Issues",
  labels: "Labels",
  milestones: "Milestones",
  ci: "CI",
  infrastructure: "Infrastructure",
  compare: "Compare",
  tree: "Files",
  blob: "Files",
  blame: "Blame",
} as const;

export type RepositorySection = keyof typeof REPOSITORY_SECTIONS;

interface InRepository {
  readonly owner: string;
  readonly repo: string;
}

export type OgPage =
  /** `/`. */
  | { readonly kind: "home" }
  /** `/explore`. */
  | { readonly kind: "explore" }
  /** A signed-in person's page, or a path that is no page: the site's tags. */
  | { readonly kind: "generic" }
  /** `/<owner>`: a person, an organisation or a bot. */
  | { readonly kind: "namespace"; readonly owner: string }
  /**
   * `/<owner>/<repo>` and the pages of it that show no one thing. `path` is
   * a file or folder page's ref and path as the URL has them.
   */
  | ({
      readonly kind: "repository";
      readonly section: RepositorySection | null;
      readonly path: string | null;
    } & InRepository)
  | ({ readonly kind: "commit"; readonly sha: string } & InRepository)
  | ({ readonly kind: "issue"; readonly number: number } & InRepository)
  | ({ readonly kind: "branch"; readonly key: string } & InRepository)
  /** `/<owner>/<repo>/pulls/<n>`: an old numbered address of a branch page. */
  | ({ readonly kind: "branch-number"; readonly number: number } & InRepository);

/**
 * The pages a link preview image is drawn for (`ogImagePath`): the others
 * show one of these (a repository's tab shows its repository's card).
 */
export type OgCardPage = Extract<
  OgPage,
  { readonly kind: "home" | "namespace" | "repository" | "commit" | "issue" | "branch" }
>;

/** The UI's pages at the top of the site that are not a namespace. */
const SIGNED_IN = new Set(["changes", "reviews", "mentions", "new", "onboarding", "settings"]);

const GENERIC: OgPage = { kind: "generic" };

const decode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const NUMBER = /^[1-9][0-9]{0,8}$/;
const SHA = /^[0-9a-fA-F]{4,40}$/;

/** The page `pathname` is. Anything it does not recognise is `generic`. */
export function pageOf(pathname: string): OgPage {
  const raw = pathname.split("/").filter((segment) => segment !== "");
  const parts: string[] = [];
  for (const segment of raw) {
    const decoded = decode(segment);
    if (decoded === null) return GENERIC;
    parts.push(decoded);
  }
  const [first, second, third, fourth] = parts;
  if (first === undefined) return { kind: "home" };
  if (second === undefined) {
    if (first === "explore") return { kind: "explore" };
    if (SIGNED_IN.has(first)) return GENERIC;
    return { kind: "namespace", owner: first };
  }
  if (SIGNED_IN.has(first) || first === "explore") return GENERIC;
  const at = { owner: first, repo: second };
  if (third === undefined) return { kind: "repository", ...at, section: null, path: null };
  const rest = parts.slice(3);
  switch (third) {
    case "commit":
      return fourth !== undefined && rest.length === 1 && SHA.test(fourth)
        ? { kind: "commit", ...at, sha: fourth.toLowerCase() }
        : GENERIC;
    case "issues":
      if (fourth === undefined) return { kind: "repository", ...at, section: "issues", path: null };
      if (NUMBER.test(fourth) && rest.length === 1) {
        return { kind: "issue", ...at, number: Number(fourth) };
      }
      if (fourth === "labels") return { kind: "repository", ...at, section: "labels", path: null };
      if (fourth === "milestones") {
        return { kind: "repository", ...at, section: "milestones", path: null };
      }
      // `issues/new` is a signed-in person's form.
      return GENERIC;
    case "branches": {
      if (fourth === undefined) {
        return { kind: "repository", ...at, section: "branches", path: null };
      }
      const key = rest.join("/");
      return parseBranchKey(key) ? { kind: "branch", ...at, key } : GENERIC;
    }
    case "pulls":
      // `pulls/<n>` and `pulls/<n>/<tab>` are old addresses of a branch page; `new` and `start` are forms.
      return fourth !== undefined && NUMBER.test(fourth) && rest.length <= 2
        ? { kind: "branch-number", ...at, number: Number(fourth) }
        : GENERIC;
    case "tree":
    case "blob":
    case "blame":
      return {
        kind: "repository",
        ...at,
        section: third,
        path: rest.length === 0 ? null : rest.join("/"),
      };
    case "commits":
    case "tags":
    case "ci":
    case "infrastructure":
    case "compare":
      return { kind: "repository", ...at, section: third, path: null };
    default:
      // `settings`, `start` and anything the UI does not route.
      return GENERIC;
  }
}

/** The path a card page is at, as `ogImagePath` puts it after the version. */
export function cardPagePath(page: OgCardPage): string {
  const seg = encodeURIComponent;
  switch (page.kind) {
    case "home":
      return "/";
    case "namespace":
      return `/${seg(page.owner)}`;
    case "repository":
      return `/${seg(page.owner)}/${seg(page.repo)}`;
    case "commit":
      return `/${seg(page.owner)}/${seg(page.repo)}/commit/${seg(page.sha)}`;
    case "issue":
      return `/${seg(page.owner)}/${seg(page.repo)}/issues/${page.number}`;
    case "branch":
      return `/${seg(page.owner)}/${seg(page.repo)}/branches/${page.key.split("/").map(seg).join("/")}`;
  }
}
