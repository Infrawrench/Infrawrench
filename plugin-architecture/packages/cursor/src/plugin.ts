import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ADMIN_API_DOCS, DASHBOARD_URL } from "./api.js";
import { CursorClient } from "./client.js";
import { DEFAULT_PREMIUM_SEAT_PRICE, DEFAULT_STANDARD_SEAT_PRICE } from "./cost-data.js";
import { logoSvg } from "./logo.js";
import { resourceTypes } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { cursorRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "cursor",
  version: "0.1.0",
  displayName: "Cursor",
  description:
    "Cursor team administration: members and seats (with idle-seat detection), per-user spend limits, billing and member groups, repository blocklists, usage by model and member, and daily cost from usage-based spend plus seat estimates. Enterprise teams also get the Analytics and AI Code Tracking series.",
  logoSvg,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "Admin API Key",
      description:
        "A team API key created by a team admin in the Cursor dashboard under Settings, API Keys. Starts with crsr_. A read-only key lists everything and collects costs; editing needs the admin scope. Teams and Enterprise plans only.",
      sensitive: true,
      placeholder: "crsr_...",
      helpLink: { label: "Create an Admin API key", url: ADMIN_API_DOCS },
    },
    {
      key: "seatPriceMonthly",
      label: "Standard seat price (USD per month)",
      description: `What one standard Cursor seat costs you per month. Cursor's API does not report seat pricing, so seat costs are estimated from this. Defaults to the published Teams price of $${DEFAULT_STANDARD_SEAT_PRICE}; set your negotiated or annual rate here.`,
      sensitive: false,
      optional: true,
      defaultValue: String(DEFAULT_STANDARD_SEAT_PRICE),
      placeholder: String(DEFAULT_STANDARD_SEAT_PRICE),
    },
    {
      key: "premiumSeatPriceMonthly",
      label: "Premium seat price (USD per month)",
      description: `What one premium seat costs you per month. Defaults to the published price of $${DEFAULT_PREMIUM_SEAT_PRICE}.`,
      sensitive: false,
      optional: true,
      defaultValue: String(DEFAULT_PREMIUM_SEAT_PRICE),
      placeholder: String(DEFAULT_PREMIUM_SEAT_PRICE),
    },
    {
      key: "premiumSeatEmails",
      label: "Premium seat members",
      description:
        "Emails of the members on premium seats, separated by commas. Everyone else with a paid seat is priced as standard; unpaid admins are never charged.",
      sensitive: false,
      optional: true,
      multiline: true,
      placeholder: "alex@example.com, sam@example.com",
      helpLink: { label: "Open the Cursor dashboard", url: DASHBOARD_URL },
    },
    caCertCredentialField,
  ],
  // Usage-based spend is billed data from POST /teams/filtered-usage-events;
  // seat rows are member list × the seat price above, because no endpoint
  // reports the plan or the seat price. One derived component is enough to
  // label the whole account as an estimate.
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 90,
    restatementDays: 3,
    estimated: true,
  },
  statusFeed,
  preflight: {
    capabilities: [
      {
        id: "read",
        label: "Members, spend and usage",
        description:
          "List members, read spend this cycle, daily usage and usage events, and collect costs.",
        requiredPermissions: [
          { id: "read-only", label: "Team API key (read-only or admin scope)" },
        ],
        essential: true,
      },
      {
        id: "write",
        label: "Spend limits, groups and blocklists",
        description:
          "Set per-user spend limits, manage billing and member groups and repository blocklists, remove members.",
        requiredPermissions: [{ id: "admin", label: "Team API key with the admin scope" }],
      },
      {
        id: "analytics",
        label: "Analytics and AI Code Tracking",
        description:
          "Daily active users by surface, agent edit and Tab acceptance, client versions and AI-attributed commit lines.",
        requiredPermissions: [
          { id: "enterprise", label: "Enterprise plan" },
          { id: "admin", label: "Team API key with the admin scope" },
        ],
      },
    ],
  },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new CursorClient(credentials, services),
  parseStatusFeed,
  remediationCommands: cursorRemediationCommands,
};
