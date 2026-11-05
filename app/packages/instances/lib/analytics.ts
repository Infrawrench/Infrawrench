import { initAnalytics } from "@infrawrench/analytics";

/** `/alerts/<id>` carries the alert's only credential; it never reaches PostHog. */
export function redactUrl(url: string): string {
  return url.replace(/(\/alerts\/)[0-9A-Za-z]+/, "$1:id");
}

/** Browser-only; a no-op during SSR and without a key. */
export function startAnalytics(): void {
  initAnalytics({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
    redactUrl,
  });
}

/**
 * The X Player Card embeds, which sit inside someone else's page and show no
 * consent prompt: PostHog stores nothing and records no session, for anyone.
 * `framed` tells a card playing in the post from the popup X opens on mobile.
 */
export function startEmbedAnalytics(): void {
  initAnalytics({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
    redactUrl,
    cookieless: true,
    properties: { surface: "x_player_card", framed: window.self !== window.top },
  });
}
