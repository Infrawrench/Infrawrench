import { describe } from "@/lib/describe";
import { getTranslator } from "@/lib/i18n/server";
import { loadDecoded, loadInstance } from "@/lib/load";
import { renderMarkdown } from "@/lib/markdown";
import { buildRegionData, findRegion } from "@/lib/model";

/**
 * An instance page as Markdown. Not linked directly: `proxy.ts` rewrites an
 * instance URL here when the request prefers `text/markdown` or the path ends
 * in `.md`, so agents read the same URL people do. `?region=<code>` picks the
 * region whose full history is included.
 */
const HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "content-language": "en",
  "cache-control": "public, max-age=300",
  vary: "accept",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ platform: string; instance: string }> },
) {
  const { platform, instance } = await params;
  const name = decodeURIComponent(instance);
  const [model, decoded, tr] = await Promise.all([
    loadInstance(platform, name),
    loadDecoded(platform, name),
    getTranslator("en"),
  ]);
  if (!model || !decoded) {
    return new Response(`# Not found\n\nThere is no ${platform} instance type named ${name}.\n`, {
      status: 404,
      headers: HEADERS,
    });
  }

  const regionId = new URL(request.url).searchParams.get("region");
  const region = regionId ? findRegion(model.regions, regionId) : model.defaultRegion;
  if (region < 0) {
    return new Response(`# Not found\n\n${name} has never been priced in ${regionId}.\n`, {
      status: 404,
      headers: HEADERS,
    });
  }
  const data = region === model.defaultRegion ? model.regionData : buildRegionData(decoded, region);
  const body = renderMarkdown(model, data, {
    description: describe(model, tr, "en"),
    pageUrl: `https://instances.infrawrench.com/aws/${model.platform}/${model.name}`,
    tr,
  });
  return new Response(body, { headers: HEADERS });
}
