import type { APIRoute } from "astro";
import { markdownHeaders } from "../../lib/content-negotiation";
import { getBlogPosts } from "../../lib/blog";
import { renderBlogPostMarkdown } from "../../lib/markdown/blog";

/**
 * `/blog/<slug>.md`: every published post as markdown. Prerendered, like the
 * docs twins; this is what each post's `<link rel="alternate">` and `/llms.txt`
 * point at.
 */
export const prerender = true;

export async function getStaticPaths() {
  const posts = await getBlogPosts();
  return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(renderBlogPostMarkdown(props["post"]), {
    status: 200,
    headers: markdownHeaders(),
  });
