import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { listOffset } from "./api.js";
import { SendGridClient, resolveRegion } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import type { SgSubuser } from "./mappers.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "sendgrid",
  version: "0.1.0",
  displayName: "SendGrid",
  description:
    "Twilio SendGrid email. Manage API keys, authenticated domains and link branding with their DNS records, dedicated IPs, IP pools and reverse DNS, subusers, event webhooks, inbound parse, templates, unsubscribe groups, verified senders, alerts and suppressions, and chart daily delivery and engagement.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
  ],
  quotas: {
    label: "Email credits",
    increaseUrl: "https://app.sendgrid.com/account/billing",
    partial: false,
  },
  statusFeed,
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "onBehalfOf") return [];
  const apiKey = (credentials["apiKey"] ?? "").trim();
  if (!apiKey) throw new Error("Enter the API key first.");
  const caCert = credentials["caCert"] ?? "";
  const subusers = await listOffset<SgSubuser>(
    {
      apiKey,
      region: resolveRegion(credentials["region"]),
      onBehalfOf: "",
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    },
    "/v3/subusers",
  );
  return subusers
    .filter((s) => s.username)
    .map((s) => ({
      id: s.username ?? "",
      label: s.username ?? "",
      description: [s.email, s.disabled ? "disabled" : ""].filter(Boolean).join(", "),
    }));
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new SendGridClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
};
