import { getTranslator } from "@/lib/i18n/server";
import { loadListing } from "@/lib/load";
import { renderPlatformMarkdown } from "@/lib/markdown";

/** A service's listing as Markdown; `proxy.ts` rewrites `/aws/<platform>` here for agents. */
const HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "content-language": "en",
  "cache-control": "public, max-age=300",
  vary: "accept",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  const listing = await loadListing(platform);
  if (!listing) {
    return new Response(`# Not found\n\nThere is no AWS service called ${platform} here.\n`, {
      status: 404,
      headers: HEADERS,
    });
  }
  return new Response(renderPlatformMarkdown(listing, await getTranslator("en")), {
    headers: HEADERS,
  });
}
