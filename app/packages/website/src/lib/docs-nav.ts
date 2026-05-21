import { getCollection, type CollectionEntry } from "astro:content";

interface DocsSection {
  slug: string;
  label: string;
  pages: Array<{
    slug: string;
    href: string;
    title: string;
    description?: string;
    sectionLabel: string;
    sectionSlug: string;
  }>;
}

const SECTION_ORDER = [
  "getting-started",
  "core-concepts",
  "features",
  "plugins",
  "team-and-billing",
];

const SECTION_LABELS: Record<string, string> = {
  "getting-started": "Getting started",
  "core-concepts": "Core concepts",
  features: "Features",
  plugins: "Plugins",
  "team-and-billing": "Team & billing",
};

function sectionLabel(slug: string): string {
  return SECTION_LABELS[slug] ?? slug.replace(/-/g, " ");
}

function entrySection(entry: CollectionEntry<"docs">): { section: string; leaf: string } {
  const parts = entry.id.split("/");
  if (parts.length < 2) return { section: "", leaf: parts[0] ?? entry.id };
  return { section: parts[0]!, leaf: parts.slice(1).join("/") };
}

function entryHref(entry: CollectionEntry<"docs">): string {
  return `/docs/${entry.id}`;
}

export async function getDocsNav(): Promise<DocsSection[]> {
  const all = await getCollection("docs");
  const bySection = new Map<string, CollectionEntry<"docs">[]>();
  for (const entry of all) {
    const { section } = entrySection(entry);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section)!.push(entry);
  }

  const sortedSections = [...bySection.keys()].sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a);
    const bi = SECTION_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return sortedSections.map((section) => {
    const label = sectionLabel(section);
    const pages = (bySection.get(section) ?? [])
      .slice()
      .sort((a, b) => {
        const ao = a.data.sidebar_order ?? 999;
        const bo = b.data.sidebar_order ?? 999;
        if (ao !== bo) return ao - bo;
        return a.data.title.localeCompare(b.data.title);
      })
      .map((entry) => ({
        slug: entry.id,
        href: entryHref(entry),
        title: entry.data.title,
        description: entry.data.description,
        sectionLabel: label,
        sectionSlug: section,
      }));
    return { slug: section, label, pages };
  });
}
