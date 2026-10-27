/**
 * The blog: one place that decides which posts exist and in what order.
 *
 * Every surface that lists posts (the index, the RSS feed, the sitemap,
 * `/llms.txt`, the `.md` twins) goes through here, so a draft cannot leak into
 * one of them while staying hidden from the rest.
 */
import { getCollection, getEntry, type CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;

function isPublished(post: BlogPost): boolean {
  return import.meta.env.DEV || !post.data.draft;
}

/** Published posts, newest first. Ties fall back to title for a stable order. */
export async function getBlogPosts(): Promise<BlogPost[]> {
  const posts = await getCollection("blog", isPublished);
  return posts.sort(
    (a, b) =>
      b.data.date.getTime() - a.data.date.getTime() || a.data.title.localeCompare(b.data.title),
  );
}

/** One published post by slug, or undefined (which the route turns into a 404). */
export async function getBlogPost(slug: string): Promise<BlogPost | undefined> {
  const post = await getEntry("blog", slug);
  return post && isPublished(post) ? post : undefined;
}

export function blogPostHref(id: string): string {
  return `/blog/${id}`;
}

export function blogPostMarkdownPath(id: string): string {
  return `/blog/${id}.md`;
}

/** `October 27, 2026`, in UTC; see the `date` note in `content.config.ts`. */
export function formatPostDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** `2026-10-27`, for `<time datetime>`. */
export function isoPostDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
