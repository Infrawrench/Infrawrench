/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** PostHog project API key (phc_…), inlined at build time. Unset turns analytics off. */
  readonly PUBLIC_POSTHOG_KEY?: string;
  /** PostHog ingestion host; defaults to the hedgehogs.infrawrench.com reverse proxy. */
  readonly PUBLIC_POSTHOG_HOST?: string;
}

declare namespace Cloudflare {
  interface Env {
    /** Optional: raises the GitHub rate limit. The repo is public, so calls work without it. */
    GITHUB_TOKEN?: string;
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
  }
}

interface Env extends Cloudflare.Env {}

interface CacheStorage {
  readonly default: Cache;
}
