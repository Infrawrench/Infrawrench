/**
 * Content negotiation for the marketing site.
 *
 * A caller that asks for markdown more strongly than HTML gets markdown from
 * the same URL — the home page, every documentation page, all of it. In
 * practice that caller is an agent, and the point is that it should not have to
 * know a URL convention to read the site: it asks the way HTTP has always said
 * to ask, and the answer is prose.
 *
 * This is why the content pages render on demand rather than prerendering.
 * Astro serves prerendered pages as static assets, which never reach middleware
 * and therefore cannot inspect `Accept` — a static docs page can only ever
 * answer HTML. `lib/page-cache.ts` buys back what static serving gave away, and
 * carries the reason the cache key is shaped the way it is.
 *
 * The `.md` twins (`/index.md`, `/docs/<slug>.md`) are still served, and are
 * still what `/llms.txt` links to: not every client can set a header, and a URL
 * you can paste is worth keeping even once negotiation works.
 */
import type { MiddlewareHandler } from "astro";
import { getEntry } from "astro:content";
import { markdownHeaders, prefersMarkdown } from "./lib/content-negotiation";
import { renderHomeMarkdown } from "./lib/markdown/home";
import { renderDocMarkdown } from "./lib/markdown/docs";
import { PAGE_CACHE_SECONDS, withPageCache } from "./lib/page-cache";

/** Paths that never negotiate: machine endpoints and their own formats. */
const EXCLUDED_PREFIXES = ["/api/", "/_astro/", "/_image"];
const EXCLUDED_EXACT = new Set(["/robots.txt", "/sitemap.xml", "/llms.txt"]);

/** The markdown URL for a path, for the `Link: rel="alternate"` header. */
function alternateFor(pathname: string): string | null {
  if (pathname === "/") return "/index.md";
  if (pathname.startsWith("/docs/")) return `${pathname}.md`;
  return null;
}

/** Build the markdown body for a negotiable path, or null if there isn't one. */
async function renderMarkdown(pathname: string, site: URL | undefined): Promise<string | null> {
  if (pathname === "/") return renderHomeMarkdown(site);
  if (pathname.startsWith("/docs/")) {
    const slug = pathname.slice("/docs/".length);
    // `getEntry` returns undefined for an unknown slug, which is how a bad URL
    // falls through to the HTML route and its 404 rather than answering 200
    // with an empty document.
    const entry = await getEntry("docs", slug);
    return entry ? renderDocMarkdown(entry) : null;
  }
  return null;
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const pathname = context.url.pathname.replace(/\/+$/, "") || "/";

  const excluded =
    EXCLUDED_EXACT.has(pathname) ||
    EXCLUDED_PREFIXES.some((p) => pathname.startsWith(p)) ||
    // The `.md` twins render themselves; negotiating on top would be a second
    // opinion about a URL that has already stated its format.
    pathname.endsWith(".md");
  if (excluded) return next();

  const alternate = alternateFor(pathname);
  const wantsMarkdown =
    alternate !== null && prefersMarkdown(context.request.headers.get("accept"));
  // `locals.cfContext`, as the `/api` routes already use — `locals.runtime.ctx`
  // was removed in Astro v6 and throws on access.
  const cfContext = context.locals.cfContext;

  return withPageCache(context.url, wantsMarkdown, cfContext, async () => {
    if (wantsMarkdown) {
      const body = await renderMarkdown(pathname, context.site);
      if (body !== null) {
        return new Response(body, {
          status: 200,
          headers: markdownHeaders({
            "Cache-Control": `public, max-age=60, s-maxage=${PAGE_CACHE_SECONDS}`,
            Link: `<${context.url.origin}${alternate}>; rel="alternate"; type="text/markdown"`,
          }),
        });
      }
      // No markdown for this path after all (unknown doc slug) — fall through
      // so the HTML route can answer, which for a bad slug means its 404.
    }

    const response = await next();

    if (alternate && response.status === 200) {
      // `Vary` for the caches that honour it; the edge cache key does the same
      // job for the one that does not.
      response.headers.append("Vary", "Accept");
      response.headers.append(
        "Link",
        `<${context.url.origin}${alternate}>; rel="alternate"; type="text/markdown"`,
      );
      if (!response.headers.has("Cache-Control")) {
        response.headers.set("Cache-Control", `public, max-age=60, s-maxage=${PAGE_CACHE_SECONDS}`);
      }
    }
    return response;
  });
};
