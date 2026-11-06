import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localePath } from "@/lib/i18n/locales";
import { prefersMarkdown } from "@/lib/negotiate";
import { CLOUD_IDS } from "@/lib/platforms";

/**
 * Request-time routing, run in the uncached entrypoint before Workers Cache
 * (so cached pages never vary by cookie or `Accept`).
 *
 * Locales (see `lib/i18n/locales.ts`): pages live under `app/[locale]`;
 * English is served at the unprefixed URLs by rewriting them onto `/en/...`,
 * and `/en/...` itself redirects to the unprefixed URL so each page has one
 * address. A visitor who picked a language (the `instances-locale` cookie)
 * is sent from an English URL to theirs; first-time visitors and crawlers are
 * not redirected, so a shared link opens in the language it was shared in.
 *
 * Markdown for agents: the home page (`/`), a cloud's service list (`/aws`),
 * a service (`/aws/ec2`) or an instance (`/aws/ec2/m5.large`) requested with
 * `Accept: text/markdown` (preferred over `text/html`), or with `.md`
 * appended (`/index.md` for the home page), is rewritten to the matching
 * `/api/markdown/...` route. The home page is the chat, which has no Markdown
 * form, so agents get every cloud's services there instead.
 *
 * Localized sections: each cloud (`aws`, `azure`, `gcp`, `alibaba`, `oracle`, `ibm`, `hetzner`, `ovh`, `runpod`; see
 * `lib/platforms.ts`), `chat` (conversations), `v` (shared chat views) and
 * `alerts` (email alert links) are page trees under `[locale]`; anything
 * else passes through.
 */
const CLOUD_SECTIONS: readonly string[] = CLOUD_IDS;
const SECTIONS = [...CLOUD_SECTIONS, "v", "alerts", "chat"];

export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === DEFAULT_LOCALE) {
    // The metadata names share cards under `/en`; serve them there, because a
    // crawler fetching an image should not have to follow a redirect to it.
    if (segments.at(-1) === "opengraph-image") return NextResponse.next();
    const target = url.clone();
    target.pathname = url.pathname.slice(DEFAULT_LOCALE.length + 1) || "/";
    return NextResponse.redirect(target, 308);
  }

  const prefixed = !SECTIONS.includes(segments[0] ?? "") && isLocale(segments[0] ?? "");
  const locale = prefixed ? segments[0]! : DEFAULT_LOCALE;
  const page = prefixed ? segments.slice(1) : segments;

  // Which of the negotiable pages this is, and its Markdown route.
  let markdown: string | undefined;
  const md = page.at(-1)?.endsWith(".md") ?? false;
  const strip = (s: string) => (md ? s.slice(0, -3) : s);
  const cloud = CLOUD_SECTIONS.find((c) => page[0] === c || page[0] === `${c}.md`);
  if (page.length === 0 || (page.length === 1 && page[0] === "index.md"))
    markdown = "/api/markdown";
  else if (cloud && page.length === 1) markdown = `/api/markdown/${cloud}`;
  else if (cloud && page.length === 2) markdown = `/api/markdown/${cloud}/${strip(page[1]!)}`;
  else if (cloud && page.length === 3) {
    markdown = `/api/markdown/${cloud}/${page[1]}/${strip(page[2]!)}`;
  } else if (!SECTIONS.includes(page[0] ?? "")) {
    return NextResponse.next();
  }

  if (markdown && (md || prefersMarkdown(request.headers.get("accept")))) {
    const target = url.clone();
    target.pathname = markdown;
    return NextResponse.rewrite(target);
  }

  let response: NextResponse;
  if (prefixed) {
    response = NextResponse.next();
  } else {
    const chosen = request.cookies.get(LOCALE_COOKIE)?.value;
    if (chosen && chosen !== DEFAULT_LOCALE && isLocale(chosen)) {
      const target = url.clone();
      target.pathname = localePath(chosen, url.pathname);
      return NextResponse.redirect(target, 307);
    }
    const target = url.clone();
    target.pathname = `/${DEFAULT_LOCALE}${url.pathname === "/" ? "" : url.pathname}`;
    response = NextResponse.rewrite(target);
  }
  // The same URL answers HTML or Markdown depending on Accept.
  if (markdown) response.headers.set("vary", "accept");
  return response;
}

export const config = {
  matcher: [
    "/",
    "/index.md",
    // One block per cloud in lib/platforms.ts: Next reads `config` statically,
    // so it cannot be built from CLOUD_IDS.
    "/aws",
    "/aws.md",
    "/aws/:path*",
    "/azure",
    "/azure.md",
    "/azure/:path*",
    "/gcp",
    "/gcp.md",
    "/gcp/:path*",
    "/alibaba",
    "/alibaba.md",
    "/alibaba/:path*",
    "/oracle",
    "/oracle.md",
    "/oracle/:path*",
    "/ibm",
    "/ibm.md",
    "/ibm/:path*",
    "/hetzner",
    "/hetzner.md",
    "/hetzner/:path*",
    "/ovh",
    "/ovh.md",
    "/ovh/:path*",
    "/runpod",
    "/runpod.md",
    "/runpod/:path*",
    "/v/:path*",
    "/alerts/:path*",
    "/chat/:path*",
    "/en",
    "/en/:path*",
    "/:locale",
    "/:locale/index.md",
    "/:locale/aws.md",
    "/:locale/aws/:path*",
    "/:locale/azure.md",
    "/:locale/azure/:path*",
    "/:locale/gcp.md",
    "/:locale/gcp/:path*",
    "/:locale/alibaba.md",
    "/:locale/alibaba/:path*",
    "/:locale/oracle.md",
    "/:locale/oracle/:path*",
    "/:locale/ibm.md",
    "/:locale/ibm/:path*",
    "/:locale/hetzner.md",
    "/:locale/hetzner/:path*",
    "/:locale/ovh.md",
    "/:locale/ovh/:path*",
    "/:locale/runpod.md",
    "/:locale/runpod/:path*",
    "/:locale/v/:path*",
    "/:locale/alerts/:path*",
    "/:locale/chat/:path*",
  ],
};
