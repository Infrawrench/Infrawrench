import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { NeonClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { NeonProjectResourceType } from "./resources/project.js";
import { NeonBranchResourceType } from "./resources/branch.js";
import { NeonEndpointResourceType } from "./resources/endpoint.js";
import { NeonDatabaseResourceType } from "./resources/database.js";
import { NeonRoleResourceType } from "./resources/role.js";
import { NeonDataApiResourceType } from "./resources/data-api.js";
import { NeonSnapshotResourceType } from "./resources/snapshot.js";
import { NeonBucketResourceType } from "./resources/bucket.js";
import { NeonCredentialResourceType } from "./resources/credential.js";
import { NeonFunctionResourceType } from "./resources/function.js";
import { NeonAiGatewayResourceType } from "./resources/ai-gateway.js";
import { NeonAuthResourceType } from "./resources/auth.js";
import { NeonAuthOauthProviderResourceType } from "./resources/auth-oauth-provider.js";
import { NeonAuthDomainResourceType } from "./resources/auth-domain.js";

const manifest: PluginManifest = {
  id: "neon",
  version: "0.1.0",
  displayName: "Neon",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0A0A0A"/>
    <g transform="translate(18,18) scale(1)">
      <path d="M63 0.018V63.553L38.418 42.25V63.553H0V0L63 0.018ZM7.723 55.839H30.695V25.324L55.278 47.048V7.729L7.723 7.716V55.839Z" fill="#00E599"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Neon API key. Generate one at https://console.neon.tech/app/settings/api-keys",
      sensitive: true,
      placeholder: "neon_...",
    },
  ],
  // Usage units from the consumption-history API converted to dollars with
  // Neon's published rates (estimate — plan allowances/discounts not
  // modeled). Daily granularity; Neon keeps 60 days of daily history.
  costs: { dimensions: ["service", "resource"], maxHistoryDays: 60 },
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  NeonProjectResourceType,
  NeonBranchResourceType,
  NeonEndpointResourceType,
  NeonDatabaseResourceType,
  NeonRoleResourceType,
  NeonDataApiResourceType,
  NeonSnapshotResourceType,
  NeonBucketResourceType,
  NeonCredentialResourceType,
  NeonFunctionResourceType,
  NeonAiGatewayResourceType,
  NeonAuthResourceType,
  NeonAuthOauthProviderResourceType,
  NeonAuthDomainResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new NeonClient(credentials, services),
  parseStatusFeed,
};
