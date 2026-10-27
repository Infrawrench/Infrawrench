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
  return post.data.author ? `${date} · ${post.data.author}` : date;
}

export function renderBlogPostMarkdown(post: BlogPost): string {
  const body = stripScreenshotPlaceholders(post.body ?? "");
  return `# ${post.data.title}\n\n_${byline(post)}_\n\n${post.data.description}\n\n${body}\n`;
}

export function renderBlogIndexMarkdown(posts: BlogPost[], origin: string): string {
  const items = posts.length
    ? posts
        .map(
          (post) =>
            `- [${post.data.title}](${origin}${blogPostMarkdownPath(post.id)}) (${formatPostDate(post.data.date)}): ${post.data.description}`,
        )
        .join("\n")
    : "No posts yet.";
  return `# Infrawrench blog\n\nProduct news, release notes and engineering write-ups. RSS: ${origin}/blog/rss.xml\n\n${items}\n`;
}
