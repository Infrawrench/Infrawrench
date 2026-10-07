import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
  PreflightDeclaration,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import type { GitLabContext } from "./api.js";
import { glFetch, glPaged, isPermissionError, resolveBaseUrl } from "./api.js";
import { GitLabClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { gitlabRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { gitlabTerraformExport } from "./terraform.js";
import type { GlGroup, GlUser } from "./types.js";

const SCOPES_LINK = {
  label: "Create a personal access token",
  url: "https://gitlab.com/-/user_settings/personal_access_tokens?name=Infrawrench&scopes=api,create_runner",
};

const preflight: PreflightDeclaration = {
  capabilities: [
    {
      id: "inventory",
      label: "Projects, pipelines and settings",
      description:
        "List groups, projects, pipelines, job logs, environments, variables, registries and runners.",
      essential: true,
      requiredPermissions: [{ id: "read_api", label: "Read the API (api also works)" }],
    },
    {
      id: "manage",
      label: "Changes and actions",
      description: "Run, retry and cancel pipelines, and create, edit or delete everything else.",
      requiredPermissions: [{ id: "api", label: "Read and write the API" }],
    },
    {
      id: "runners",
      label: "Create runners",
      description: "Register a new runner from Infrawrench.",
      requiredPermissions: [{ id: "create_runner", label: "Create runners" }],
    },
  ],
};

const manifest: PluginManifest = {
  id: "gitlab",
  version: "0.1.0",
  displayName: "GitLab",
  description:
    "GitLab.com or self-managed GitLab. Manage groups, projects, CI/CD pipelines with job logs, runners, environments and deployments, protected branches, CI/CD variables, pipeline schedules, container and package registries, deploy keys and tokens, webhooks, releases and members, with pipeline, job and compute-minute metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "url",
      label: "GitLab URL",
      description:
        "https://gitlab.com, or the address of your self-managed or Dedicated instance, such as https://gitlab.example.com.",
      sensitive: false,
      defaultValue: "https://gitlab.com",
      placeholder: "https://gitlab.com",
    },
    {
      key: "token",
      label: "Access Token",
      description:
        "A personal access token (avatar menu, Edit profile, Access tokens), or a group access token (the group's Settings, Access tokens). Give it the api scope to manage things, or read_api to only look; add create_runner to register runners. The user or token role decides what you see: variables, webhooks and deploy keys need Maintainer, runners and group settings need Owner.",
      sensitive: true,
      placeholder: "glpat-…",
      helpLink: SCOPES_LINK,
    },
    {
      key: "group",
      label: "Group",
      description:
        "Limit the account to one group and its subgroups, picked from the groups the token can see. Leave it on All projects to see every project you are a member of.",
      sensitive: false,
      optional: true,
      placeholder: "Group ID or full path",
      providerOptions: {
        dependsOn: ["url", "token"],
        emptyLabel: "All projects you are a member of",
      },
    },
    caCertCredentialField,
  ],
  quotas: {
    label: "Usage Quotas",
    increaseUrl: "https://customers.gitlab.com/",
    partial: true,
  },
  preflight,
  statusFeed,
  // GitLab.com allows 2,000 authenticated API requests a minute per user.
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

function contextFrom(credentials: Record<string, string>, services?: HostServices): GitLabContext {
  const token = (credentials["token"] ?? "").trim();
  if (!token) throw new Error("Enter an access token first.");
  const caCert = (credentials["caCert"] ?? "").trim();
  return {
    baseUrl: resolveBaseUrl(credentials["url"]),
    token,
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
}

/**
 * Options for the group picker: every group the token's user is at least a
 * Guest in (`GET /groups?min_access_level=10`), after checking the token with
 * `GET /user`. Group and project access tokens act as a bot user that is a
 * member of exactly their group or project, so the list is short for them.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "group") return [];
  const ctx = contextFrom(credentials, services);
  try {
    await glFetch<GlUser>(ctx, "/user");
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        "GitLab rejected the token. Check that it has not expired and has the api or read_api scope.",
      );
    }
    throw err;
  }
  const groups = await glPaged<GlGroup>(
    ctx,
    "/groups",
    { min_access_level: 10, order_by: "path" },
    5,
  );
  return groups
    .map((g) => ({ id: String(g.id), label: g.full_path, description: g.full_name ?? g.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new GitLabClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
  terraformExport: gitlabTerraformExport,
  remediationCommands: gitlabRemediationCommands,
  validateServerCredentials: (credentials) => {
    try {
      const url = resolveBaseUrl(credentials["url"]);
      if (!url.startsWith("https://")) {
        return "GitLab plugin: the instance URL must use https:// on Infrawrench cloud.";
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
};
