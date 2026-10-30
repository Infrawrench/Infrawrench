import { ORIGIN } from "@/lib/sitemap";

/** GET /robots.txt: every crawler may read everything; the sitemap lists the pages. */
export function GET() {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
