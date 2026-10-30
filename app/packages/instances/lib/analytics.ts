import { initAnalytics } from "@infrawrench/analytics";

/** Browser-only; a no-op during SSR and without a key. */
export function startAnalytics(): void {
  initAnalytics({
    key: import.meta.env.VITE_POSTHOG_KEY,
    host: import.meta.env.VITE_POSTHOG_HOST,
  });
}
