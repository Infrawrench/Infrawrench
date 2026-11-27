/**
 * What a link preview image looks like: one layout per card, as the element
 * tree Satori lays out (`./render.ts`). Pure: the pictures it shows are
 * handed in already fetched (`./images.ts`), as data URLs, or left out.
 *
 * The site's light scheme (`app/packages/ui/src/theme.css`): its surfaces,
 * its ink, its status colours, Inter for type and the forge's own mark
 * (`git/packages/web/src/layout/SidebarShell.tsx` `BrandMark`). Satori
 * lays out every element with more than one child as a flex box, so every
 * such element says `display: flex`.
 */
import { OG_IMAGE_SIZE, languageColor } from "@infrawrench/git-contract";
import { type FindingsFacts, type PersonFacts, type RepositoryFacts, clip } from "./facts";
import type { Card } from "./meta";

/** An element as Satori reads it (a React element's shape, without React). */
export interface Node {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>> & {
    readonly style?: Readonly<Record<string, unknown>>;
    readonly children?: unknown;
  };
}

type Child = Node | string | null | false;

const h = (type: string, style: Record<string, unknown>, ...children: Child[]): Node => {
  const kept = children.filter(
    (child): child is Node | string => child !== null && child !== false,
  );
  return {
    type,
    props: { style, children: kept.length === 1 ? kept[0] : kept },
  };
};

const img = (src: string, size: number, style: Record<string, unknown> = {}): Node => ({
  type: "img",
  props: { src, width: size, height: size, style: { width: size, height: size, ...style } },
});

/** The theme's light scheme. */
export const INK = {
  page: "#ffffff",
  surface: "#f7f7f8",
  sunken: "#e9e9eb",
  border: "#d4d4d8",
  ink: "#18181b",
  muted: "#52525a",
  faint: "#81818a",
  danger: "#a91818",
  warning: "#7a4a00",
  success: "#0a5c36",
  notice: "#7e22ce",
  info: "#3f3f46",
} as const;

/** The pictures a card shows, by the address its facts name, as data URLs. */
export type CardImages = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// Glyphs: Lucide's, as the UI draws them (`git/packages/web/src/components/icons.tsx`).
// ---------------------------------------------------------------------------

const GLYPHS = {
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  gitFork:
    '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  circleDot: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  circleSlash: '<circle cx="12" cy="12" r="10"/><path d="M9 15 15 9"/>',
  gitBranch:
    '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  gitMerge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  gitCommit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/>',
  messageSquare: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
} as const;

type Glyph = keyof typeof GLYPHS;

/** An SVG of ours (ASCII only) as a data URL. */
const svgData = (svg: string): string => `data:image/svg+xml;base64,${btoa(svg)}`;

const glyph = (name: Glyph, size: number, color: string): Node =>
  img(
    svgData(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`,
    ),
    size,
  );

/** The forge's mark, `BrandMark` in the UI, in one colour. */
const brandMark = (size: number, color: string): Node =>
  img(
    svgData(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><mask id="m" maskUnits="userSpaceOnUse" x="-300" y="-300" width="600" height="600"><rect x="-300" y="-300" width="600" height="600" fill="#fff"/><path d="M-34 -240H34V-112Q34 -98 20 -98H-20Q-34 -98 -34 -112Z" fill="#000"/><circle cx="0" cy="128" r="22" fill="#000"/></mask></defs><g transform="translate(256 256) rotate(45) translate(0 16)"><g mask="url(#m)" fill="${color}"><circle cx="0" cy="-114" r="88"/><path d="M-34 100V20C-34 -10 -44 -34 -64 -60H64C44 -34 34 -10 34 20V100Z"/><circle cx="0" cy="128" r="48"/></g></g></svg>`,
    ),
    size,
  );

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const count = (value: number): string =>
  value >= 10_000
    ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
    : value.toLocaleString("en-US");

const initials = (name: string): string => {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase() || "?";
};

/** A picture, or the name's initials on a quiet tile when there is none. */
const avatar = (
  images: CardImages,
  url: string | null,
  name: string,
  size: number,
  square: boolean,
  ring = false,
): Node => {
  const radius = square ? Math.round(size * 0.2) : size / 2;
  const frame = {
    borderRadius: radius,
    ...(ring ? { border: `4px solid ${INK.page}` } : {}),
  };
  const data = url === null ? undefined : images.get(url);
  if (data !== undefined) return img(data, size, { ...frame, objectFit: "cover" });
  return h(
    "div",
    {
      display: "flex",
      width: size,
      height: size,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: INK.sunken,
      color: INK.muted,
      fontSize: Math.round(size * 0.38),
      fontWeight: 600,
      ...frame,
    },
    initials(name),
  );
};

