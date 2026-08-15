import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { markdownHeaders } from "../../lib/content-negotiation";
import { renderDocMarkdown } from "../../lib/markdown/docs";

/**
 * `/docs/<slug>.md` — every documentation page as markdown.
 *
 * Prerendered alongside the HTML, so this costs a file per page at build and
 * nothing at request time. It exists because the HTML twin is static and
 * therefore cannot negotiate: this is the URL its `<link rel="alternate">`
 * points at, and the one `/llms.txt` lists.
 */
export const prerender = true;

export async function getStaticPaths() {
  const entries = await getCollection("docs");
  return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(renderDocMarkdown(props["entry"]), {
    status: 200,
    headers: markdownHeaders(),
  });
