import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { StripeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { policyTemplate, preflight } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { stripeTerraformExport } from "./terraform.js";

export const manifest = {
  id: "stripe",
  egressHosts: ["api.stripe.com"],
  displayName: "Stripe",
  description:
    "Stripe as infrastructure: webhook endpoints and event destinations with an event picker and kept signing secrets, products, prices and billing meters, Connect accounts, payouts, balance, a subscriptions overview, Reporting and Sigma runs, failing webhook deliveries, and Stripe's own fees as cost.",
  logoSvg: LOGO_SVG,
  // The tokens this plugin issues, so a leak a secret scanner reports can be
  // matched to an account here. Identifiers from GitHub's supported secret
  // scanning patterns and GitLab's secret detection rules (verified 2026-10).
  tokenFormats: [
    {
      id: "secret-key",
      label: "Stripe secret or restricted key",
      scannerTypes: [
        "stripe_api_key",
        "stripe_live_restricted_key",
        "stripe_test_restricted_key",
        "StripeLiveSecretKey",
        "StripeLiveRestrictedKey",
        "StripeTestSecretKey",
      ],
      prefixes: ["sk_live_", "rk_live_", "sk_test_", "rk_test_"],
      credentialFields: ["apiKey"],
      manageUrl: "https://dashboard.stripe.com/apikeys",
    },
  ],
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A restricted key (rk_…) is recommended: Developers, API keys, Create restricted key in the Stripe Dashboard. Give it Write on Webhook Endpoints, Event Destinations, Products, Prices, Billing Meters and Payouts, and Read on Account, Balance, Balance Transaction Sources, Events, Subscriptions, Connect Accounts, Report Runs, Files and Sigma; the account's preflight check lists anything missing. A secret key (sk_…) also works. Use a test-mode key to manage the sandbox.",
      sensitive: true,
      placeholder: "rk_live_…",
      helpLink: { label: "Create a restricted key", url: "https://dashboard.stripe.com/apikeys" },
    },
    caCertCredentialField,
  ]),
  costs: {
    // Stripe's fees from balance transactions: per product (Payments,
    // Billing, Radar, Connect, currency conversion…) and fee type.
    dimensions: ["service", "tag"],
    maxHistoryDays: 365,
    // Fees land with the transaction; refunds return fees on their own date.
    restatementDays: 3,
    chargeTypes: true,
  },
  statusFeed,
  preflight,
  // Stripe allows 100 read requests a second in live mode and 25 in test mode.
  rateLimit: { capacity: 20, refillPerSecond: 10 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new StripeClient(credentials, services),
  testCredentials: { apiKey: "rk_test_123" },
  parseStatusFeed,
  terraformExport: stripeTerraformExport,
  policyTemplate,
});
