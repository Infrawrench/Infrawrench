import { caCertCredentialField, defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  CredentialFieldOption,
  CredentialsOf,
  HostServices,
  PluginEffect,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import { createBoatApi, listOf } from "./api.js";
import { BOAT_CI_EXECUTOR } from "./ci-executor.js";
import { BoatClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const DASHBOARD = "https://boat.dev/dashboard";

export const manifest = {
  id: "boat",
  egressHosts: ["boat.dev"],
  displayName: "boat",
  description:
    "Cloud sandboxes for AI agents. Persistent Ubuntu VMs with create, stop, resume and fork, agent prompts, hosted ports, saved snapshots, environments, webhooks and per-second machine-time costs.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A boat API key, from the dashboard or `boat api-key create <name>`. A read-only key lists everything; creating, stopping and prompting need the actions to match.",
      sensitive: true,
      placeholder: "boat_…",
      helpLink: { label: "boat API keys", url: "https://docs.boat.dev/api/v1" },
    },
    {
      key: "org",
      label: "Organization",
      description:
        "Whose wallet the account bills and lists. Empty uses the key owner's active wallet.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiKey"], emptyLabel: "The active wallet" },
    },
    caCertCredentialField,
  ]),
  statusFeed,
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 90,
    restatementDays: 2,
    estimated: true,
  },
  credits: { label: "Wallet", topUpUrl: DASHBOARD },
  quotas: { label: "Plan limits", increaseUrl: DASHBOARD, partial: true },
  // CI jobs on a fresh sandbox of their own (`cloud: boat/vm`). See `ci-executor.ts`.
  ciExecutor: BOAT_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BoatClient(credentials, RESOURCE_TYPES, services),
  testCredentials: { apiKey: "boat_test_key" },
  parseStatusFeed,
  listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): PluginEffect<CredentialFieldOption[]> {
    return attempt(async () => {
      if (fieldKey !== "org") return [];
      const apiKey = (credentials["apiKey"] ?? "").trim();
      if (!apiKey) return [];
      const api = createBoatApi(apiKey, "", credentials["caCert"] ?? "", services);
      const orgs = listOf((await api.get("/orgs"))?.orgs, "/orgs", "orgs");
      return orgs
        .filter((o) => o.type === "org")
        .map((o) => ({
          id: o.id,
          label: o.name,
          description: `${o.memberCount} member${o.memberCount === 1 ? "" : "s"}, ${o.role}`,
        }));
    });
  },
});
