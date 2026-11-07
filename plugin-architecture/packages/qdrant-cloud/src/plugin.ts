import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attemptFn } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField, pathEncode } from "@infrawrench/plugin-base";
import {
  createCloudApi,
  endpointHost,
  errorText,
  isQdrantCloudHost,
  type QdrantCloudApi,
} from "./api.js";
import { QdrantCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { qdrantTerraformExport } from "./terraform.js";
import { qdrantRemediationCommands } from "./remediation.js";

export const manifest = {
  id: "qdrant-cloud",
  // cluster database endpoints are per-cluster subdomains of cloud.qdrant.io (port 6333); hybrid clusters use the customer's own endpoint,
  // which a bastion allows once it is picked in clusterHosts
  egressHosts: ["api.cloud.qdrant.io", "*.cloud.qdrant.io"],
  displayName: "Qdrant Cloud",
  description:
    "Managed Qdrant vector database. Create, resize, scale, upgrade, suspend and restart clusters with region and package pickers; manage database API keys, backups, backup schedules and restores, hybrid cloud environments and collections. Billed spend from Qdrant's metering, credits, quotas, cluster metrics, logs and alerts.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "Cloud Management Key",
      description:
        "In the Qdrant Cloud console open Access Management, Cloud Management Keys, and create a key. Give its role read and write access to clusters, backups, API keys and hybrid cloud, plus read:payment_information for costs and credits. This is not a database API key.",
      sensitive: true,
      placeholder: "Cloud Management Key from Access Management",
      helpLink: {
        label: "Create a Cloud Management Key",
        url: "https://cloud.qdrant.io/",
      },
    },
    {
      key: "accountId",
      label: "Account",
      description: "The Qdrant Cloud account the key belongs to, listed from the key.",
      sensitive: false,
      placeholder: "8f4e8b4a-0000-0000-0000-000000000000",
      providerOptions: { dependsOn: ["apiKey"] },
    },
    {
      key: "clusterHosts",
      providerHost: true,
      label: "Hybrid Cluster Endpoints",
      description:
        "Only needed behind a bastion, for hybrid cloud clusters, whose database endpoint is on your own host rather than cloud.qdrant.io. Pick those hosts so the bastion lets collection reads and edits through. Public addresses only.",
      sensitive: false,
      optional: true,
      advanced: true,
      providerOptions: { dependsOn: ["apiKey", "accountId"], multiple: true },
    },
    caCertCredentialField,
  ]),
  /**
   * `GET /api/metering/v1/accounts/{id}/meterings/{year}/{month}`: billed
   * metering windows per cluster and billable entity (cluster, extra disk,
   * storage tier, backup, inference), net of discounts, spread over the UTC
   * days each window covers.
   */
  costs: { dimensions: ["service", "resource", "tag"], maxHistoryDays: 365, restatementDays: 3 },
  credits: { label: "Qdrant Cloud credits", topUpUrl: "https://cloud.qdrant.io/billing" },
  quotas: { label: "Account quotas", increaseUrl: "https://qdrant.tech/documentation/support/" },
  statusFeed,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

/** Each cluster endpoint host a bastion does not already allow, with the clusters on it. */
async function clusterHostOptions(
  api: QdrantCloudApi,
  accountId: string,
): Promise<CredentialFieldOption[]> {
  const clusters = await api.getAll(
    `/api/cluster/v1/accounts/${pathEncode(accountId)}/clusters`,
    "items",
  );
  const byHost = new Map<string, string[]>();
  for (const c of clusters) {
    const written = c.deletedAt ? "" : (c.state?.endpoint?.url ?? "");
    if (!written) continue;
    const host = endpointHost(/^https?:\/\//.test(written) ? written : `https://${written}`);
    if (!host || isQdrantCloudHost(host)) continue;
    byHost.set(host, [...(byHost.get(host) ?? []), c.name || c.id]);
  }
  return [...byHost]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, names]) => ({ id: host, label: host, description: names.join(", ") }));
}

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "accountId" && fieldKey !== "clusterHosts") return [];
  const key = (credentials["apiKey"] ?? "").trim();
  if (!key) throw new Error("Enter the Cloud Management Key first.");
  const api = createCloudApi(key, { caCert: credentials["caCert"] ?? "", http: services?.http });
  if (fieldKey === "clusterHosts") {
    const accountId = (credentials["accountId"] ?? "").trim();
    if (!accountId) throw new Error("Pick the Account first.");
    try {
      return await clusterHostOptions(api, accountId);
    } catch (e) {
      throw new Error(`Qdrant Cloud did not list clusters for this account: ${errorText(e)}`);
    }
  }
  try {
    const res = await api.get("/api/account/v1/accounts");
    return (res?.items ?? [])
      .map((a) => ({ id: a.id, label: a.name || a.id, description: a.ownerEmail || a.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    throw new Error(`Qdrant Cloud did not list accounts for this key: ${errorText(e)}`);
  }
}

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new QdrantCloudClient(credentials, RESOURCE_TYPES, services),
  testCredentials: {
    apiKey: "test-qdrant-management-key",
    accountId: "00000000-0000-0000-0000-000000000001",
  },
  parseStatusFeed,
  terraformExport: qdrantTerraformExport,
  remediationCommands: qdrantRemediationCommands,
  listCredentialOptions: attemptFn(listCredentialOptions),
});
