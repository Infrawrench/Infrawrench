import { DEFAULT_LOCALE, LOCALES, localePath } from "./i18n/locales";

export const ORIGIN = "https://instances.infrawrench.com";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The sitemap index: the site's own pages, then one sitemap per platform. */
export function sitemapIndex(platforms: string[]): string {
  const entries = ["pages", ...platforms].map(
    (p) => `  <sitemap><loc>${ORIGIN}/sitemaps/${escape(p)}.xml</loc></sitemap>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</sitemapindex>
`;
}

/**
 * Pages, every language as its own `<url>` carrying the full set of hreflang
 * alternates (Google's rule for localized pages: each version lists all of
 * them, itself included).
 */
function urlset(paths: string[]): string {
  const urls: string[] = [];
  for (const path of paths) {
    const alternates = [
      ...LOCALES.map(
        (l) =>
          `    <xhtml:link rel="alternate" hreflang="${l}" href="${ORIGIN}${escape(localePath(l, path))}"/>`,
      ),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${escape(localePath(DEFAULT_LOCALE, path))}"/>`,
    ].join("\n");
    for (const l of LOCALES) {
      urls.push(`  <url>
    <loc>${ORIGIN}${escape(localePath(l, path))}</loc>
${alternates}
  </url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

/** The pages that are not a service's: the home page (the chat) and the service list. */
export function pagesSitemap(): string {
  return urlset(["/", "/aws"]);
}

/**
 * One service's listing and every instance page under it. About 6 x 1,950
 * URLs for the largest (SageMaker), well inside the 50,000-URL limit.
 */
export function platformSitemap(platform: string, instances: string[]): string {
  return urlset([
    `/aws/${platform}`,
    ...[...instances].sort().map((name) => `/aws/${platform}/${encodeURIComponent(name)}`),
  ]);
}
