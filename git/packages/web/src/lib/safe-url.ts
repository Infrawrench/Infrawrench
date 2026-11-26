/**
 * The one check every URL from data goes through before it becomes an `href`
 * or a `src`: a profile's website, a repository's homepage, a status's
 * details link, an avatar, a link or image in Markdown.
 *
 * A link may go to a path on this site or to an `http:` or `https:` address
 * (and to `mailto:` where the caller allows it); an image may come from this
 * site or from an `http:` or `https:` address, which {@link imageSrc} sends
 * through the image proxy. Everything else (`javascript:`, `data:`, `vbscript:`,
 * `file:`, a scheme spelt with tabs or entities) is refused, and the caller
 * shows the text without a link or the alt text without an image.
 */

import { imageProxyPath } from "@infrawrench/git-contract";

/** Characters a browser strips from a URL or reads in surprising ways. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Any origin works as the base: only whether a relative URL leaves it matters. */
const BASE = "https://same-origin.invalid/a/b/";
const BASE_ORIGIN = "https://same-origin.invalid";

/**
 * `value` when it is a path on this site (`/acme/infra`, `/x?y#z`), else
 * null. `//host` and `/\host` are another origin to a browser, and a tab or
 * newline inside the URL is dropped before it is read (`/\t/host`), so all
 * three are refused.
 */
export function sitePath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  if (value.startsWith("//") || value.includes("\\") || CONTROL.test(value)) return null;
  return sameOrigin(value) ? value : null;
}

function sameOrigin(value: string): boolean {
  try {
    return new URL(value, BASE).origin === BASE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * A relative reference that stays on this site: a path, `#anchor`, `?query`
 * or `docs/a.md`. Null for anything with a scheme or a host.
 */
export function relativeUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (HAS_SCHEME.test(value) || value.includes("\\") || CONTROL.test(value)) return null;
  if (value.startsWith("//")) return null;
  return sameOrigin(value) ? value : null;
}

/** An absolute `http:` or `https:` URL, normalised, or null. */
export function webUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || CONTROL.test(value) || !HAS_SCHEME.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** True for an absolute URL to another site (it gets `rel="noopener noreferrer"`). */
export const isExternalUrl = (value: string): boolean => webUrl(value) !== null;

export interface LinkOptions {
  /** Allow `mailto:` (Markdown links). */
  readonly mailto?: boolean;
}

/** Where a link may go: a reference on this site or a web address. Null otherwise. */
export function safeLinkUrl(
  value: string | null | undefined,
  options: LinkOptions = {},
): string | null {
  const relative = relativeUrl(value);
  if (relative !== null) return relative;
  const web = webUrl(value);
  if (web !== null) return web;
  if (options.mailto === true && typeof value === "string" && !CONTROL.test(value)) {
    if (/^mailto:/i.test(value)) return value;
  }
  return null;
}

/**
 * Where an image may load from: this site, or an `http:` or `https:`
 * address. No `data:` (an SVG document in a data URL is still a document).
 * Put an address through {@link imageSrc} before it becomes a `src`.
 */
export function safeImageUrl(value: string | null | undefined): string | null {
  const relative = relativeUrl(value);
  if (relative !== null) return relative;
  return webUrl(value);
}

/** The mock API answers in the browser, with no Worker behind it to fetch images. */
const PROXIED = import.meta.env.VITE_GIT_MOCK !== "1";

/**
 * The `src` for an image: a reference on this site as it is, an image from
 * another site through the Worker (`/-/image?url=`), so its host sees
 * Cloudflare and never the reader. The page's policy refuses images from
 * anywhere else, so every `<img>` with a `src` from data goes through here.
 * Null for what {@link safeImageUrl} refuses.
 */
export function imageSrc(value: string | null | undefined): string | null {
  const safe = safeImageUrl(value);
  if (safe === null) return null;
  return PROXIED && webUrl(safe) !== null ? imageProxyPath(safe) : safe;
}
