/**
 * Content negotiation for the marketing site.
 *
 * A caller that asks for markdown more strongly than HTML gets markdown from
 * the same URL. In practice that caller is an agent, and the point is that it
 * should not have to know a URL convention to read the site — it asks the way
 * HTTP has always said to ask, and the answer is prose.
 *
 * **This runs for on-demand routes only.** Astro serves prerendered pages as
 * static assets, so `/docs/*` never reaches middleware. Those pages advertise
 * their markdown twin with a `<link rel="alternate">` in the head, and every
 * markdown URL on the site is listed in `/llms.txt`. That split is worth
 * knowing about before wondering why `Accept` appears not to work on a docs
 * page: nothing is broken, the route is simply static. Making docs negotiate
 * too is one line per route (`prerender = false`) and a real caching decision,
 * so it is deliberately not taken here.
 */
import type { MiddlewareHandler } from "astro";
import { markdownHeaders, prefersMarkdown } from "./lib/content-negotiation";
import { renderHomeMarkdown } from "./lib/markdown/home";

/**
 * On-demand routes with a markdown representation, by pathname.
 *
 * A `Map` rather than an object literal so a miss is typed as `undefined` —
 * with an index signature TypeScript reports the lookup as always defined, and
 * the guard below would be dead code that still ran.
 */
const MARKDOWN_ROUTES = new Map<string, (site: URL | undefined) => string>([
  ["/", renderHomeMarkdown],
]);

export const onRequest: MiddlewareHandler = async (context, next) => {
  const pathname = context.url.pathname.replace(/\/+$/, "") || "/";
  const render = MARKDOWN_ROUTES.get(pathname);

  if (render && prefersMarkdown(context.request.headers.get("accept"))) {
    return new Response(render(context.site), {
      status: 200,
      headers: markdownHeaders({
        // Short, because the page embeds live product data. Long enough that a
        // crawler sweeping the site does not re-render it per request.
        "Cache-Control": "public, max-age=300",
        Link: `<${context.url.origin}/index.md>; rel="alternate"; type="text/markdown"`,
      }),
    });
  }

  const response = await next();

  // Announce the alternate even on the HTML answer, and mark the URL as
  // negotiated so a shared cache keys on `Accept` rather than serving one
  // representation to everyone.
  if (render) {
    response.headers.append("Vary", "Accept");
    response.headers.append(
      "Link",
      `<${context.url.origin}/index.md>; rel="alternate"; type="text/markdown"`,
    );
  }
  return response;
};
