import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { MailgunClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "mailgun",
  version: "0.1.0",
  displayName: "Mailgun",
  description:
    "Email sending and receiving. Manage domains in the US and EU regions with their DNS records and verification, sending keys and API keys, webhooks, routes, mailing lists, SMTP credentials, dedicated IP pools, tags, subaccounts and suppressions, chart daily delivery and engagement, and watch the custom monthly sending limit.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "An account API key, from Account settings, API keys, Create key in Mailgun (not a domain sending key, which can only send). The Admin role manages everything; Developer manages everything except API keys; Analyst and Support are read-mostly.",
      sensitive: true,
      placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxx-xxxxxxxx",
      helpLink: {
        label: "Open Mailgun API keys",
        url: "https://app.mailgun.com/settings/api_security",
      },
    },
    {
      key: "region",
      label: "Regions",
      description:
        "Which regions to read. Domains, routes, mailing lists and their data live in either the US or the EU region; the same key works in both.",
      sensitive: false,
      optional: true,
      defaultValue: "both",
      regions: [
        { id: "both", label: "US and EU", location: "api.mailgun.net and api.eu.mailgun.net" },
        { id: "us", label: "US only", location: "api.mailgun.net" },
        { id: "eu", label: "EU only", location: "api.eu.mailgun.net" },
      ],
    },
    caCertCredentialField,
  ],
  quotas: {
    label: "Custom monthly sending limit",
    partial: true,
  },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new MailgunClient(credentials, services),
  parseStatusFeed,
};
