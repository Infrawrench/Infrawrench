/**
 * A page's link preview: its title, description, canonical address and
 * image, from the facts a signed-out visitor may see (`./lookup.ts`). Pure,
 * so every page type is tested without a database or a Worker.
 *
 * **Nothing in, nothing out.** Without facts (the site's own pages, a
 * signed-in person's pages, and anything private or missing) the answer is
 * {@link genericMeta} for the site's origin, whatever the path: the same
 * bytes for a private repository as for one that was never made, and for
 * one private page as for another.
 *
 * Names and facts only: what a thing is called, what its page says, and
 * its numbers. No copy about the site.
 */
import { OG_IMAGE_SIZE, ogImagePath } from "@infrawrench/git-contract";
import { type OgFacts, type RepositoryFacts, clip } from "./facts";
import { type OgCardPage, type OgPage, REPOSITORY_SECTIONS, cardPagePath } from "./pages";

export const SITE_NAME = "Infrawrench Git";
export const SITE_DESCRIPTION = "Git repositories, branch pages and CI on Infrawrench.";

/**
 * Bumped when a card's drawing changes, so every image's version moves and
 * caches that kept the old one let it go.
 */
export const CARD_DESIGN = 1;

/** What a card draws: the site's own, or the facts of the thing a page shows. */
export type Card = { readonly kind: "site" } | OgFacts;

export const SITE_CARD: Card = { kind: "site" };

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  /** `og:url`: the page's own address, or the site's for the generic tags. */
  readonly url: string;
  /** `<link rel="canonical">`: the page's own address; the generic tags point at the site. */
  readonly canonical: string;
  readonly type: "website" | "profile" | "article";
  readonly image: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly alt: string;
  };
}

/** The version in a card's image path: 16 hex digits of a SHA-256 over what it draws. */
export async function cardVersion(card: Card): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ design: CARD_DESIGN, card }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const join = (...parts: ReadonlyArray<string | null | undefined | false>): string =>
  parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");

const titled = (...parts: ReadonlyArray<string | null | undefined>): string =>
  join(...parts, SITE_NAME);

const fullName = (repository: RepositoryFacts): string => `${repository.owner}/${repository.name}`;

/** A repository's numbers, as its header shows them. */
export const repositoryNumbers = (repository: RepositoryFacts): string =>
  join(
    repository.languages[0]?.name,
    plural(repository.stars, "star"),
    plural(repository.forks, "fork"),
    repository.issues ? plural(repository.openIssues, "open issue") : null,
    repository.archived ? "Archived" : null,
  );

const BRANCH_STATES = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const;

