import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { withEdgeCache } from "../../../../lib/cache";
import { fetchAssetStream, fetchReleaseByTag, GhError } from "../../../../lib/github";

export const prerender = false;

const VERSION_RE = /^v\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;
const FILENAME_RE = /^[A-Za-z0-9._-]+$/;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const version = params.version ?? "";
  const filename = params.filename ?? "";

  if (!VERSION_RE.test(version) || !FILENAME_RE.test(filename)) {
    return new Response("Not found", { status: 404 });
  }

  return withEdgeCache(request, locals.cfContext, async () => {
    let asset;
    try {
      const release = await fetchReleaseByTag(env, version);
      asset = release.assets.find((a) => a.name === filename);
    } catch (err) {
      if (err instanceof GhError && err.status === 404) {
        return new Response("Not found", { status: 404 });
      }
      throw err;
    }
    if (!asset) {
      return new Response("Not found", { status: 404 });
    }

    const upstream = await fetchAssetStream(env, asset.id);
    if (!upstream.ok || !upstream.body) {
      return new Response("Upstream error", { status: 502 });
    }

    const headers = new Headers();
    const upstreamType = upstream.headers.get("Content-Type");
    headers.set("Content-Type", upstreamType ?? asset.content_type ?? "application/octet-stream");
    const upstreamLen = upstream.headers.get("Content-Length");
    if (upstreamLen) headers.set("Content-Length", upstreamLen);
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(upstream.body, { status: 200, headers });
  });
};
