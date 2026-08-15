import type { APIRoute } from "astro";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  if (!site) {
    throw new Error("`site` must be set in astro.config.mjs to build robots.txt");
  }

  // `/api/` is the releases proxy and update feed — machine endpoints, not content.
  //
  // The `llms.txt` line is a comment because it is not part of the robots
  // grammar and an unknown directive is a parse risk for something. A comment
  // is read by the audience that matters here — anything reading robots.txt to
  // decide how to approach the site is already reading the file, and this is
  // the cheapest place to say "there is a markdown index".
  const body = `User-agent: *
Allow: /
Disallow: /api/

# Every page here is also available as markdown: send an Accept: text/markdown
# header, or append .md to any path. Start at ${new URL("/llms.txt", site).href}
# Agents can register for a trial workspace without a human — see /llms.txt.

Sitemap: ${new URL("/sitemap.xml", site).href}
`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