/** Open findings by severity, as the branch page's tally names them. */
export const findingsLine = (findings: {
  readonly mustFix: number;
  readonly shouldFix: number;
  readonly note: number;
}): string | null => {
  const parts = [
    findings.mustFix > 0 ? `${findings.mustFix} must fix` : null,
    findings.shouldFix > 0 ? `${findings.shouldFix} should fix` : null,
    findings.note > 0 ? plural(findings.note, "note") : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Open findings: ${parts.join(", ")}`;
};

/** A file or folder page's path without the default branch in front, or null at the root. */
const shownPath = (path: string, defaultBranch: string): string | null => {
  if (path === defaultBranch) return null;
  const prefix = `${defaultBranch}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

const imageOf = async (
  origin: string,
  page: OgCardPage | null,
  card: Card,
  alt: string,
): Promise<PageMeta["image"]> => ({
  url: `${origin}${ogImagePath(await cardVersion(card), page === null ? "/" : cardPagePath(page))}`,
  width: OG_IMAGE_SIZE.width,
  height: OG_IMAGE_SIZE.height,
  alt,
});

/** The tags of the site's own card: the generic tags, and the home page's. */
export async function genericMeta(origin: string): Promise<PageMeta> {
  return {
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: `${origin}/`,
    canonical: `${origin}/`,
    type: "website",
    image: await imageOf(origin, null, SITE_CARD, SITE_NAME),
  };
}

/** The card a page's image draws, and the page whose path the image is at. */
export function cardOf(facts: OgFacts | null): {
  readonly card: Card;
  readonly at: OgCardPage | null;
} {
  if (facts === null) return { card: SITE_CARD, at: null };
  switch (facts.kind) {
    case "namespace":
      return { card: facts, at: { kind: "namespace", owner: facts.slug } };
    case "repository":
      return {
        card: facts,
        at: {
          kind: "repository",
          owner: facts.repository.owner,
          repo: facts.repository.name,
          section: null,
          path: null,
        },
      };
    case "commit":
      return {
        card: facts,
        at: {
          kind: "commit",
          owner: facts.repository.owner,
          repo: facts.repository.name,
          sha: facts.sha,
        },
      };
    case "issue":
      return {
        card: facts,
        at: {
          kind: "issue",
          owner: facts.repository.owner,
          repo: facts.repository.name,
          number: facts.number,
        },
      };
    case "branch":
      return {
        card: facts,
        at: {
          kind: "branch",
          owner: facts.repository.owner,
          repo: facts.repository.name,
          key: facts.key,
        },
      };
  }
}

/** `page`'s tags at `origin`, from what a signed-out visitor may see of it. */
export async function pageMeta(
  page: OgPage,
  facts: OgFacts | null,
  origin: string,
): Promise<PageMeta> {
  if (facts === null) {
    if (page.kind !== "explore") return genericMeta(origin);
    return {
      ...(await genericMeta(origin)),
      title: titled("Explore"),
      description: "Public repositories on Infrawrench Git.",
      url: `${origin}/explore`,
      canonical: `${origin}/explore`,
    };
  }
  const { card, at } = cardOf(facts);
  const own = `${origin}${pagePathOf(page, facts)}`;
  const base = { url: own, canonical: own };
  switch (facts.kind) {
    case "namespace": {
      const name =
        facts.namespaceKind === "bot"
          ? `${facts.displayName ?? facts.slug} (bot)`
          : facts.displayName !== null && facts.displayName !== facts.slug
            ? `${facts.displayName} (${facts.slug})`
            : facts.slug;
      const description =
        facts.namespaceKind === "bot"
          ? `Bot account. Commits and branches by ${facts.displayName ?? facts.slug} on Infrawrench Git.`
          : join(
              facts.description === null ? null : clip(facts.description, 200),
              facts.repositories === null
                ? null
                : plural(facts.repositories, "public repository", "public repositories"),
            );
      return {
        ...base,
        title: titled(name),
        description,
        type: "profile",
        image: await imageOf(origin, at, card, name),
      };
    }
    case "repository": {
      const repository = facts.repository;
      const name = fullName(repository);
      const section =
        page.kind === "repository" && page.section !== null
          ? REPOSITORY_SECTIONS[page.section]
          : null;
      const path =
        page.kind === "repository" && page.path !== null
          ? shownPath(page.path, repository.defaultBranch)
          : null;
      const numbers = repositoryNumbers(repository);
      return {
        ...base,
        title: titled(path ?? (section === "Files" ? null : section), name),
        description:
          repository.description === null
            ? numbers
            : `${clip(repository.description, 250)} ${numbers}.`,
        type: "website",
        image: await imageOf(origin, at, card, join(name, repository.description)),
      };
    }
    case "commit": {
      const name = fullName(facts.repository);
      const short = facts.sha.slice(0, 7);
      return {
        ...base,
        title: titled(clip(facts.summary, 120), `${name}@${short}`),
        description: `${facts.author.name} committed ${short} on ${facts.authoredAt.slice(0, 10)}. ${plural(facts.filesChanged, "file")} changed, ${plural(facts.additions, "addition")}, ${plural(facts.deletions, "deletion")}.`,
        type: "article",
        image: await imageOf(origin, at, card, join(`Commit ${short} in ${name}`, facts.summary)),
      };
    }
    case "issue": {
      const name = fullName(facts.repository);
      const state =
        facts.state === "open"
          ? "Open"
          : facts.closedAs === "not_planned"
            ? "Closed as not planned"
            : "Closed";
      return {
        ...base,
        title: titled(clip(facts.title, 120), `Issue #${facts.number}`, name),
        description: join(
          state,
          facts.author ? `Opened by ${facts.author.name}` : null,
          plural(facts.comments, "comment"),
        ),
        type: "article",
        image: await imageOf(
          origin,
          at,
          card,
          join(`Issue #${facts.number} in ${name}`, facts.title),
        ),
      };
    }
    case "branch": {
      const name = fullName(facts.repository);
      const numbers = join(
        BRANCH_STATES[facts.state],
        `${facts.headRef} into ${facts.baseRef}`,
        facts.versions === null ? null : plural(facts.versions, "version"),
        findingsLine(facts.findings),
        facts.agent ? `Agent: ${facts.agent.name}` : null,
      );
      return {
        ...base,
        title: titled(clip(facts.title, 120), name),
        description:
          facts.ask !== null && facts.ask !== facts.title ? `${facts.ask} ${numbers}` : numbers,
        type: "article",
        image: await imageOf(
          origin,
          at,
          card,
          join(`Branch ${facts.headRef} in ${name}`, facts.title),
        ),
      };
    }
  }
}

/**
 * The page's own path, canonical: an old numbered branch page's is its
 * branch's, and a branch page's key is the one it answers to.
 */
const pagePathOf = (page: OgPage, facts: OgFacts): string => {
  if (facts.kind === "branch")
    return cardPagePath({
      kind: "branch",
      owner: facts.repository.owner,
      repo: facts.repository.name,
      key: facts.key,
    });
  if (page.kind === "repository" && (page.section !== null || page.path !== null)) {
    const seg = encodeURIComponent;
    const base = `/${seg(facts.kind === "repository" ? facts.repository.owner : page.owner)}/${seg(facts.kind === "repository" ? facts.repository.name : page.repo)}`;
    const tail =
      page.section === "labels" || page.section === "milestones"
        ? `issues/${page.section}`
        : (page.section ?? "");
    return `${base}/${tail}${page.path === null ? "" : `/${page.path.split("/").map(seg).join("/")}`}`;
  }
  return cardPagePath(cardOf(facts).at ?? { kind: "home" });
};
