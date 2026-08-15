import type { APIRoute } from "astro";
import { markdownHeaders } from "../lib/content-negotiation";
import { renderHomeMarkdown } from "../lib/markdown/home";

/**
 * `/index.md` — the home page as markdown, at a URL rather than behind a
 * header.
 *
 * The negotiated `/` is the polite path; this is the one a caller can paste
 * into a tool that does not let it set headers, and the one `/llms.txt` links
 * to. Same renderer, so they cannot drift.
 */
export const prerender = false;

export const GET: APIRoute = ({ site }) =>
  new Response(renderHomeMarkdown(site), {
    status: 200,
    headers: markdownHeaders({ "Cache-Control": "public, max-age=300" }),
  });
