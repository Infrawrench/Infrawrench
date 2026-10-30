import { platformNames } from "@/lib/load";
import { platformInfo } from "@/lib/platforms";
import { pagesSitemap, platformSitemap } from "@/lib/sitemap";

/**
 * GET /sitemaps/<platform>.xml: one platform's listing and every instance page
 * in every language, including instances AWS no longer lists (their pages
 * still exist). GET /sitemaps/pages.xml: the index.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (file === "pages.xml") {
    return new Response(pagesSitemap(), {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  const platform = file.replace(/\.xml$/, "");
  const listed =
    file.endsWith(".xml") && platformInfo(platform) ? await platformNames(platform) : null;
  if (!listed) return new Response("Not found", { status: 404 });
  return new Response(platformSitemap(platform, listed.names), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
