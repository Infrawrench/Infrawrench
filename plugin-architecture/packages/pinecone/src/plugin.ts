import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { errorText, PineconeApi } from "./api.js";
import { PineconeClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { pineconeTerraformExport } from "./terraform.js";
import { pineconeRemediationCommands } from "./remediation.js";
import type { PcProject } from "./types.js";

const manifest: PluginManifest = {
  id: "pinecone",
  version: "0.1.0",
  displayName: "Pinecone",
  description:
    "Vector database. Manage serverless and pod-based indexes (read capacity, replicas, pod size, deletion protection, tags), backups, backup schedules and restores, collections, assistants with a chat playground, and, with a service account, projects, API keys and service accounts. Index stats and Prometheus counters as metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "A project API key from the Pinecone console: open the project, then API keys, then Create API key. Give it the ProjectEditor role (the default) so indexes, backups and assistants can be managed; ProjectViewer is enough for read-only use. One account covers one project.",
      sensitive: true,
      placeholder: "pcsk_...",
      helpLink: {
        label: "Create a Pinecone API key",
        url: "https://app.pinecone.io/organizations/-/projects/-/keys",
      },
    },
    {
      key: "clientId",
      label: "Service Account Client ID (optional)",
      description:
        "Adds the organization's projects, API keys and service accounts. In the console go to Organization settings, Access, Service accounts, create one with the Organization Owner or Organization Manager role, and copy its client ID.",
      sensitive: false,
      optional: true,
      placeholder: "I1r8m4i6jX9JTFYk0t3q85HWzciEgcA5",
      helpLink: {
        label: "Create a service account",
        url: "https://app.pinecone.io/organizations/-/settings/access/service-accounts",
      },
    },
    {
      key: "clientSecret",
      label: "Service Account Client Secret (optional)",
      description: "The client secret shown once when the service account is created (or rotated).",
      sensitive: true,
      optional: true,
      placeholder: "EriX...j2ci",
    },
    {
      key: "projectId",
      label: "Project (optional)",
      description:
        "The project the API key belongs to. Needed for Prometheus metrics (operation counts, read and write units) and the pod quota. Picked from the service account's projects, or copy the ID from the console URL after /projects/.",
      sensitive: false,
      optional: true,
      placeholder: "a2f7dddb-1597-4eff-9f71-535fde243f58",
      providerOptions: { dependsOn: ["clientId", "clientSecret"], emptyLabel: "Not set" },
    },
    caCertCredentialField,
  ],
  quotas: {
    label: "Project pod limit",
    increaseUrl: "https://app.pinecone.io/organizations/-/settings/projects",
    partial: true,
  },
  statusFeed,
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "projectId") return [];
  const clientId = (credentials["clientId"] ?? "").trim();
  const clientSecret = (credentials["clientSecret"] ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("Enter the service account client ID and secret first.");
  }
  const api = new PineconeApi(
    { apiKey: "", clientId, clientSecret, caCert: credentials["caCert"] ?? "" },
    services,
  );
  try {
    const res = await api.admin<{ data?: PcProject[] }>("/projects");
    return (res?.data ?? [])
      .map((p) => ({ id: p.id, label: p.name, description: p.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    throw new Error(`Pinecone did not list projects for this service account: ${errorText(e)}`);
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new PineconeClient(credentials, RESOURCE_TYPES, services),
  parseStatusFeed,
  terraformExport: pineconeTerraformExport,
  remediationCommands: pineconeRemediationCommands,
  listCredentialOptions,
};
