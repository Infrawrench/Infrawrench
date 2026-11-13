import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { FLY_CI_EXECUTOR } from "./ci-executor.js";
import { FlyClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { AppResourceType } from "./resources/app.js";
import { MachineResourceType } from "./resources/machine.js";
import { VolumeResourceType } from "./resources/volume.js";
import { CertificateResourceType } from "./resources/certificate.js";
import { IpAllocationResourceType } from "./resources/ip-allocation.js";
import { AppSecretResourceType } from "./resources/app-secret.js";
import { PostgresClusterResourceType } from "./resources/postgres-cluster.js";
import { flyTerraformExport } from "./terraform.js";
import { flyRemediationCommands } from "./remediation.js";

export const manifest = {
  id: "fly",
  egressHosts: ["api.machines.dev", "api.fly.io"],
  displayName: "Fly.io",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#7B3BE2"/>
    <g transform="translate(15,18) scale(0.7)">
      <path d="M50 10 L85 35 L85 70 L50 95 L15 70 L15 35 Z" fill="white" opacity="0.9"/>
      <path d="M50 25 L72 40 L72 62 L50 78 L28 62 L28 40 Z" fill="#7B3BE2"/>
      <path d="M50 38 L60 45 L60 57 L50 64 L40 57 L40 45 Z" fill="white"/>
    </g>
  </svg>`,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Fly.io API token. Generate one with `fly tokens create` or from the Fly.io dashboard under Account → Access Tokens.",
      sensitive: true,
      placeholder: "",
    },
    {
      key: "orgSlug",
      label: "Organization Slug",
      description:
        'The Fly.io organization slug. Use "personal" for your personal account, or the org slug from your Fly.io dashboard.',
      sensitive: false,
      placeholder: "personal",
      defaultValue: "personal",
    },
    caCertCredentialField,
  ]),
  statusFeed,
  // CI jobs on a Machine of their own that destroys itself (`cloud: fly/container`).
  // See `ci-executor.ts`.
  ciExecutor: FLY_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [
  AppResourceType,
  MachineResourceType,
  VolumeResourceType,
  CertificateResourceType,
  IpAllocationResourceType,
  AppSecretResourceType,
  PostgresClusterResourceType,
];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new FlyClient(credentials, resourceTypes, services),
  testCredentials: { apiToken: "test-fly-token", orgSlug: "personal" },
  parseStatusFeed,
  terraformExport: flyTerraformExport,
  remediationCommands: flyRemediationCommands,
});
