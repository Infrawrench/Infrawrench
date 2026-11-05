import { ORIGIN } from "./sitemap";

/**
 * X Player Cards: a page names an HTML player in `twitter:player`, and X loads
 * it in a sandboxed iframe inside the post on the web, or in a web popup on
 * mobile. The players live under `/embed/<locale>/...`, outside the site's
 * layout and `proxy.ts`, and next.config.ts allows X to frame only those.
 *
 * X publishes no current documentation for this, so what the sandbox allows is
 * as observed: no forms, no top-level navigation, no downloads. Everything that
 * needs one of those opens the full page in a new tab.
 */

/** The player's size as advertised to X. */
const PLAYER_WIDTH = 640;
const PLAYER_HEIGHT = 480;

/**
 * Instance pages advertising the player. X decides per domain whether to honor
 * it, and the pricing sync posts these pages' links, so it spreads one page at
 * a time until a real post has been seen working.
 */
const PLAYER_CARD_INSTANCES: ReadonlySet<string> = new Set(["/aws/ec2/m5.large"]);

export function instanceHasPlayerCard(path: string): boolean {
  return PLAYER_CARD_INSTANCES.has(path);
}

/** A site path's player: always locale-prefixed, since `proxy.ts` does not route `/embed`. */
export function embedPath(locale: string, path: string): string {
  return `/embed/${locale}${path}`;
}

/**
 * The `other` metadata for a page's player. Not `twitter.players`: that requires
 * a `streamUrl` and always renders `twitter:player:stream`, for a video stream
 * these players do not have.
 */
export function playerCardTags(locale: string, path: string): Record<string, string> {
  return {
    "twitter:player": `${ORIGIN}${embedPath(locale, path)}`,
    "twitter:player:width": String(PLAYER_WIDTH),
    "twitter:player:height": String(PLAYER_HEIGHT),
  };
}

export type EmbedKind = "instance" | "view";

/** The download dialog on infrawrench.com, tagged so a visit there is traceable to the embed. */
export function getInfrawrenchUrl(kind: EmbedKind): string {
  const q = new URLSearchParams({
    utm_source: "x",
    utm_medium: "player_card",
    utm_campaign: "instances_embed",
    utm_content: kind,
  });
  return `https://infrawrench.com/?${q}#download`;
}

/** `frame-ancestors` for the players; in next.config.ts because only a header can carry it. */
export const EMBED_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com";
