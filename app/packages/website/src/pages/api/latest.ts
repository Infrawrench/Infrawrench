import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { withEdgeCache } from "../../lib/cache";
import {
  classifyAsset,
  fetchLatestRelease,
  versionFromTag,
  type PlatformKey,
} from "../../lib/github";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  return withEdgeCache(request, locals.cfContext, async () => {
    const release = await fetchLatestRelease(env);
    const version = versionFromTag(release.tag_name);

    const downloadUrl = (filename: string) =>
      `/api/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`;

    const downloads: Partial<Record<PlatformKey, string>> = {};
    const assets = release.assets.map((a) => {
      const key = classifyAsset(a.name);
      const url = downloadUrl(a.name);
      if (key && !downloads[key]) downloads[key] = url;
      return {
        name: a.name,
        size: a.size,
        contentType: a.content_type,
        url,
      };
    });

    const body = {
      version,
      publishedAt: release.published_at,
      notes: release.body,
      downloads,
      assets,
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });
  });
};
