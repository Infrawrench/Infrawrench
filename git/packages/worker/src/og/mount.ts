/**
 * Link previews: the tags in a page's shell and the image they name.
 * `src/index.ts` wires the two (`Routes.page`, `Routes.ogImage`) and loads
 * this module on first use.
 *
 * Both read a page as a signed-out visitor (`./lookup.ts`), whoever is
 * asking, and both fall back to the site's own preview: for the site's
 * pages and a signed-in person's, for anything private or missing (the
 * same bytes for both), and whenever the lookup fails, is slow or the
 * caller is past its read budget. A page is never refused or slowed past
 * {@link LOOKUP_TIMEOUT_MS} for its preview.
 *
 * What a page shows is kept at the edge for {@link FACTS_SECONDS}, so a
 * crawler's burst costs one lookup; a drawn image is kept by its version,
 * which is a hash of what it draws (`./meta.ts` `cardVersion`).
 */
import { OG_IMAGE_PATH } from "@infrawrench/git-contract";
import type { Ctx } from "../http/router";
import { admissionFor } from "../http/admission";
import { describeError } from "../http/log";
import { type Env, siteOrigin } from "../env";
import { withDb } from "../db/client";
import { repoReaderFor } from "../repo/select";
import { cardImageUrls, cardNode } from "./card";
import type { OgFacts } from "./facts";
import { cardImages } from "./images";
import { lookupFacts } from "./lookup";
import { cardOf, cardVersion, pageMeta } from "./meta";
import { type OgCardPage, type OgPage, pageOf } from "./pages";
import { type Rewriter, rewriteShell, shellEdits } from "./shell";

/** How long a page waits for its preview's lookup before it goes out with the site's. */
export const LOOKUP_TIMEOUT_MS = 1500;
/** How long what a page shows is kept at the edge. */
export const FACTS_SECONDS = 120;
/** How long a drawn image is kept at the edge, by its version. */
export const IMAGE_SECONDS = 7 * 24 * 60 * 60;
/** The same, for one drawn without a picture it should have had (it may come back). */
export const IMAGE_SECONDS_INCOMPLETE = 60 * 60;

/** What a browser or a crawler may keep an image for: long when the version asked for is the one drawn. */
export const imageCacheControl = (current: boolean): string =>
  current ? "public, max-age=86400" : "public, max-age=300";

const needsLookup = (page: OgPage): boolean =>
  page.kind !== "home" && page.kind !== "explore" && page.kind !== "generic";

const openCache = async (): Promise<Cache | null> => {
  try {
    return typeof caches === "undefined" ? null : await caches.open("og");
  } catch {
    return null;
  }
};

const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Looks a page's facts up. A test passes its own; the Worker's reads Postgres and the storage. */
export type FactsLookup = (page: OgPage, env: Env, ctx: Ctx) => Promise<OgFacts | null>;

const lookup: FactsLookup = (page, env, ctx) =>
  withDb(env, ctx, () => lookupFacts(page, { env, reader: repoReaderFor }));

/**
 * What `page` shows a signed-out visitor, from the edge cache or a lookup.
 * Null for nothing to show, and for a lookup that failed or took too long
 * (which is not kept, so the next request tries again).
 */
export async function factsFor(
  page: OgPage,
  env: Env,
  ctx: Ctx,
  find: FactsLookup = lookup,
): Promise<OgFacts | null> {
  if (!needsLookup(page)) return null;
  const cache = await openCache();
  const key = `${siteOrigin(env)}${OG_IMAGE_PATH}/facts?page=${encodeURIComponent(JSON.stringify(page))}`;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    try {
      return ((await hit.json()) as { facts: OgFacts | null }).facts;
    } catch {
      // A damaged entry is looked up again.
    }
  }
  let facts: OgFacts | null;
  try {
    facts = await timeout(find(page, env, ctx), LOOKUP_TIMEOUT_MS);
  } catch (error) {
    console.warn(`[git] link preview lookup failed: ${describeError(error)}`);
    return null;
  }
  if (cache) {
    const entry = new Response(JSON.stringify({ facts }), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${FACTS_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(key, entry).catch(() => undefined));
  }
  return facts;
}

const htmlRewriter = (): Rewriter =>
  new (globalThis as unknown as { HTMLRewriter: new () => Rewriter }).HTMLRewriter();

/**
 * A page's shell with its tags. The caller is counted against the read
 * budget of a signed-out visitor at its address (`http/admission.ts`): past
 * it, the page still loads, with the site's tags.
 */
