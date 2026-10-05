import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { contextFromCredentials, isPermissionError, listOrgs } from "./api.js";
import { MongoDBAtlasClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { mongodbAtlasTerraformExport } from "./terraform.js";
import { mongodbAtlasRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "mongodb-atlas",
  version: "0.1.0",
  displayName: "MongoDB Atlas",
  description:
    "MongoDB's managed database cloud. Track spend by service, project and cluster, and manage clusters, database users, the IP access list, backups, alerts, search indexes, online archives and private endpoints.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "clientId",
      label: "Client ID or Public Key",
      description:
        "A service account's client ID (it starts with mdb_sa_id_), or a programmatic API key's public key. Create one under Organization Access Manager, Service Accounts, with Organization Read Only plus Organization Billing Viewer for costs (Project Owner to make changes).",
      sensitive: false,
      placeholder: "mdb_sa_id_…",
      helpLink: {
        label: "Atlas service accounts",
        url: "https://www.mongodb.com/docs/atlas/configure-api-access/#grant-programmatic-access-to-an-organization",
      },
    },
    {
      key: "clientSecret",
      label: "Client Secret or Private Key",
      description:
        "The service account's client secret (mdb_sa_sk_…), or the API key's private key. If your organization requires an API access list, add Infrawrench's address to it.",
      sensitive: true,
    },
    {
      key: "orgId",
      label: "Organization",
      description:
        "The Atlas organization to read. Projects, clusters and invoices are all read from this organization.",
      sensitive: false,
      providerOptions: { dependsOn: ["clientId", "clientSecret"] },
      placeholder: "Organization ID",
    },
    caCertCredentialField,
  ],
  costs: {
    // Invoice line items: SKU category -> service, `{groupId}/{clusterName}`
    // -> resource, project/cluster/SKU/cloud and Atlas resource tags -> tags.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 730,
    // The pending invoice moves all month and a month's invoice closes a few
    // days after it ends; 35 days re-reads the whole of both.
    restatementDays: 35,
    chargeTypes: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 2 },
};

/**
 * Options for the organization picker: every organization the credential can
 * see. A service account belongs to one organization, so this usually
 * auto-picks; an API key or a user-level key may see several.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "orgId") return [];
  if (!(credentials["clientId"] ?? "").trim() || !(credentials["clientSecret"] ?? "").trim()) {
    throw new Error("Enter the client ID and secret first.");
  }
  const ctx = contextFromCredentials(credentials, services?.http);
  try {
    const orgs = await listOrgs(ctx);
    if (orgs.length === 0) throw new Error("The credential can see no Atlas organization.");
    return orgs.map((o) => ({ id: o.id, label: o.name, description: o.id }));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        "MongoDB Atlas rejected the credential. Check the client ID and secret (or public and private key), and that the organization's API access list allows this address.",
      );
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new MongoDBAtlasClient(credentials, services),
  parseStatusFeed,
  terraformExport: mongodbAtlasTerraformExport,
  listCredentialOptions,
  remediationCommands: mongodbAtlasRemediationCommands,
};
