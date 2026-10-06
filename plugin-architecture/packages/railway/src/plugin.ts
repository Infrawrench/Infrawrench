import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { RailwayApi } from "./api.js";
import { RailwayClient } from "./client.js";
import { isStatus } from "./kit.js";
import { LOGO_SVG } from "./logo.js";
import { Q_TOKEN_WORKSPACES } from "./queries.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import type { RwWorkspaceRef } from "./types.js";

const manifest: PluginManifest = {
  id: "railway",
  version: "0.1.0",
  displayName: "Railway",
  description:
    "Application platform. Manage projects, environments, services, deployments with redeploy and rollback, variables, volumes and backups, domains and TCP proxies, with logs, metrics, usage-based cost estimates, credits and spend limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "An account or workspace token from railway.com, Account Settings, Tokens. Choose No workspace for an account token that sees every workspace you belong to, or pick a workspace for a token limited to it. Project tokens are not supported. Billing data (usage limits, credits) needs a workspace admin.",
      sensitive: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      helpLink: { label: "Create a Railway token", url: "https://railway.com/account/tokens" },
    },
    {
      key: "workspaceId",
      label: "Workspace",
      description: "Limit this account to one workspace, or leave on All workspaces.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiToken"], emptyLabel: "All workspaces" },
    },
    caCertCredentialField,
  ],
  // Hobby allows 1,000 requests an hour (Pro 10,000); stay inside the smaller.
  rateLimit: { capacity: 20, refillPerSecond: 0.25 },
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 60,
    restatementDays: 2,
    estimated: true,
  },
  credits: {
    label: "Railway credits",
    topUpUrl: "https://railway.com/workspace/billing",
    requiresElevatedCredential: true,
  },
  quotas: {
    label: "Railway usage limit",
    increaseUrl: "https://railway.com/workspace/usage",
    partial: true,
    requiresElevatedCredential: true,
  },
  statusFeed,
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "workspaceId") return [];
  const token = (credentials["apiToken"] ?? "").trim();
  if (!token) throw new Error("Enter a Railway token first.");
  const api = new RailwayApi(token, credentials["caCert"] ?? "", services);
  try {
    const res = await api.gql<{ apiToken: { workspaces: RwWorkspaceRef[] } }>(Q_TOKEN_WORKSPACES);
    return (res.apiToken?.workspaces ?? []).map((w) => ({
      id: w.id,
      label: w.name,
      description: w.id,
    }));
  } catch (e) {
    if (isStatus(e, 401, 403)) {
      throw new Error(
        "Railway rejected the token. Use an account or workspace token, not a project token.",
      );
    }
    throw e;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new RailwayClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
  listCredentialOptions,
};
