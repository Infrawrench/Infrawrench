import type { APIRoute } from "astro";
import { blogPostHref, getBlogPosts } from "../../lib/blog";
import { escapeXml } from "../../lib/xml";

/**
 * `/blog/rss.xml`: RSS 2.0, hand-rolled for the same reason the sitemap is.
 * Items carry the description rather than the rendered body; a reader that
 * wants the full post follows the link. Guides are left out: the feed is for
 * news, and a reference page is not something to push to subscribers.
 */
export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  if (!site) {
    throw new Error("`site` must be set in astro.config.mjs to build the RSS feed");
  }

  const posts = await getBlogPosts("post");
  const blogUrl = new URL("/blog", site).href;
  const feedUrl = new URL("/blog/rss.xml", site).href;

  const items = posts
    .map((post) => {
      const link = new URL(blogPostHref(post.id), site).href;
      const author = post.data.author
        ? `\n      <dc:creator>${escapeXml(post.data.author)}</dc:creator>`
        : "";
      return `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${post.data.date.toUTCString()}</pubDate>
      <description>${escapeXml(post.data.description)}</description>${author}
    </item>`;
    })
    .join("\n");

  const lastBuild = posts[0]
    ? `\n    <lastBuildDate>${posts[0].data.date.toUTCString()}</lastBuildDate>`
    : "";

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Infrawrench blog</title>
    <link>${escapeXml(blogUrl)}</link>
    <description>Product news, release notes and engineering write-ups from the Infrawrench team.</description>
    <language>en</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />${lastBuild}
${items}
  </channel>
</rss>
`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
