interface ImportMetaEnv {
  /** PostHog project API key (phc_…), inlined at build time. Unset turns analytics off. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingestion host; defaults to US Cloud. */
  readonly VITE_POSTHOG_HOST?: string;
}

declare namespace Cloudflare {
  interface Env {
    /** AWS bulk pricing data, written by .github/workflows/aws-bulk-pricing-sync.yml. */
    AWS_BULK_PRICING: KVNamespace;
  }
}
