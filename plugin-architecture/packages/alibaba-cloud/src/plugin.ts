import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { AliApi } from "./api.js";
import { AlibabaCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { ALI_REGIONS, DEFAULT_REGION, HOME_REGION_OPTIONS, regionInfo } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { alibabaTerraformExport } from "./terraform.js";
import { alibabaRemediationCommands } from "./remediation.js";

const ACCESS_KEY_DOCS =
  "https://www.alibabacloud.com/help/en/ram/user-guide/create-an-accesskey-pair";

const manifest: PluginManifest = {
  id: "alibaba-cloud",
  version: "0.1.0",
  displayName: "Alibaba Cloud",
  description:
    "Alibaba Cloud (international site). ECS instances, disks, snapshots, VPCs, vSwitches, security groups, Elastic IPs, Classic and Application Load Balancers, ApsaraDB RDS, Tair (Redis), OSS buckets, ACK clusters, Function Compute, Alibaba Cloud DNS and RAM users across every region, with CloudMonitor metrics, daily billed spend, the account balance and Quota Center limits.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKeyId",
      label: "AccessKey ID",
      description:
        "In the RAM console, open Identities, then Users, pick (or create) a user with OpenAPI access and create an AccessKey. Grant it ReadOnlyAccess to browse, AliyunBSSReadOnlyAccess for costs and AliyunQuotasReadOnlyAccess for quotas; add the service FullAccess policies (AliyunECSFullAccess and so on) for whatever you want to create and edit.",
      sensitive: false,
      placeholder: "LTAI5t…",
      helpLink: { label: "Create an AccessKey", url: ACCESS_KEY_DOCS },
    },
    {
      key: "accessKeySecret",
      label: "AccessKey Secret",
      description: "Shown once, when the AccessKey is created.",
      sensitive: true,
      placeholder: "30-character secret",
    },
    {
      key: "region",
      label: "Default Region",
      description:
        "Where new resources default to and where account-wide calls (region list, quotas) are made. Resources in every region are listed regardless.",
      sensitive: false,
      defaultValue: DEFAULT_REGION,
      regions: HOME_REGION_OPTIONS,
    },
    {
      key: "regions",
      label: "Regions to Scan",
      description:
        "Leave empty to scan every region open to the account. Picking a few makes listing faster.",
      sensitive: false,
      optional: true,
      providerOptions: {
        dependsOn: ["accessKeyId", "accessKeySecret", "region"],
        multiple: true,
      },
    },
    caCertCredentialField,
  ],
  // DescribeInstanceBill, DAILY: PretaxAmount (after discounts and coupons)
  // per product, region and instance, with resource tags. 18 months of
  // history; the current month is provisional until the 3rd of the next.
  costs: {
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 540,
    restatementDays: 35,
    chargeTypes: true,
  },
  credits: {
    label: "Account balance",
    topUpUrl: "https://usercenter2-intl.aliyun.com/billing/#/account/overview",
  },
  quotas: {
    label: "Quota Center",
    increaseUrl: "https://quotas.console.alibabacloud.com/",
    partial: true,
  },
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 8 },
};

async function listRegionOptions(
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  const accessKeyId = (credentials["accessKeyId"] ?? "").trim();
  const accessKeySecret = (credentials["accessKeySecret"] ?? "").trim();
  if (!accessKeyId || !accessKeySecret) throw new Error("Enter the AccessKey ID and secret first.");
  const api = new AliApi(
    { accessKeyId, accessKeySecret },
    services?.http,
    credentials["caCert"] ?? "",
  );
  const res = await api.rpc<{
    Regions?: { Region?: Array<{ RegionId: string; LocalName?: string }> };
  }>("ecs", (credentials["region"] ?? "").trim() || DEFAULT_REGION, "DescribeRegions", {
    AcceptLanguage: "en-US",
  });
  const known = new Set(ALI_REGIONS.map((r) => r.id));
  return (res.Regions?.Region ?? [])
    .filter((r) => known.has(r.RegionId))
    .map((r) => ({
      id: r.RegionId,
      label: regionInfo(r.RegionId)?.label ?? r.LocalName ?? r.RegionId,
      description: r.RegionId,
    }));
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AlibabaCloudClient(credentials, services),
  parseStatusFeed,
  terraformExport: alibabaTerraformExport,
  remediationCommands: alibabaRemediationCommands,
  async listCredentialOptions(fieldKey, credentials, services) {
    if (fieldKey !== "regions") return [];
    return listRegionOptions(credentials, services);
  },
};
