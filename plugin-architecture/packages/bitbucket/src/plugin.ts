import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import type { BitbucketContext } from "./api.js";
import { bbPaged, isPermissionError } from "./api.js";
import { BitbucketClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import type { BbWorkspaceAccess } from "./types.js";

const manifest: PluginManifest = {
  id: "bitbucket",
  version: "0.1.0",
  displayName: "Bitbucket",
  description:
    "Bitbucket Cloud. Manage workspaces, projects and repositories, run and stop Pipelines with step logs, and manage pipeline, workspace and deployment variables, deployment environments, schedules, caches, branch restrictions, webhooks, deploy keys and self-hosted runners, with pipeline and build-minute metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "email",
      label: "Atlassian Account Email",
      description:
        "The email you sign in to Atlassian with, used with an API token. Leave empty when pasting a workspace, project or repository access token.",
      sensitive: false,
      optional: true,
      placeholder: "you@example.com",
    },
    {
      key: "token",
      label: "API Token",
      description:
        "An API token with scopes (Bitbucket, Personal settings, Atlassian account settings, Security, Create API token with scopes, then pick Bitbucket). Grant read:workspace, read:project, read:repository, read:pipeline, read:runner and read:webhook to look; add admin:repository, admin:project, write:pipeline, admin:pipeline, write:runner, write:webhook and delete:webhook to make changes. A workspace access token (Premium) also works, sent without an email. App passwords stopped working in 2026.",
      sensitive: true,
      placeholder: "ATATT3x…",
      helpLink: {
        label: "Create an API token with scopes",
        url: "https://id.atlassian.com/manage-profile/security/api-tokens",
      },
    },
    {
      key: "workspace",
      label: "Workspace",
      description: "The workspace to manage, from the workspaces your account belongs to.",
      sensitive: false,
      placeholder: "workspace-slug",
      providerOptions: { dependsOn: ["email", "token"] },
    },
  ],
  statusFeed,
  // Bitbucket meters most repository data at about 1,000 requests an hour per
  // user (more on paid plans); stay under it.
  rateLimit: { capacity: 10, refillPerSecond: 0.25 },
};

/**
 * Options for the workspace picker: `GET /user/workspaces`, which needs
 * read:workspace. Access tokens act as a bot without a user, so the call is
 * refused for them and the slug is typed instead.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "workspace") return [];
  const token = (credentials["token"] ?? "").trim();
  if (!token) throw new Error("Enter an API token first.");
  const email = (credentials["email"] ?? "").trim();
  const ctx: BitbucketContext = {
    token,
    workspace: "",
    ...(email ? { email } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
  try {
    const access = await bbPaged<BbWorkspaceAccess>(ctx, "/user/workspaces", {}, 5);
    return access
      .filter((a) => a.workspace?.slug)
      .map((a) => ({
        id: a.workspace!.slug,
        label: a.workspace!.name ?? a.workspace!.slug,
        description: `${a.workspace!.slug}${a.administrator ? " (admin)" : ""}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        email
          ? "Bitbucket rejected the email and token. Use your Atlassian account email (not your Bitbucket username) and an API token with the read:workspace scope."
          : "Access tokens cannot list workspaces. Type the workspace slug from the workspace's URL.",
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BitbucketClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
};
