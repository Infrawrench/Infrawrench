import { getTranslator } from "@/lib/i18n/server";
import { loadListing } from "@/lib/load";
import { renderPlatformMarkdown } from "@/lib/markdown";
import { platformAt } from "@/lib/platforms";

/** A service's listing as Markdown; `proxy.ts` rewrites `/<cloud>/<platform>` here for agents. */
const HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "content-language": "en",
  "cache-control": "public, max-age=300",
  vary: "accept",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cloud: string; platform: string }> },
) {
  const { cloud, platform: slug } = await params;
  const platform = platformAt(cloud, slug);
  const listing = platform ? await loadListing(platform) : null;
  if (!listing) {
    return new Response(`# Not found\n\nThere is no ${cloud} service called ${slug} here.\n`, {
      status: 404,
      headers: HEADERS,
    });
  }
  return new Response(renderPlatformMarkdown(listing, await getTranslator("en")), {
    headers: HEADERS,
  });
}
