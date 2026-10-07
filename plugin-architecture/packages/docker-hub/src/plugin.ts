import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import type { HubContext } from "./api.js";
import { statusOf } from "./api.js";
import { DockerHubClient, listNamespaces } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { dockerHubRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { dockerHubTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "docker-hub",
  version: "0.1.0",
  displayName: "Docker Hub",
  description:
    "Docker Hub repositories and tags, organizations with their members, teams and invites, personal and organization access tokens, the audit log and your pull rate limit.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "username",
      label: "Docker ID",
      description:
        "Your Docker Hub username. When you use an organization access token instead, enter the organization's name here.",
      sensitive: false,
      placeholder: "myusername",
    },
    {
      key: "token",
      label: "Access Token",
      description:
        "A personal access token: in Docker Hub open Account settings, Personal access tokens, Generate new token, and give it Read, Write & Delete access to manage repositories and tags. Or an organization access token (Admin Console, Access tokens) for one organization. Managing personal access tokens themselves needs your password instead, which Docker Hub refuses for accounts under enforced SSO.",
      sensitive: true,
      placeholder: "dckr_pat_…",
      helpLink: {
        label: "Docker personal access tokens",
        url: "https://docs.docker.com/security/access-tokens/",
      },
    },
    {
      key: "namespaces",
      label: "Namespaces",
      description:
        "Which namespaces to manage: your own account and the organizations you belong to. Leave empty to include all of them.",
      sensitive: false,
      optional: true,
      providerOptions: {
        dependsOn: ["username", "token"],
        multiple: true,
        emptyLabel: "All namespaces",
      },
    },
  ],
  statusFeed,
  quotas: {
    label: "Pull rate limit",
    increaseUrl: "https://www.docker.com/pricing/",
    partial: true,
  },
  // Docker Hub's API limit is per minute and per account; stay well inside it.
  rateLimit: { capacity: 10, refillPerSecond: 3 },
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "namespaces") return [];
  const identifier = (credentials["username"] ?? "").trim();
  const secret = (credentials["token"] ?? "").trim();
  if (!identifier || !secret) throw new Error("Enter the Docker ID and access token first.");
  const ctx: HubContext = {
    identifier,
    secret,
    ...(services?.http ? { http: services.http } : {}),
  };
  try {
    const all = await listNamespaces(ctx);
    return all.map((n) => ({ id: n.name, label: n.name, description: n.kind }));
  } catch (err) {
    if (statusOf(err) === 401 || statusOf(err) === 403) {
      throw new Error(
        "Docker Hub rejected the Docker ID and token. Check both, and use the organization name with an organization access token.",
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new DockerHubClient(credentials, services),
  parseStatusFeed,
  terraformExport: dockerHubTerraformExport,
  remediationCommands: dockerHubRemediationCommands,
  listCredentialOptions,
};
