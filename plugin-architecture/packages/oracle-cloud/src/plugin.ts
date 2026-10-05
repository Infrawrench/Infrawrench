import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { OracleCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { DEFAULT_REGION, HOME_REGION_OPTIONS } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { ociPriceCatalog } from "./price-catalog.js";
import { ociTerraformExport } from "./terraform.js";
import { ociRemediationCommands } from "./remediation.js";

const API_KEY_DOCS = "https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm";

const manifest: PluginManifest = {
  id: "oracle-cloud",
  version: "0.1.0",
  displayName: "Oracle Cloud",
  description:
    "Oracle Cloud Infrastructure (OCI). Billed spend by service, SKU, region, resource and compartment, Universal Credits burndown, service limits, and Compute instances, block and boot volumes, VCNs, subnets, security lists, reserved IPs, load balancers, Object Storage, Autonomous Databases, OKE clusters and budgets across every subscribed region and compartment.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "tenancyOcid",
      label: "Tenancy OCID",
      description:
        "In the OCI Console, open the Profile menu, then Tenancy. Copy the OCID (it starts with ocid1.tenancy.).",
      sensitive: false,
      placeholder: "ocid1.tenancy.oc1..aaaa…",
      helpLink: { label: "Where to find your OCIDs", url: API_KEY_DOCS },
    },
    {
      key: "userOcid",
      label: "User OCID",
      description:
        "Profile menu, then My profile: the OCID of the user the API key belongs to (ocid1.user.).",
      sensitive: false,
      placeholder: "ocid1.user.oc1..aaaa…",
    },
    {
      key: "fingerprint",
      label: "API Key Fingerprint",
      description:
        "My profile, then API keys: add an API key (let the Console generate the pair and download the private key) and copy the fingerprint it shows.",
      sensitive: false,
      placeholder: "12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0",
    },
    {
      key: "privateKey",
      label: "Private Key",
      description:
        "The API key's private key, pasted whole (PEM, BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY). Passphrase-protected keys are not supported.",
      sensitive: true,
      multiline: true,
      placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
      helpLink: { label: "Generate an API signing key", url: API_KEY_DOCS },
    },
    {
      key: "region",
      label: "Home Region",
      description:
        "The tenancy's home region (Profile menu, then Tenancy). Every subscribed region is listed regardless; identity, cost and budget calls go to the home region.",
      sensitive: false,
      defaultValue: DEFAULT_REGION,
      regions: HOME_REGION_OPTIONS,
    },
    caCertCredentialField,
  ],
  // Usage API (POST /20200107/usage), queryType COST, DAILY: OCI's billed
  // amount (`computedAmount`) per service, SKU, region and resource, with the
  // resource's compartment path as a tag. Twelve months of history, up to 48
  // hours of lag with restatements, so the incremental window re-reads five
  // days.
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 5,
  },
  // OneSubscription commitments: remaining Universal Credits per subscribed
  // service. Tenancies on classic subscriptions report none.
  credits: {
    label: "Subscription commitments",
    topUpUrl: "https://cloud.oracle.com/billing/subscriptions",
  },
  // Regional service limits in the home region for networking, load
  // balancing, block storage, database, OKE and Object Storage.
  quotas: {
    label: "Service limits",
    increaseUrl: "https://cloud.oracle.com/limits",
    partial: true,
  },
  statusFeed,
  priceCatalog: ociPriceCatalog,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new OracleCloudClient(credentials, services),
  parseStatusFeed,
  terraformExport: ociTerraformExport,
  remediationCommands: ociRemediationCommands,
};
