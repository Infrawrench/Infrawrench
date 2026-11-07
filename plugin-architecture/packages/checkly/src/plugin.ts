import type { PluginEffect } from "@infrawrench/plugin-base";
import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { createChecklyApi } from "./api.js";
import { ChecklyClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { CHECKLY_PREFLIGHT } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { checklyTerraformExport } from "./terraform.js";

export const manifest = {
  id: "checkly",
  egressHosts: ["api.checklyhq.com"],
  displayName: "Checkly",
  description:
    "Synthetic monitoring and uptime checks. Manage Checkly checks of every type (activate, mute, run now, edit), check groups, alert channels, maintenance windows, private locations, dashboards, status pages and environment variables, and chart response times and failures per location.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A user API key from Checkly under User settings, API keys. It acts with your role in the account: Read & Write (or Admin, for private location keys) to manage everything, Read only for a read-only account.",
      sensitive: true,
      placeholder: "cu_…",
      helpLink: {
        label: "Create an API key",
        url: "https://app.checklyhq.com/settings/user/api-keys",
      },
    },
    {
      key: "accountId",
      label: "Account",
      description:
        "The Checkly account to manage, picked from the accounts the key belongs to (Account settings, General shows its ID).",
      sensitive: false,
      placeholder: "d43967ee-81db-4e0b-a18c-06be5c995288",
      providerOptions: { dependsOn: ["apiKey"] },
    },
    caCertCredentialField,
  ]),
  preflight: CHECKLY_PREFLIGHT,
  statusFeed,
  quotas: {
    label: "Usage credits",
    partial: true,
    increaseUrl: "https://app.checklyhq.com/settings/account/billing",
  },
  rateLimit: { capacity: 10, refillPerSecond: 1 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ChecklyClient(credentials, services),
  testCredentials: { apiKey: "cu_test", accountId: "00000000-0000-0000-0000-000000000000" },
  parseStatusFeed,
  terraformExport: checklyTerraformExport,
  listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): PluginEffect<CredentialFieldOption[]> {
    return attempt(async () => {
      if (fieldKey !== "accountId") return [];
      const apiKey = (credentials["apiKey"] ?? "").trim();
      if (!apiKey) return [];
      const accounts = await createChecklyApi({
        apiKey,
        accountId: "",
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
        ...(services?.http ? { http: services.http } : {}),
      }).get("/v1/accounts");
      return (accounts ?? [])
        .filter((a) => a.id)
        .map((a) => ({
          id: a.id,
          label: a.name ?? a.id,
          description: [a.planDisplayName, a.id].filter(Boolean).join(", "),
        }));
    });
  },
});
