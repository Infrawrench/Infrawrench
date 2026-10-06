import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ResendClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "resend",
  version: "0.1.0",
  displayName: "Resend",
  description:
    "Email API for developers. Manage sending domains and the DNS records they need, API keys, webhooks with delivery history and replay, broadcasts, templates, segments, topics, contacts, suppressions and automations, chart deliverability, and watch plan limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Full access API key (starts with re_), created under API Keys in the Resend dashboard. Sending access keys can only send email, so they cannot list or manage anything here.",
      sensitive: true,
      placeholder: "re_...",
      helpLink: { label: "Create an API key", url: "https://resend.com/api-keys" },
    },
    caCertCredentialField,
  ],
  quotas: { label: "Plan limits", increaseUrl: "https://resend.com/settings/billing" },
  statusFeed,
  // Resend allows 10 requests a second per team, shared by every key.
  rateLimit: { capacity: 5, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ResendClient(credentials, services),
  parseStatusFeed,
};
