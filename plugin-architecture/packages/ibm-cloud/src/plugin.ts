import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { IbmApi } from "./api.js";
import { IbmCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import {
  DEFAULT_REGION,
  HOME_REGION_OPTIONS,
  VPC_API_VERSION,
  regionInfo,
  vpcBase,
} from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { ibmTerraformExport } from "./terraform.js";
import { ibmRemediationCommands } from "./remediation.js";

const API_KEY_DOCS = "https://cloud.ibm.com/docs/account?topic=account-userapikey";

export const manifest = {
  id: "ibm-cloud",
  // IAM, VPC (*.iaas.cloud.ibm.com), Kubernetes Service, Code Engine, Cloud Databases, Resource Controller, billing, COS config and the status feed are under cloud.ibm.com; COS S3 endpoints are under cloud-object-storage.appdomain.cloud
  egressHosts: ["iam.cloud.ibm.com", "*.cloud.ibm.com", "*.cloud-object-storage.appdomain.cloud"],
  displayName: "IBM Cloud",
  description:
    "IBM Cloud. Virtual Servers for VPC, block volumes, VPCs, subnets, security groups, floating IPs, load balancers and SSH keys across every region, Kubernetes Service and Red Hat OpenShift clusters, Code Engine projects and apps, Cloud Object Storage buckets, Cloud Databases, every other service instance and resource groups, with monthly billed spend and promotional credit.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "In the IBM Cloud console open Manage, then Access (IAM), then API keys, and create a key (or create a service ID with an API key). Its owner needs Viewer on the services to list them, Editor or Operator on the ones you want to change, and Viewer on Billing for costs and credits.",
      sensitive: true,
      placeholder: "44-character API key",
      helpLink: { label: "Create an API key", url: API_KEY_DOCS },
    },
    {
      key: "region",
      label: "Default Region",
      description:
        "Where new resources default to. Resources in every region are listed regardless.",
      sensitive: false,
      defaultValue: DEFAULT_REGION,
      regions: HOME_REGION_OPTIONS,
    },
    {
      key: "regions",
      label: "Regions to Scan",
      description: "Leave empty to scan every VPC region. Picking a few makes listing faster.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiKey", "region"], multiple: true },
    },
    caCertCredentialField,
  ]),
  // Usage Reports v4: billed cost per resource instance, plan and metric,
  // monthly only, so rows are dated to the 1st.
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 40,
    periodNative: true,
  },
  credits: {
    label: "Promotional credit",
    topUpUrl: "https://cloud.ibm.com/billing/promotions",
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 8 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

async function listRegionOptions(
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  const apiKey = (credentials["apiKey"] ?? "").trim();
  if (!apiKey) throw new Error("Enter the API key first.");
  const api = new IbmApi(apiKey, services?.http, credentials["caCert"] ?? "");
  const home = (credentials["region"] ?? "").trim() || DEFAULT_REGION;
  const res = await api.get<{ regions?: Array<{ name: string }> }>(`${vpcBase(home)}/regions`, {
    version: VPC_API_VERSION,
    generation: 2,
  });
  return (res.regions ?? []).map((r) => ({
    id: r.name,
    label: regionInfo(r.name)?.label ?? r.name,
    description: r.name,
  }));
}

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new IbmCloudClient(credentials, services),
  testCredentials: { apiKey: "test-api-key", region: "us-south" },
  parseStatusFeed,
  terraformExport: ibmTerraformExport,
  remediationCommands: ibmRemediationCommands,
  listCredentialOptions(fieldKey, credentials, services) {
    return attempt(async () => {
      if (fieldKey !== "regions") return [];
      return listRegionOptions(credentials, services);
    });
  },
});
