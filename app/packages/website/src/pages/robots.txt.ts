import type { APIRoute } from "astro";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  if (!site) {
    throw new Error("`site` must be set in astro.config.mjs to build robots.txt");
  }

  // `/api/` is the releases proxy and update feed — machine endpoints, not content.
  const body = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${new URL("/sitemap.xml", site).href}
`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
