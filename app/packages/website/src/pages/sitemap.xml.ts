import type { APIRoute } from "astro";
import { getDocsNav } from "../lib/docs-nav";

export const prerender = true;

// Paths that resolve to a real page but shouldn't be advertised to crawlers.
const EXCLUDED = new Set(["/404"]);

/**
 * Marketing pages are discovered from the filesystem rather than listed by hand,
 * so a new `src/pages/*.astro` lands in the sitemap without anyone remembering
 * this file. `import.meta.glob` without `eager` only yields the keys — nothing is
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    throw new Error("`site` must be set in astro.config.mjs to build the sitemap");
  }

  const sections = await getDocsNav();
  const paths = [...staticPaths(), ...sections.flatMap((s) => s.pages.map((p) => p.href))];

  const urls = paths
    .map((path) => `  <url><loc>${escapeXml(new URL(path, site).href)}</loc></url>`)
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
