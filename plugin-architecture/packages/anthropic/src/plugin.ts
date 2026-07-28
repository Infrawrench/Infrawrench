import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AnthropicClient } from "./client.js";
import { ModelResourceType } from "./resources/model.js";
import { MessageBatchResourceType } from "./resources/message-batch.js";
import { FileResourceType } from "./resources/file.js";
import { WorkspaceResourceType } from "./resources/workspace.js";
import { OrganizationUserResourceType } from "./resources/organization-user.js";
import { InviteResourceType } from "./resources/invite.js";
import { ApiKeyResourceType } from "./resources/api-key.js";

// Anthropic's corporate "A" mark, taken verbatim from the official logo
// (native viewBox "0 0 24 24", path unmodified) and rescaled onto the 100×100
// rounded-rect card the host renders. Background is Anthropic's brand terra
// cotta #D97757, the mark in the companion ivory #F0EEE6.
const manifest: PluginManifest = {
  id: "anthropic",
  version: "0.1.0",
  displayName: "Anthropic",
  description:
    "Claude models, Message Batches, Files, and — with an Admin API key — workspaces, members, invites, API keys, usage and cost reporting.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#D97757"/>
    <g transform="translate(18.8,19.45) scale(2.6)" fill="#F0EEE6" fill-rule="evenodd">
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A standard Claude API key from Console → Settings → API keys. Starts with sk-ant-api. This key drives Models, Message Batches and Files. It is NOT an Admin key and will return 401 on every /v1/organizations/* endpoint.",
      sensitive: true,
      placeholder: "sk-ant-api03-...",
      helpLink: {
        label: "Create an API key in the Claude Console",
        url: "https://platform.claude.com/settings/keys",
      },
    },
    {
      key: "adminApiKey",
      label: "Admin API Key (optional)",
      description:
        "A separate Admin API key from Console → Settings → Admin keys. Starts with sk-ant-admin and can only be provisioned by an organization admin. It unlocks the Workspaces, Organization Members, Invites and API Keys sections plus the usage and cost charts, all of which live under /v1/organizations/*. Leave blank and everything else keeps working — those four sections simply come back empty. The Admin API is unavailable on individual (non-organization) accounts.",
      sensitive: true,
      optional: true,
      placeholder: "sk-ant-admin01-...",
      helpLink: {
        label: "How to create an Admin API key",
        url: "https://platform.claude.com/docs/en/manage-claude/admin-api-keys",
      },
    },
    caCertCredentialField,
  ],
  // Cost data comes from GET /v1/organizations/cost_report, which is
  // daily-granularity only and admin-key only. Grouping is limited to
  // `description` (→ service) and `workspace_id` (→ resource).
  costs: { dimensions: ["service", "resource"], maxHistoryDays: 365, restatementDays: 3 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  MessageBatchResourceType,
  FileResourceType,
  WorkspaceResourceType,
  OrganizationUserResourceType,
  InviteResourceType,
  ApiKeyResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new AnthropicClient(credentials, services),
};