export async function pageFetch(
  request: Request,
  env: Env,
  ctx: Ctx,
  shell: Response,
  options: { readonly find?: FactsLookup; readonly rewriter?: () => Rewriter } = {},
): Promise<Response> {
  let edits;
  try {
    const url = new URL(request.url);
    const page = pageOf(url.pathname);
    let facts: OgFacts | null = null;
    if (needsLookup(page)) {
      const address = request.headers.get("cf-connecting-ip");
      const counted = new Request(`${url.origin}${url.pathname}`, {
        headers: address === null ? {} : { "cf-connecting-ip": address },
      });
      const refused = await admissionFor(env)
        .refuse(counted)
        .catch(() => null);
      if (refused === null) facts = await factsFor(page, env, ctx, options.find);
    }
    edits = shellEdits(await pageMeta(page, facts, siteOrigin(env)));
  } catch (error) {
    console.warn(`[git] link preview tags failed: ${describeError(error)}`);
    return shell;
  }
  return rewriteShell(shell, edits, (options.rewriter ?? htmlRewriter)());
}

const VERSION = /^[0-9a-f]{16}$/;

/**
 * `/-/og/<version>[/<page path>]` as the version asked for and the page,
 * or null when it is no card's address: a page with no card of its own (a
 * repository's tab, a signed-in person's page) has none.
 */
export function parseOgImagePath(
  pathname: string,
): { readonly version: string; readonly page: OgCardPage } | null {
  if (!pathname.startsWith(`${OG_IMAGE_PATH}/`)) return null;
  const rest = pathname.slice(OG_IMAGE_PATH.length + 1);
  const slash = rest.indexOf("/");
  const version = slash === -1 ? rest : rest.slice(0, slash);
  if (!VERSION.test(version)) return null;
  const page = pageOf(slash === -1 ? "/" : rest.slice(slash));
  switch (page.kind) {
    case "home":
    case "namespace":
    case "commit":
    case "issue":
    case "branch":
      return { version, page };
    case "repository":
      return page.section === null && page.path === null ? { version, page } : null;
    default:
      return null;
  }
}

const notFound = (): Response =>
  new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

export interface ImageRouteOptions {
  readonly find?: FactsLookup;
  /** Draws a card. The Worker's loads the renderer and its WebAssembly on first use. */
  readonly draw?: (
    card: ReturnType<typeof cardOf>["card"],
    env: Env,
  ) => Promise<{
    readonly png: Uint8Array;
    readonly complete: boolean;
  }>;
}

const draw: NonNullable<ImageRouteOptions["draw"]> = async (card, env) => {
  const [{ renderCard }, { workerAssets }] = await Promise.all([
    import("./render"),
    import("./assets"),
  ]);
  const origin = siteOrigin(env);
  const urls = cardImageUrls(card);
  const images = await cardImages(urls, {
    fetch: (input, init) => fetch(input, init),
    siteHosts: [new URL(origin).hostname],
    assets: env.ASSETS,
    origin,
  });
  return {
    png: await renderCard(cardNode(card, images), workerAssets),
    complete: images.size === new Set(urls).size,
  };
};

/**
 * `/-/og/...`: the card of the page in the path, drawn as it is now for a
 * signed-out visitor, whatever version was asked for. A private page and a
 * missing one are both the site's card, the same bytes and headers.
 */
export async function ogImageFetch(
  request: Request,
  env: Env,
  ctx: Ctx,
  options: ImageRouteOptions = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const parsed = parseOgImagePath(new URL(request.url).pathname);
  if (parsed === null) return notFound();
  const facts = await factsFor(parsed.page, env, ctx, options.find);
  const { card } = cardOf(facts);
  const version = await cardVersion(card);
  const headers = {
    "content-type": "image/png",
    "cache-control": imageCacheControl(version === parsed.version),
    "x-content-type-options": "nosniff",
  };

  const cache = await openCache();
  const key = `${siteOrigin(env)}${OG_IMAGE_PATH}/png/${version}`;
  const hit = await cache?.match(key).catch(() => undefined);
  let png: ArrayBuffer;
  if (hit) {
    png = await hit.arrayBuffer();
  } else {
    const drawn = await (options.draw ?? draw)(card, env);
    png = drawn.png.slice().buffer;
    if (cache) {
      const keep = drawn.complete ? IMAGE_SECONDS : IMAGE_SECONDS_INCOMPLETE;
      const entry = new Response(png, {
        headers: { "content-type": "image/png", "cache-control": `public, max-age=${keep}` },
      });
      ctx.waitUntil(cache.put(key, entry).catch(() => undefined));
    }
  }
  return new Response(request.method === "HEAD" ? null : png, {
    status: 200,
    headers: { ...headers, "content-length": String(png.byteLength) },
  });
}
