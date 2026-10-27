import type { APIRoute } from "astro";
import { markdownHeaders } from "../lib/content-negotiation";
import { getBlogPosts } from "../lib/blog";
import { renderBlogIndexMarkdown } from "../lib/markdown/blog";

/** `/blog.md`: the post list as markdown, the pasteable twin of a negotiated `/blog`. */
export const prerender = true;

export const GET: APIRoute = async ({ site }) =>
  new Response(
    renderBlogIndexMarkdown(await getBlogPosts(), site?.origin ?? "https://infrawrench.com"),
    {
      status: 200,
      headers: markdownHeaders(),
    },
  );
