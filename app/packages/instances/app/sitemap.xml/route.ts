import { platformNames } from "@/lib/load";
import { PLATFORMS } from "@/lib/platforms";
import { sitemapIndex } from "@/lib/sitemap";

/** GET /sitemap.xml: an index of per-platform sitemaps, for the platforms synced so far. */
export async function GET() {
  const platforms = Object.keys(PLATFORMS);
  const listed = await Promise.all(platforms.map((p) => platformNames(p)));
  return new Response(sitemapIndex(platforms.filter((_, i) => listed[i])), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
