import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attemptFn } from "@infrawrench/plugin-base/effect";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { LinodeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { LINODE_PREFLIGHT, linodePolicyTemplate } from "./preflight.js";
import {
  ImageResourceType,
  LinodeInstanceResourceType,
  StackScriptResourceType,
} from "./resources/compute.js";
import {
  DomainRecordResourceType,
  DomainResourceType,
  FirewallResourceType,
  NodeBalancerResourceType,
  ReservedIpResourceType,
  VpcResourceType,
} from "./resources/networking.js";
import {
  AccountResourceType,
  DatabaseResourceType,
  InvoiceResourceType,
  LkeClusterResourceType,
  LkeNodePoolResourceType,
} from "./resources/platform.js";
import { BucketResourceType, VolumeResourceType } from "./resources/storage.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { fetchLinodePriceCatalog, linodePriceCatalog } from "./price-catalog.js";
import { linodeTerraformExport } from "./terraform.js";
import { linodeRemediationCommands } from "./remediation.js";
import { LINODE_CI_EXECUTOR } from "./ci-executor.js";

export const manifest = {
  id: "linode",
  // The REST API, Cloud Pulse metrics, and the pre-signed Object Storage
  // URLs the bucket browser uploads to and deletes through.
  egressHosts: ["api.linode.com", "monitor-api.linode.com", "*.linodeobjects.com"],
  displayName: "Linode (Akamai Cloud)",
  description:
    "Akamai Cloud Computing, formerly Linode. Billed spend by service, resource and region, credit burndown, and Linodes, Block Storage, NodeBalancers, LKE, Object Storage, Managed Databases, Cloud Firewalls, DNS, VPCs, reserved IPs, images and StackScripts.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "Personal Access Token",
      description:
        "Create one in Cloud Manager under your profile, API Tokens. Read Only on Account is enough for costs; give Read/Write elsewhere to manage resources. Check credentials to see missing scopes.",
      sensitive: true,
      placeholder: "64 hexadecimal characters",
      helpLink: {
        label: "Create a personal access token",
        url: "https://cloud.linode.com/profile/tokens",
      },
    },
    caCertCredentialField,
  ]),
  /**
   * Billed spend from closed invoices (items spread over the days they
   * cover, tax and credits as their own charge types) plus the open billing
   * period, totalled to Linode's own uninvoiced balance with a breakdown
   * priced from inventory. See `cost-data.ts`. `restatementDays: 62` keeps
   * the previous month's 1st inside every incremental window so the invoice,
   * when it lands, replaces that month's estimate.
   */
  costs: {
    dimensions: ["service", "region", "resource"],
    maxHistoryDays: 365,
    restatementDays: 62,
    chargeTypes: true,
  },
  credits: {
    label: "Promotions and account credit",
    topUpUrl: "https://cloud.linode.com/account/billing",
  },
  preflight: LINODE_PREFLIGHT,
  statusFeed,
  // Plan list prices from the public /linode/types. See price-catalog.ts.
  priceCatalog: linodePriceCatalog,
  // Linode rate-limits per token and per endpoint; listers fan out at most 8 wide.
  rateLimit: { capacity: 40, refillPerSecond: 10 },
  // CI jobs on a fresh machine per job. See ci-executor.ts.
  ciExecutor: LINODE_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [
  LinodeInstanceResourceType,
  VolumeResourceType,
  NodeBalancerResourceType,
  LkeClusterResourceType,
  LkeNodePoolResourceType,
  BucketResourceType,
  DatabaseResourceType,
  FirewallResourceType,
  VpcResourceType,
  ReservedIpResourceType,
  DomainResourceType,
  DomainRecordResourceType,
  ImageResourceType,
  StackScriptResourceType,
  AccountResourceType,
  InvoiceResourceType,
];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new LinodeClient(credentials, resourceTypes, services),
  testCredentials: { apiToken: "test-linode-token" },
  terraformExport: linodeTerraformExport,
  remediationCommands: linodeRemediationCommands,
  parseStatusFeed,
  policyTemplate: linodePolicyTemplate,
  fetchPriceCatalog: attemptFn(fetchLinodePriceCatalog),
});
