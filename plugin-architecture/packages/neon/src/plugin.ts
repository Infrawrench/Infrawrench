import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
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
import { neonTerraformExport } from "./terraform.js";
import { neonRemediationCommands } from "./remediation.js";

export const manifest = {
  id: "neon",
  // The API, and presigned uploads to a branch's S3 host, such as
  // br-x.storage.c-1.us-east-2.aws.neon.tech.
  egressHosts: ["*.neon.tech"],
  displayName: "Neon",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0A0A0A"/>
    <g transform="translate(18,18) scale(1)">
      <path d="M63 0.018V63.553L38.418 42.25V63.553H0V0L63 0.018ZM7.723 55.839H30.695V25.324L55.278 47.048V7.729L7.723 7.716V55.839Z" fill="#00E599"/>
    </g>
  </svg>`,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A Neon API key. Generate one at https://console.neon.tech/app/settings/api-keys",
      sensitive: true,
      placeholder: "neon_...",
    },
  ]),
  // Usage units from the consumption-history API converted to dollars with
  // Neon's published rates (estimate: plan allowances/discounts not
  // modeled). Daily granularity; Neon keeps 60 days of daily history.
  costs: {
    focus: { default: { category: "Databases", subcategory: "Relational Databases" } },
    dimensions: ["service", "resource"],
    maxHistoryDays: 60,
  },
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

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

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new NeonClient(credentials, services),
  testCredentials: { apiKey: "neon_test_key" },
  parseStatusFeed,
  terraformExport: neonTerraformExport,
  remediationCommands: neonRemediationCommands,
});