/** The site's mark and name, top left of every card, with what the card is in. */
const header = (context: string | null): Node =>
  h(
    "div",
    { display: "flex", alignItems: "center", gap: 14, fontSize: 26, color: INK.muted },
    brandMark(34, INK.ink),
    h("div", { display: "flex", fontWeight: 600, color: INK.ink }, "Infrawrench Git"),
    context === null ? null : h("div", { display: "flex", color: INK.faint }, "/"),
    context === null ? null : h("div", { display: "flex" }, context),
  );

const stat = (icon: Glyph, value: string, color: string = INK.muted): Node =>
  h(
    "div",
    { display: "flex", alignItems: "center", gap: 10, fontSize: 26, color },
    glyph(icon, 28, color),
    value,
  );

const pill = (label: string, color: string, icon: Glyph | null): Node =>
  h(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 20px",
      borderRadius: 999,
      backgroundColor: color,
      color: INK.page,
      fontSize: 24,
      fontWeight: 600,
    },
    icon === null ? null : glyph(icon, 26, INK.page),
    label,
  );

const titleText = (text: string, size: number, lines: number): Node =>
  h(
    "div",
    {
      display: "block",
      fontSize: size,
      fontWeight: 600,
      lineHeight: 1.15,
      letterSpacing: -1,
      color: INK.ink,
      lineClamp: lines,
      overflow: "hidden",
    },
    text,
  );

const bodyText = (text: string, size: number, lines: number): Node =>
  h(
    "div",
    {
      display: "block",
      fontSize: size,
      lineHeight: 1.35,
      color: INK.muted,
      lineClamp: lines,
      overflow: "hidden",
    },
    text,
  );

/** The frame every card shares: the page, its margins, and the languages bar along the bottom. */
const frame = (body: Node, footer: Node | null = null): Node =>
  h(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: OG_IMAGE_SIZE.width,
      height: OG_IMAGE_SIZE.height,
      backgroundColor: INK.page,
      fontFamily: "Inter",
      color: INK.ink,
    },
    h(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        padding: "56px 72px 48px",
        gap: 0,
      },
      body,
    ),
    footer,
  );

/** The repository's languages as a bar along the card's bottom edge, or a plain rule. */
const languageBar = (repository: RepositoryFacts | null): Node => {
  const total = repository?.languages.reduce((sum, language) => sum + language.bytes, 0) ?? 0;
  if (repository === null || total === 0) {
    return h("div", { display: "flex", height: 16, backgroundColor: INK.ink });
  }
  return h(
    "div",
    { display: "flex", height: 16, backgroundColor: INK.sunken },
    ...repository.languages.map((language) =>
      h("div", {
        display: "flex",
        width: `${(language.bytes / total) * 100}%`,
        height: 16,
        backgroundColor: languageColor(language.name),
      }),
    ),
  );
};

/** The languages by share, as a legend: colour, name, percentage. */
const languageLegend = (repository: RepositoryFacts): Node | null => {
  const total = repository.languages.reduce((sum, language) => sum + language.bytes, 0);
  if (total === 0) return null;
  return h(
    "div",
    { display: "flex", gap: 32, fontSize: 24, color: INK.muted },
    ...repository.languages.slice(0, 4).map((language) =>
      h(
        "div",
        { display: "flex", alignItems: "center", gap: 10 },
        h("div", {
          display: "flex",
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: languageColor(language.name),
        }),
        h("div", { display: "flex", color: INK.ink, fontWeight: 600 }, language.name),
        `${Math.max(0.1, Math.round((language.bytes / total) * 1000) / 10)}%`,
      ),
    ),
  );
};

const repoName = (repository: RepositoryFacts): string => `${repository.owner}/${repository.name}`;

/** The two pictures of a branch page: who opened it, and the agent writing it, overlapping. */
const people = (
  images: CardImages,
  list: ReadonlyArray<PersonFacts | null>,
  size: number,
): Node | null => {
  const shown = list.filter((person): person is PersonFacts => person !== null);
  if (shown.length === 0) return null;
  return h(
    "div",
    { display: "flex", alignItems: "center" },
    ...shown.map((person, index) =>
      h(
        "div",
        { display: "flex", marginLeft: index === 0 ? 0 : -Math.round(size * 0.28) },
        avatar(images, person.avatarUrl, person.name, size, false, true),
      ),
    ),
  );
};

