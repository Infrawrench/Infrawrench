import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { errorText, QdrantApi } from "./api.js";
import { QdrantCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { qdrantTerraformExport } from "./terraform.js";
import type { QcAccount } from "./types.js";

const manifest: PluginManifest = {
  id: "qdrant-cloud",
  version: "0.1.0",
  displayName: "Qdrant Cloud",
  description:
    "Managed Qdrant vector database. Create, resize, scale, upgrade, suspend and restart clusters with region and package pickers; manage database API keys, backups, backup schedules and restores, hybrid cloud environments and collections. Billed spend from Qdrant's metering, credits, quotas, cluster metrics, logs and alerts.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
    caCertCredentialField,
  ],
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
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "accountId") return [];
  const key = (credentials["apiKey"] ?? "").trim();
  if (!key) throw new Error("Enter the Cloud Management Key first.");
  const api = new QdrantApi(key, credentials["caCert"] ?? "", services);
  try {
    const res = await api.cloud<{ items?: QcAccount[] }>("/api/account/v1/accounts");
    return (res?.items ?? [])
      .map((a) => ({ id: a.id, label: a.name || a.id, description: a.ownerEmail || a.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    throw new Error(`Qdrant Cloud did not list accounts for this key: ${errorText(e)}`);
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new QdrantCloudClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
  terraformExport: qdrantTerraformExport,
  listCredentialOptions,
};
