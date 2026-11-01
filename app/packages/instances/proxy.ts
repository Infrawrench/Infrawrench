import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, localePath } from "@/lib/i18n/locales";
import { prefersMarkdown } from "@/lib/negotiate";

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
 * Markdown for agents: the home page (`/`) and the service list (`/aws`), a
 * service (`/aws/ec2`) or an instance (`/aws/ec2/m5.large`) requested with
 * `Accept: text/markdown` (preferred over `text/html`), or with `.md`
 * appended (`/index.md` for the home page), is rewritten to the matching
 * `/api/markdown/...` route. The home page is the chat, which has no Markdown
 * form, so agents get the service list there too.
 *
 * Localized sections: `aws`, `chat` (conversations), `v` (shared chat views)
 * and `alerts` (email alert links) are page trees under `[locale]`; anything
 * else passes through.
 */
const SECTIONS = ["aws", "v", "alerts", "chat"];

export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === DEFAULT_LOCALE) {
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
  if (
    page.length === 0 ||
    (page.length === 1 && (page[0] === "index.md" || page[0] === "aws" || page[0] === "aws.md"))
  )
    markdown = "/api/markdown";
  else if (page[0] === "aws" && page.length === 2)
    markdown = `/api/markdown/aws/${strip(page[1]!)}`;
  else if (page[0] === "aws" && page.length === 3) {
    markdown = `/api/markdown/aws/${page[1]}/${strip(page[2]!)}`;
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
    "/aws",
    "/aws.md",
    "/aws/:path*",
    "/v/:path*",
    "/alerts/:path*",
    "/chat/:path*",
    "/en",
    "/en/:path*",
    "/:locale",
    "/:locale/index.md",
    "/:locale/aws.md",
    "/:locale/aws/:path*",
    "/:locale/v/:path*",
    "/:locale/alerts/:path*",
    "/:locale/chat/:path*",
  ],
};
