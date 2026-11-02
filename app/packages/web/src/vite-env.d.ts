/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** General Translation project id: dev-only live machine translation. */
  readonly VITE_GT_PROJECT_ID?: string;
  /** General Translation development API key (gtx-dev-…), never a production key. */
  readonly VITE_GT_DEV_API_KEY?: string;
  /** PostHog project API key (phc_…). Unset turns analytics off entirely. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingestion host; defaults to the hedgehogs.infrawrench.com reverse proxy. */
  readonly VITE_POSTHOG_HOST?: string;
}
