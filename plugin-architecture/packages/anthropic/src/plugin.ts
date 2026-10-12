import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AnthropicClient } from "./client.js";
import { anthropicModelRates } from "./ai-rates.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { ModelResourceType } from "./resources/model.js";
import { MessageBatchResourceType } from "./resources/message-batch.js";
import { FileResourceType } from "./resources/file.js";
import { WorkspaceResourceType } from "./resources/workspace.js";
import { OrganizationUserResourceType } from "./resources/organization-user.js";
import { InviteResourceType } from "./resources/invite.js";
import { ApiKeyResourceType } from "./resources/api-key.js";
import { WorkspaceMemberResourceType } from "./resources/workspace-member.js";
import { RateLimitResourceType } from "./resources/rate-limit.js";
import { SkillResourceType } from "./resources/skill.js";
import { anthropicSeatRemediationCommands } from "./remediation.js";
import { SEAT_PRODUCT } from "./seats.js";

// Anthropic's corporate "A" mark, taken verbatim from the official logo
// (native viewBox "0 0 24 24", path unmodified) and rescaled onto the 100×100
// rounded-rect card the host renders. Background is Anthropic's brand terra
// cotta #D97757, the mark in the companion ivory #F0EEE6.
const manifest: PluginManifest = {
  id: "anthropic",
  version: "0.1.0",
  displayName: "Anthropic",
  description:
    "Claude models, Message Batches, Files and Skills, plus (with an Admin API key) workspaces and their members, organization members, invites, API keys, rate limits, usage, Claude Code analytics and cost reporting.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#D97757"/>
    <g transform="translate(18.8,19.45) scale(2.6)" fill="#F0EEE6" fill-rule="evenodd">
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  // The tokens this plugin issues, so a leak a secret scanner reports can be
  // matched to an account here. Identifiers from GitHub's supported secret
  // scanning patterns and GitLab's secret detection rules (verified 2026-10).
  tokenFormats: [
    {
      id: "api-key",
      label: "Anthropic API key",
      scannerTypes: ["anthropic_api_key", "anthropic_admin_api_key", "anthropic_key"],
      prefixes: ["sk-ant-api", "sk-ant-admin"],
      credentialFields: ["apiKey", "adminApiKey"],
      manageUrl: "https://console.anthropic.com/settings/keys",
    },
  ],
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A standard Claude API key from Console → Settings → API keys. Starts with sk-ant-api. This key drives Models, Message Batches, Files and Skills. It is NOT an Admin key and will return 401 on every /v1/organizations/* endpoint.",
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
        "A separate Admin API key from Console → Settings → Admin keys. Starts with sk-ant-admin; only an organization admin can create one. Unlocks Workspaces, Members, Invites, API Keys, Rate Limits and the usage, Claude Code and cost charts. Leave blank and those sections stay empty. Not available on individual accounts. For a Claude Enterprise organization, use an Admin API key created in claude.ai organization settings with the read:members scope (add write:members to remove members); it lists members and their seats.",
      sensitive: true,
      optional: true,
      placeholder: "sk-ant-admin01-...",
      helpLink: {
        label: "How to create an Admin API key",
        url: "https://platform.claude.com/docs/en/manage-claude/admin-api-keys",
      },
    },
    {
      key: "analyticsApiKey",
      label: "Claude Enterprise Analytics API Key (optional)",
      description:
        "Claude Enterprise only. An Analytics API key with the read:analytics scope, created by the primary owner in claude.ai organization settings under API. It supplies each member's last activity, so idle Claude seats can be found. Without it seat activity is unknown.",
      sensitive: true,
      optional: true,
      advanced: true,
      helpLink: {
        label: "Get access to the Claude Enterprise Analytics API",
        url: "https://platform.claude.com/docs/en/manage-claude/analytics-api",
      },
    },
    caCertCredentialField,
  ],
  // Cost data comes from GET /v1/organizations/cost_report, which is
  // daily-granularity only and admin-key only. Grouping is limited to
  // `description` (→ service) and `workspace_id` (→ resource).
  costs: {
    focus: { default: { category: "AI and Machine Learning", subcategory: "Generative AI" } },
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  aiModelRates: anthropicModelRates,
  statusFeed,
  // Claude Enterprise members are paid seats; Console organizations have no
  // per-seat charge and report none. Removal is DELETE /v1/organizations/users/{id}.
  seats: { products: [SEAT_PRODUCT], removal: true },
};

const resourceTypes: ResourceTypeDefinition[] = [
  ModelResourceType,
  MessageBatchResourceType,
  FileResourceType,
  SkillResourceType,
  WorkspaceResourceType,
  WorkspaceMemberResourceType,
  OrganizationUserResourceType,
  InviteResourceType,
  ApiKeyResourceType,
  RateLimitResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new AnthropicClient(credentials, services),
  parseStatusFeed,
  seatRemediationCommands: anthropicSeatRemediationCommands,
};
