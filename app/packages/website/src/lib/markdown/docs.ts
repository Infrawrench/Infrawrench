/**
 * The markdown representation of a docs page.
 *
 * These pages *are* markdown on disk, so this is mostly a matter of handing
 * back the source: with two adjustments that matter to a reader who is not a
 * browser:
 *
 * - The frontmatter becomes a heading and a lede. Raw YAML at the top of a
 *   response is noise to anything that did not expect a static-site convention.
 * - The screenshot placeholder shorthand is dropped. `<insert ... here>` is an
 *   instruction to a human with a screenshot tool; leaving it in reads as a
 *   broken image to everyone else.
 */
import type { CollectionEntry } from "astro:content";
import { getSkill, skillFileUrl, SITE } from "../../data/skills";

/** `<insert Some description here>` on its own line: see CLAUDE.md. */
const SCREENSHOT_PLACEHOLDER = /^[ \t]*<insert\b[^>]*>[ \t]*$\n?/gim;

/** Drop screenshot placeholders from a markdown body, for non-browser readers. */
export function stripScreenshotPlaceholders(markdown: string): string {
  return (
    markdown
      .replace(SCREENSHOT_PLACEHOLDER, "")
      // Collapse the blank-line pairs a removed placeholder leaves behind.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** `<skill id="..." />` on its own line: see `lib/remark-docs.mjs`. */
const SKILL_TAG = /^<skill\s+id="([a-z0-9-]+)"\s*\/?>\s*(?:<\/skill>)?[ \t]*$/gm;

/** A skill card, for readers who are not browsers: where its files are. */
export function renderSkillTags(markdown: string): string {
  return markdown.replace(SKILL_TAG, (_, id: string) => {
    const skill = getSkill(id);
    if (!skill) return "";
    const files = skill.files.map((f) => `[${f.path}](${skillFileUrl(skill, f.path)})`).join(", ");
    return `**Agent skill: ${skill.title}.** ${skill.summary} All of it in one file: ${SITE}/skills/${skill.id}.md. Its files, for a skills folder such as \`.claude/skills/${skill.id}/\`: ${files}.`;
  });
}

export function renderDocMarkdown(entry: CollectionEntry<"docs">): string {
  const body = renderSkillTags(stripScreenshotPlaceholders(entry.body ?? ""));

  const lede = entry.data.description ? `\n${entry.data.description}\n` : "";
  return `# ${entry.data.title}\n${lede}\n${body}\n`;
}

/** The canonical markdown URL for a docs entry. */
export function docMarkdownPath(id: string): string {
  return `/docs/${id}.md`;
}
