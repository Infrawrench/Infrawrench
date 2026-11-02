import { getTranslator } from "@/lib/i18n/server";
import { loadIndex } from "@/lib/load";
import { renderCloudMarkdown } from "@/lib/markdown";
import { isCloud } from "@/lib/platforms";

/** One cloud's services as Markdown; `proxy.ts` rewrites `/<cloud>` here for agents. */
const HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "content-language": "en",
  "cache-control": "public, max-age=300",
  vary: "accept",
};

export async function GET(_request: Request, { params }: { params: Promise<{ cloud: string }> }) {
  const { cloud } = await params;
  if (!isCloud(cloud)) {
    return new Response(`# Not found\n\nThere is no cloud called ${cloud} here.\n`, {
      status: 404,
      headers: HEADERS,
    });
  }
  const body = renderCloudMarkdown(cloud, await loadIndex(cloud), await getTranslator("en"));
  return new Response(body, { headers: HEADERS });
}
