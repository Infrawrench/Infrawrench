import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { StripeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { policyTemplate, preflight } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { stripeTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "stripe",
  version: "0.1.0",
  displayName: "Stripe",
  description:
    "Stripe as infrastructure: webhook endpoints and event destinations with an event picker and kept signing secrets, products, prices and billing meters, Connect accounts, payouts, balance, a subscriptions overview, Reporting and Sigma runs, failing webhook deliveries, and Stripe's own fees as cost.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
  ],
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
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new StripeClient(credentials, services),
  parseStatusFeed,
  terraformExport: stripeTerraformExport,
  policyTemplate,
};
