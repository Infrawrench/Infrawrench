/**
 * The pictures a card shows (avatars), fetched for the renderer as data
 * URLs. The image proxy's rules (`images/proxy.ts`): only a public address
 * (`imageSource`, checked again at every redirect), nothing of anyone's
 * sent with it, and only an image. Narrower than the proxy in two ways: a
 * picture must be PNG, JPEG or GIF (what the renderer draws; an SVG from
 * another site is never drawn), and it must arrive small and quickly, or
 * the card goes without it and shows initials.
 *
 * A picture of this site's own (a bot's, `/assets/bots/...`) is read from
 * the built UI instead.
 */
import type { Fetcher } from "@cloudflare/workers-types/index";
import { imageSource } from "../images/proxy";

export const CARD_IMAGE_LIMITS = {
  maxBytes: 1024 * 1024,
  timeoutMs: 2500,
  maxRedirects: 3,
} as const;

const REMOTE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const OWN_TYPES = new Set([...REMOTE_TYPES, "image/svg+xml"]);

const USER_AGENT = "infrawrench-git-images (+https://git.infrawrench.com)";

export interface CardImageOptions {
  /** Fetches another site: the Worker's `fetch`, or a fake in tests. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** This site's hosts: never fetched as another site. */
  readonly siteHosts: readonly string[];
  /** The built UI, for this site's own pictures. */
  readonly assets?: Pick<Fetcher, "fetch"> | undefined;
  readonly origin: string;
}

const mediaType = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
};

/** The body, or null past `maxBytes`. */
const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array | null> => {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const asDataUrl = async (
  response: Response,
  types: ReadonlySet<string>,
): Promise<string | null> => {
  const type = mediaType(response);
  if (!response.ok || !types.has(type)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readCapped(response, CARD_IMAGE_LIMITS.maxBytes);
  return bytes === null || bytes.length === 0 ? null : `data:${type};base64,${base64(bytes)}`;
};

/** One of this site's own pictures (`/assets/...`), from the built UI. */
const ownImage = async (path: string, options: CardImageOptions): Promise<string | null> => {
  if (!/^\/assets\/[A-Za-z0-9/_.-]+$/.test(path) || path.includes("..") || !options.assets) {
    return null;
  }
  const response = (await options.assets.fetch(
    new Request(`${options.origin}${path}`) as never,
  )) as unknown as Response;
  return asDataUrl(response, OWN_TYPES);
};

/** A picture from another site, by the image proxy's address rules. */
const remoteImage = async (url: string, options: CardImageOptions): Promise<string | null> => {
  let source = imageSource(url, options.siteHosts);
  if (source === null) return null;
  const signal = AbortSignal.timeout(CARD_IMAGE_LIMITS.timeoutMs);
  for (let hop = 0; hop <= CARD_IMAGE_LIMITS.maxRedirects; hop++) {
    const response = await options.fetch(source.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "image/png,image/jpeg;q=0.9,image/gif;q=0.8", "user-agent": USER_AGENT },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 3600, "300-599": 0 } },
    } as RequestInit);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      source = imageSource(location, options.siteHosts, source.href);
      if (source === null) return null;
      continue;
    }
    return asDataUrl(response, REMOTE_TYPES);
  }
  return null;
};

/**
 * Each of `urls` as a data URL, by its address. One that cannot be had (not
 * public, not an image the renderer draws, too large, too slow, gone) is
 * left out, and the card draws initials in its place.
 */
export async function cardImages(
  urls: readonly string[],
  options: CardImageOptions,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const data = await (
        url.startsWith("/") ? ownImage(url, options) : remoteImage(url, options)
      ).catch(() => null);
      if (data !== null) found.set(url, data);
    }),
  );
  return found;
}
