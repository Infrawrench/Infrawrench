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
    /** The chat's saved views (`view:<id>`), email alerts (`alert:<id>`) and their snapshots. */
    INSTANCES_CHAT: KVNamespace;
    /** Per-IP limits on chat turns and on alert sign-ups (which send email). */
    CHAT_LIMITER?: RateLimit;
    ALERT_LIMITER?: RateLimit;
    /** The AWS pricing warehouse's ClickHouse HTTP endpoint (a var). */
    PRICING_WAREHOUSE_URL?: string;
    /** A read-only token for it (a secret). */
    PRICING_WAREHOUSE_READ_TOKEN?: string;
    /** Workers AI binding; the chat calls Claude through it (lib/chat/agent.ts). */
    AI: Ai;
    /** The AI Gateway the chat's requests go through (a var). */
    AI_GATEWAY_ID?: string;
    /** Local development only: call this Anthropic-compatible URL with ANTHROPIC_API_KEY instead of the binding. */
    AI_GATEWAY_URL?: string;
    ANTHROPIC_API_KEY?: string;
    /** Bearer for POST /api/internal/notify, shared with the sync workflow (a secret). */
    NOTIFY_SECRET?: string;
    /** Mailgun, read by @infrawrench/server-core/email through process.env. */
    MAILGUN_API_KEY?: string;
    MAILGUN_DOMAIN?: string;
    EMAIL_FROM?: string;
  }
}
