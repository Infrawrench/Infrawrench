import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { REGIONS, hostFor, influxJson } from "./api.js";
import { InfluxClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { influxRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "influxdb-cloud",
  version: "0.1.0",
  displayName: "InfluxDB Cloud",
  description:
    "Manage InfluxDB Cloud and Cloud Serverless buckets, API tokens, tasks, checks, notification rules and endpoints, dashboards and Telegraf configs, query buckets with InfluxQL or Flux, and manage InfluxDB 3 Cloud Dedicated databases and tokens.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "region",
      label: "Region",
      description:
        "The region your organization lives in: the host in your InfluxDB Cloud URL. Leave empty if you only use Cloud Dedicated.",
      sensitive: false,
      regions: REGIONS,
      optional: true,
    },
    {
      key: "token",
      label: "API Token",
      description:
        "An All Access API token: in the InfluxDB Cloud UI open Load Data, API Tokens, Generate API Token, All Access API Token. A custom token works too, limited to what it can read and write. Leave empty if you only use Cloud Dedicated.",
      sensitive: true,
      placeholder: "Token...==",
      optional: true,
      helpLink: {
        label: "Create an API token",
        url: "https://docs.influxdata.com/influxdb/cloud/admin/tokens/create-token/",
      },
    },
    {
      key: "orgId",
      label: "Organization",
      description: "The organization the token belongs to, listed from the token.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["region", "token"] },
    },
    {
      key: "dedicatedAccountId",
      label: "Cloud Dedicated Account ID",
      description:
        "For InfluxDB 3 Cloud Dedicated: the account ID InfluxData gave you (also in `influxctl` config.toml).",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "11111111-1111-4111-8111-111111111111",
    },
    {
      key: "dedicatedClusterId",
      label: "Cloud Dedicated Cluster ID",
      description: "The cluster ID, from `influxctl cluster list`.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "33333333-3333-4333-8333-333333333333",
    },
    {
      key: "dedicatedManagementToken",
      label: "Cloud Dedicated Management Token",
      description: "A long-lived management token from `influxctl management create`.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
  ],
  quotas: { label: "Plan limits", partial: true },
  statusFeed,
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new InfluxClient(credentials, services),
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  remediationCommands: influxRemediationCommands,
  async listCredentialOptions(
    fieldKey: string,
    credentials: Record<string, string>,
    services?: HostServices,
  ): Promise<CredentialFieldOption[]> {
    if (fieldKey !== "orgId") return [];
    const region = (credentials["region"] ?? "").trim();
    const token = (credentials["token"] ?? "").trim();
    if (!region || !token) throw new Error("Pick the region and enter the token first.");
    const res = await influxJson<{ orgs?: Array<{ id: string; name?: string }> }>(
      services?.http ? { http: services.http } : {},
      "GET",
      `${hostFor(region)}/api/v2/orgs`,
      `Token ${token}`,
    );
    return (res?.orgs ?? []).map((o) => ({ id: o.id, label: o.name ?? o.id, description: o.id }));
  },
};
