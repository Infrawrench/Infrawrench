import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attemptFn } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { createSendGridApis } from "./api.js";
import { SendGridClient, resolveRegion } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

export const manifest = {
  id: "sendgrid",
  // api.eu.sendgrid.com serves EU regional subusers
  egressHosts: ["api.sendgrid.com", "api.eu.sendgrid.com"],
  displayName: "SendGrid",
  description:
    "Twilio SendGrid email. Manage API keys, authenticated domains and link branding with their DNS records, dedicated IPs, IP pools and reverse DNS, subusers, event webhooks, inbound parse, templates, unsubscribe groups, verified senders, alerts and suppressions, and chart daily delivery and engagement.",
  logoSvg: LOGO_SVG,
  // The tokens this plugin issues, so a leak a secret scanner reports can be
  // matched to an account here. Identifiers from GitHub's supported secret
  // scanning patterns and GitLab's secret detection rules (verified 2026-10).
  tokenFormats: [
    {
      id: "api-key",
      label: "SendGrid API key",
      scannerTypes: ["sendgrid_api_key", "Sendgrid API token"],
      credentialFields: ["apiKey"],
      manageUrl: "https://app.sendgrid.com/settings/api_keys",
    },
  ],
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "Create one in SendGrid under Settings, API Keys, Create API Key. Full Access manages everything; with Restricted Access, give it read access to what you want listed (including Stats and Billing for credits) and full access to what you want to edit.",
      sensitive: true,
      placeholder: "SG....",
      helpLink: {
        label: "Create a SendGrid API key",
        url: "https://app.sendgrid.com/settings/api_keys",
      },
    },
    {
      key: "region",
      label: "Region",
      description:
        "Global for most accounts. Pick EU only for an EU regional subuser, whose API lives at api.eu.sendgrid.com.",
      sensitive: false,
      optional: true,
      defaultValue: "global",
      regions: [
        { id: "global", label: "Global", location: "api.sendgrid.com" },
        { id: "eu", label: "EU", location: "api.eu.sendgrid.com" },
      ],
    },
    {
      key: "onBehalfOf",
      label: "Act as Subuser",
      description:
        "Optional. With a parent account's key, manage one subuser's domains, keys, webhooks and stats instead of the parent's.",
      sensitive: false,
      optional: true,
      advanced: true,
      providerOptions: { dependsOn: ["apiKey"], emptyLabel: "The key's own account" },
    },
    caCertCredentialField,
  ]),
  quotas: {
    label: "Email credits",
    increaseUrl: "https://app.sendgrid.com/account/billing",
    partial: false,
  },
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "onBehalfOf") return [];
  const apiKey = (credentials["apiKey"] ?? "").trim();
  if (!apiKey) throw new Error("Enter the API key first.");
  const caCert = credentials["caCert"] ?? "";
  const { api } = createSendGridApis({
    apiKey,
    region: resolveRegion(credentials["region"]),
    onBehalfOf: "",
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  });
  const subusers = await api.getAll("/v3/subusers", null, { maxPages: 50, partial: true });
  return subusers
    .filter((s) => s.username)
    .map((s) => ({
      id: s.username ?? "",
      label: s.username ?? "",
      description: [s.email, s.disabled ? "disabled" : ""].filter(Boolean).join(", "),
    }));
}

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SendGridClient(credentials, services),
  testCredentials: { apiKey: "SG.test-key-id.test-secret" },
  parseStatusFeed,
  listCredentialOptions: attemptFn(listCredentialOptions),
});
