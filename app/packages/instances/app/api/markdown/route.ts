import { getTranslator } from "@/lib/i18n/server";
import { loadIndex } from "@/lib/load";
import { renderIndexMarkdown } from "@/lib/markdown";

/** The index as Markdown; `proxy.ts` rewrites `/` here for agents (see there). */
export async function GET() {
  const body = renderIndexMarkdown(await loadIndex(), await getTranslator("en"));
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-language": "en",
      "cache-control": "public, max-age=300",
      vary: "accept",
    },
  });
}