const findingsRow = (findings: FindingsFacts): Node | null => {
  const items: Array<[number, string, string]> = [
    [findings.mustFix, "must fix", INK.danger],
    [findings.shouldFix, "should fix", INK.warning],
    [findings.note, findings.note === 1 ? "note" : "notes", INK.info],
  ];
  const open = items.filter(([value]) => value > 0);
  if (open.length === 0) return null;
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 14 },
    ...open.map(([value, label, color]) =>
      h(
        "div",
        {
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 16px",
          borderRadius: 999,
          border: `2px solid ${color}`,
          color,
          fontSize: 22,
          fontWeight: 600,
        },
        h("div", {
          display: "flex",
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: color,
        }),
        `${value} ${label}`,
      ),
    ),
  );
};

const diffStat = (additions: number, deletions: number): Node =>
  h(
    "div",
    { display: "flex", gap: 14, fontSize: 26, fontWeight: 600 },
    h("div", { display: "flex", color: INK.success }, `+${count(additions)}`),
    h("div", { display: "flex", color: INK.danger }, `−${count(deletions)}`),
  );

const spacer = (): Node => h("div", { display: "flex", flexGrow: 1 });

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const siteCard = (): Node =>
  frame(
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 36 },
      brandMark(140, INK.ink),
      h(
        "div",
        { display: "flex", fontSize: 92, fontWeight: 700, letterSpacing: -3, color: INK.ink },
        "Infrawrench Git",
      ),
      h("div", { display: "flex", fontSize: 34, color: INK.muted }, "git.infrawrench.com"),
    ),
  );

const repositoryCard = (repository: RepositoryFacts, images: CardImages): Node =>
  frame(
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1 },
      header(null),
      h(
        "div",
        { display: "flex", alignItems: "flex-start", gap: 48, marginTop: 64 },
        h(
          "div",
          { display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, gap: 18 },
          h(
            "div",
            { display: "flex", fontSize: 40, color: INK.muted, lineHeight: 1.1 },
            `${clip(repository.owner, 40)}/`,
          ),
          titleText(clip(repository.name, 60), 76, 1),
          repository.description === null
            ? null
            : bodyText(clip(repository.description, 180), 30, 2),
        ),
        avatar(
          images,
          repository.ownerAvatarUrl,
          repository.owner,
          148,
          repository.ownerKind === "org",
        ),
      ),
      spacer(),
      h(
        "div",
        { display: "flex", alignItems: "center", gap: 40 },
        stat("star", count(repository.stars)),
        stat("gitFork", count(repository.forks)),
        repository.issues ? stat("circleDot", count(repository.openIssues)) : null,
        stat("gitBranch", count(repository.openBranches)),
        repository.archived ? pill("Archived", INK.warning, null) : null,
      ),
      h("div", { display: "flex", marginTop: 26 }, languageLegend(repository)),
    ),
    languageBar(repository),
  );

const namespaceCard = (card: Extract<Card, { kind: "namespace" }>, images: CardImages): Node => {
  const name = card.displayName ?? card.slug;
  return frame(
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1 },
      header(null),
      h(
        "div",
        { display: "flex", alignItems: "center", gap: 56, flexGrow: 1 },
        avatar(images, card.avatarUrl, name, 236, card.namespaceKind === "org"),
        h(
          "div",
          { display: "flex", flexDirection: "column", flexShrink: 1, gap: 14 },
          titleText(clip(name, 40), 76, 1),
          h(
            "div",
            { display: "flex", alignItems: "center", gap: 18, fontSize: 34, color: INK.muted },
            card.slug,
            card.namespaceKind === "bot" ? pill("Bot", INK.info, null) : null,
          ),
          card.description === null ? null : bodyText(clip(card.description, 160), 28, 2),
          card.repositories === null
            ? null
            : h(
                "div",
                { display: "flex", marginTop: 10 },
                stat(
                  "book",
                  `${count(card.repositories)} ${card.repositories === 1 ? "repository" : "repositories"}`,
                ),
              ),
        ),
      ),
    ),
    languageBar(null),
  );
};

const threadLayout = (
  repository: RepositoryFacts,
  badge: Node,
  title: string,
  subtitle: string | null,
  meta: Node,
  aside: Node | null,
): Node =>
  frame(
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1 },
      header(clip(repoName(repository), 48)),
      h("div", { display: "flex", alignItems: "center", gap: 20, marginTop: 52 }, badge),
      h(
        "div",
        { display: "flex", flexDirection: "column", gap: 18, marginTop: 26, flexShrink: 1 },
        titleText(clip(title, 140), 60, 2),
        subtitle === null ? null : bodyText(clip(subtitle, 160), 28, 2),
      ),
      spacer(),
      h("div", { display: "flex", alignItems: "center", gap: 28 }, aside, meta),
    ),
    languageBar(repository),
  );

