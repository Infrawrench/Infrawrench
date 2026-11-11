import type { APIRoute } from "astro";
import { getDocsNav } from "../lib/docs-nav";
import { blogPostHref, getBlogPosts, isoPostDate } from "../lib/blog";
import { escapeXml } from "../lib/xml";
import { homeApps } from "../data/home";

export const prerender = true;

// Paths that resolve to a real page but shouldn't be advertised to crawlers.
const EXCLUDED = new Set(["/404"]);

/**
 * Marketing pages are discovered from the filesystem rather than listed by hand,
 * so a new `src/pages/*.astro` lands in the sitemap without anyone remembering
 * this file. `import.meta.glob` without `eager` only yields the keys: nothing is
 * imported. Dynamic routes are skipped here and enumerated from their content
 * collection instead.
 */
function staticPaths(): string[] {
  const paths: string[] = [];
  for (const file of Object.keys(import.meta.glob("./**/*.astro"))) {
    if (file.includes("[")) continue;
    const route = file
      .replace(/^\./, "")
      .replace(/\.astro$/, "")
      .replace(/\/index$/, "");
    const path = route === "" ? "/" : route;
    if (!EXCLUDED.has(path)) paths.push(path);
  }
  return paths.sort();
}

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    throw new Error("`site` must be set in astro.config.mjs to build the sitemap");
  }

  const sections = await getDocsNav();
  const posts = await getBlogPosts();
  // Posts carry their publication date as `lastmod` so crawlers can tell a new
  // guide from pages they have already seen. Other pages have no reliable date.
  const entries: { path: string; lastmod?: string }[] = [
    ...staticPaths().map((path) => ({ path })),
    // One page per app (`pages/apps/[app].astro`), a dynamic route the glob
    // above skips, so they are listed from the same data the route reads.
    ...homeApps.map((app) => ({ path: `/apps/${app.id}` })),
    ...sections.flatMap((s) => s.pages.map((p) => ({ path: p.href }))),
    ...posts.map((post) => ({ path: blogPostHref(post.id), lastmod: isoPostDate(post.data.date) })),
  ];

  const urls = entries
    .map(({ path, lastmod }) => {
      const loc = `<loc>${escapeXml(new URL(path, site).href)}</loc>`;
      return `  <url>${loc}${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
