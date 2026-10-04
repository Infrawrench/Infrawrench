import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { TwilioClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "twilio",
  version: "0.1.0",
  displayName: "Twilio",
  description:
    "Communications APIs. Track Twilio spend by product, usage category and subaccount from billed usage records, watch the account balance burn down, chart daily message and call volume, and manage phone numbers, messaging services, Verify services, TwiML apps, subaccounts, usage triggers and API keys.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accountSid",
      label: "Account SID",
      description:
        "Your main account's SID, shown on the Twilio Console home page. It starts with AC. Use the main account, not a subaccount, to see spend for every subaccount.",
      sensitive: false,
      placeholder: "AC…",
      helpLink: { label: "Open the Twilio Console", url: "https://console.twilio.com/" },
    },
    {
      key: "apiKeySid",
      label: "API Key SID",
      description:
        "Recommended: an API key created under Account, API keys and tokens (it starts with SK). A Standard key lists resources and reads main-account spend; a Main key can also manage subaccounts and keys and read the balance. Leave blank to use the auth token instead.",
      sensitive: false,
      optional: true,
      placeholder: "SK…",
      helpLink: {
        label: "Create an API key",
        url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
      },
    },
    {
      key: "apiKeySecret",
      label: "API Key Secret",
      description: "The secret shown once when the API key was created.",
      sensitive: true,
      optional: true,
    },
    {
      key: "authToken",
      label: "Auth Token",
      description:
        "Only needed without an API key. The auth token is the only credential Twilio lets read each subaccount's spend and phone numbers individually, so use it for per-subaccount cost.",
      sensitive: true,
      optional: true,
      helpLink: {
        label: "Find the auth token",
        url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
      },
    },
    caCertCredentialField,
  ],
  costs: {
    // Usage Records API: product family → service, usage category and
    // subaccount → tags, the subaccount's SID → resource. Prices are what
    // Twilio billed. Usage records reach back to the account's creation.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 730,
    // Usage records are finalised within a day or two; re-read a week.
    restatementDays: 7,
  },
  credits: {
    label: "Account balance",
    topUpUrl: "https://console.twilio.com/us1/billing/manage-billing/billing-overview",
  },
  statusFeed,
  // Twilio limits concurrency per account rather than publishing a rate.
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new TwilioClient(credentials, services),
  parseStatusFeed,
};
