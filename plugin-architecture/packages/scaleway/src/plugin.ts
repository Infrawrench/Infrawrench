import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { ScalewayClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { InstanceResourceType } from "./resources/instance.js";
import { KapsuleClusterResourceType } from "./resources/kapsule-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { ObjectStorageResourceType } from "./resources/object-storage.js";
import { BlockVolumeResourceType } from "./resources/block-volume.js";
import { scalewayTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "scaleway",
  version: "0.1.0",
  displayName: "Scaleway",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#4F0599"/>
    <g transform="translate(14,16) scale(3)" fill="white">
      <path d="M16.605 11.11v5.72a1.77 1.77 0 01-1.54 1.69h-4a1.43 1.43 0 01-1.31-1.22 1.09 1.09 0 010-.18 1.37 1.37 0 011.37-1.36h1.74a1 1 0 001-1v-3.62a1.4 1.4 0 011.18-1.39h.17a1.37 1.37 0 011.39 1.36zm-6.46 1.74V9.26a1 1 0 011-1h1.85a1.37 1.37 0 001.37-1.37 1 1 0 000-.17 1.45 1.45 0 00-1.41-1.2h-3.96a1.81 1.81 0 00-1.58 1.66v5.7a1.37 1.37 0 001.37 1.37h.21a1.4 1.4 0 001.15-1.4zm12-4.29V20a4.53 4.53 0 01-4.15 4h-7.58a8.57 8.57 0 01-8.56-8.57V4.54A4.54 4.54 0 016.395 0h7.18a8.56 8.56 0 018.56 8.56zm-2.74 0a5.83 5.83 0 00-5.82-5.82h-7.19a1.79 1.79 0 00-1.8 1.8v10.89a5.83 5.83 0 005.82 5.8h7.44a1.79 1.79 0 001.54-1.48z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKey",
      label: "Access Key",
      description: "Your Scaleway access key (starts with SCW...).",
      sensitive: false,
      placeholder: "SCWXXXXXXXXXXXXXXXXX",
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description: "Your Scaleway secret key (UUID format).",
      sensitive: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "defaultProjectId",
      label: "Default Project ID",
      description:
        "Your Scaleway project ID (UUID). Found in the Scaleway console under Project Settings.",
      sensitive: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "cockpitQueryToken",
      label: "Cockpit Query Token (optional)",
      description:
        "Optional Scaleway Cockpit token with the `query_metrics` scope. When set, the resource Metrics tab populates from Cockpit. Create one at console.scaleway.com under Observability → Tokens.",
      sensitive: true,
      optional: true,
    },
  ],
  // Billing API v2beta1 monthly consumptions, broken down by product +
  // resource + project. Scoped to the Default Project ID credential (the
  // endpoint takes exactly one of project_id/organization_id and the plugin
  // stores no organization ID). The IAM `BillingReadOnly` permission set is
  // sufficient.
  costs: {
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 5,
    periodNative: true,
  },
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  InstanceResourceType,
  KapsuleClusterResourceType,
  ManagedDatabaseResourceType,
  ObjectStorageResourceType,
  BlockVolumeResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new ScalewayClient(credentials, resourceTypes, services),
  parseStatusFeed,
  terraformExport: scalewayTerraformExport,
};
