/**
 * The markdown representation of the blog: the index and each post.
 *
 * Same treatment as `docs.ts`: frontmatter becomes a heading, a byline and a
 * lede, because raw YAML is noise to a reader that is not a static-site
 * generator.
 */
import { blogPostMarkdownPath, formatPostDate, type BlogPost } from "../blog";
import { stripScreenshotPlaceholders } from "./docs";

function byline(post: BlogPost): string {
  const date = formatPostDate(post.data.date);
  const parts = [post.data.kind === "guide" ? "Guide" : null, date, post.data.author];
  return parts.filter(Boolean).join(" · ");
}

export function renderBlogPostMarkdown(post: BlogPost): string {
  const body = stripScreenshotPlaceholders(post.body ?? "");
  return `# ${post.data.title}\n\n_${byline(post)}_\n\n${post.data.description}\n\n${body}\n`;
}

/** One bullet per entry; posts carry their date, guides are evergreen and do not. */
export function renderBlogListMarkdown(entries: BlogPost[], origin: string): string {
  return entries
    .map((entry) => {
      const date = entry.data.kind === "post" ? ` (${formatPostDate(entry.data.date)})` : "";
      return `- [${entry.data.title}](${origin}${blogPostMarkdownPath(entry.id)})${date}: ${entry.data.description}`;
    })
    .join("\n");
}

/** A `## Guides` section with a leading blank line, or nothing when there are none. */
export function renderBlogGuidesMarkdown(guides: BlogPost[], origin: string): string {
  return guides.length
    ? `\n\n## Guides\n\nTutorials, walkthroughs and reference write-ups.\n\n${renderBlogListMarkdown(guides, origin)}`
    : "";
}

/** Takes every published entry and splits them the way the HTML index does. */
export function renderBlogIndexMarkdown(entries: BlogPost[], origin: string): string {
  const posts = entries.filter((entry) => entry.data.kind === "post");
  const guides = entries.filter((entry) => entry.data.kind === "guide");
  const postList = posts.length ? renderBlogListMarkdown(posts, origin) : "No posts yet.";
  return `# Infrawrench blog\n\nProduct news, release notes and engineering write-ups. RSS: ${origin}/blog/rss.xml\n\n${postList}${renderBlogGuidesMarkdown(guides, origin)}\n`;
}