const metaRow = (...items: Array<Node | string | null>): Node =>
  h(
    "div",
    { display: "flex", alignItems: "center", gap: 28, fontSize: 26, color: INK.muted },
    // Each in its own box: Satori runs neighbouring strings together into one text.
    ...items
      .filter((item): item is Node | string => item !== null)
      .map((item) => (typeof item === "string" ? h("div", { display: "flex" }, item) : item)),
  );

const BRANCH_PILLS = {
  open: ["Open", INK.success, "gitBranch"],
  draft: ["Draft", INK.info, "gitBranch"],
  merged: ["Merged", INK.notice, "gitMerge"],
  closed: ["Closed", INK.danger, "gitBranch"],
} as const satisfies Record<string, readonly [string, string, Glyph]>;

/** The card a link preview image draws for `card`, with `images` fetched for it. */
export function cardNode(card: Card, images: CardImages = new Map()): Node {
  switch (card.kind) {
    case "site":
      return siteCard();
    case "namespace":
      return namespaceCard(card, images);
    case "repository":
      return repositoryCard(card.repository, images);
    case "commit":
      return threadLayout(
        card.repository,
        h(
          "div",
          { display: "flex", alignItems: "center", gap: 20 },
          pill("Commit", INK.ink, "gitCommit"),
          h(
            "div",
            { display: "flex", fontSize: 28, fontWeight: 600, color: INK.muted, letterSpacing: 1 },
            card.sha.slice(0, 7),
          ),
        ),
        card.summary,
        null,
        metaRow(
          h(
            "div",
            { display: "flex", color: INK.ink, fontWeight: 600 },
            clip(card.author.name, 40),
          ),
          card.authoredAt.slice(0, 10),
          `${count(card.filesChanged)} ${card.filesChanged === 1 ? "file" : "files"}`,
          diffStat(card.additions, card.deletions),
        ),
        avatar(images, card.author.avatarUrl, card.author.name, 64, false),
      );
    case "issue": {
      const [label, color, icon]: [string, string, Glyph] =
        card.state === "open"
          ? ["Open", INK.success, "circleDot"]
          : card.closedAs === "not_planned"
            ? ["Not planned", INK.info, "circleSlash"]
            : ["Closed", INK.notice, "checkCircle"];
      return threadLayout(
        card.repository,
        h(
          "div",
          { display: "flex", alignItems: "center", gap: 20 },
          pill(label, color, icon),
          h("div", { display: "flex", fontSize: 30, color: INK.muted }, `#${card.number}`),
        ),
        card.title,
        null,
        metaRow(
          card.author === null
            ? null
            : h(
                "div",
                { display: "flex", color: INK.ink, fontWeight: 600 },
                clip(card.author.name, 40),
              ),
          stat("messageSquare", count(card.comments)),
        ),
        card.author === null
          ? null
          : avatar(images, card.author.avatarUrl, card.author.name, 64, false),
      );
    }
    case "branch": {
      const [label, color, icon] = BRANCH_PILLS[card.state];
      return threadLayout(
        card.repository,
        h(
          "div",
          { display: "flex", alignItems: "center", gap: 20, flexShrink: 1 },
          pill(label, color, icon),
          h("div", { display: "flex", fontSize: 28, color: INK.muted }, clip(card.headRef, 40)),
          glyph("arrowRight", 26, INK.faint),
          h("div", { display: "flex", fontSize: 28, color: INK.muted }, clip(card.baseRef, 24)),
        ),
        card.title,
        card.ask !== null && card.ask !== card.title ? card.ask : null,
        h(
          "div",
          { display: "flex", alignItems: "center", gap: 28 },
          metaRow(
            card.versions === null ? null : stat("layers", `v${card.versions}`, INK.ink),
            stat("gitCommit", count(card.commits)),
            diffStat(card.additions, card.deletions),
          ),
          findingsRow(card.findings),
        ),
        people(images, [card.author, card.agent], 64),
      );
    }
  }
}

/** Every picture `card` shows, by the address its facts name. */
export function cardImageUrls(card: Card): string[] {
  switch (card.kind) {
    case "site":
      return [];
    case "namespace":
      return card.avatarUrl === null ? [] : [card.avatarUrl];
    case "repository":
      return card.repository.ownerAvatarUrl === null ? [] : [card.repository.ownerAvatarUrl];
    case "commit":
      return card.author.avatarUrl === null ? [] : [card.author.avatarUrl];
    case "issue":
      return card.author?.avatarUrl ? [card.author.avatarUrl] : [];
    case "branch":
      return [card.author?.avatarUrl, card.agent?.avatarUrl].filter(
        (url): url is string => typeof url === "string",
      );
  }
}
