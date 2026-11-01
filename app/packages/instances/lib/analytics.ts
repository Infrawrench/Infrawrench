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
