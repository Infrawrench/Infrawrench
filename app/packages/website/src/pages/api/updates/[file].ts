import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { withEdgeCache } from "../../../lib/cache";
import { fetchAssetStream, fetchLatestRelease } from "../../../lib/github";

export const prerender = false;

const ALLOWED = new Set([
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
]);

export const GET: APIRoute = async ({ params, request, locals }) => {
  const file = params.file ?? "";
  if (!ALLOWED.has(file)) {
    return new Response("Not found", { status: 404 });
  }

  return withEdgeCache(request, locals.cfContext, async () => {
    const release = await fetchLatestRelease(env);
    const asset = release.assets.find((a) => a.name === file);
    if (!asset) {
      return new Response("Not found", { status: 404 });
    }

    const upstream = await fetchAssetStream(env, asset.id);
    if (!upstream.ok) {
      return new Response("Upstream error", { status: 502 });
    }

    const original = await upstream.text();
    const prefix = `../download/${release.tag_name}/`;
    const rewritten = original.replace(
      /^(\s*-?\s*(?:url|path):\s*)(\S.*)$/gm,
      (_match, head: string, value: string) => `${head}${prefix}${value.trim()}`,
    );

    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/x-yaml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });
  });
};
