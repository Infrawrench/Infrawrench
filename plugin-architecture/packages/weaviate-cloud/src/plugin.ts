import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import type { CredentialFieldOption } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { attempt } from "@infrawrench/plugin-base/effect";
import { CLUSTER_HOSTS_LABEL, endpointHost, isWeaviateCloudHost } from "./api.js";
import { parseClusterLines, WeaviateClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/**
 * No `statusFeed`: status.weaviate.cloud is an incident.io page titled
 * "Weaviate Enterprise status" that renders "We couldn't find that page";
 * its Statuspage-compatible API answers `{"page": null}`, `feed.rss` 404s
 * and `feed.atom` is a valid but empty feed (checked 2026-10-07), so there
 * is nothing to parse. No `costs`, no `terraformExport`: Weaviate has no
 * billing API and no Terraform provider.
 */
export const manifest = {
  id: "weaviate-cloud",
  // Weaviate Cloud clusters and its provisioning API (api-cloud, auth) live under weaviate.cloud, older clusters under weaviate.network; self-hosted endpoints are user-supplied,
  // and a bastion allows them from endpoint and the hosts picked in clusterHosts
  egressHosts: ["*.weaviate.cloud", "*.weaviate.network"],
  displayName: "Weaviate Cloud",
  description:
    "Weaviate vector database clusters on Weaviate Cloud or self-hosted, many per account. List and create Weaviate Cloud clusters through a wcloud sign-in, then manage collections with their vectorizers, properties, replication and tenancy, tenants, aliases, backups, database users with key rotation, and RBAC roles. Node health, object and shard counts as metrics.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "cloudToken",
      label: "Weaviate Cloud Sign-in",
      description:
        "Lists and creates your organization's clusters. Install the official wcloud CLI, run `wcloud auth login`, then paste the refresh_token from wcloud/credentials.json in your user config folder (or paste the whole file). Leave empty to connect clusters by endpoint only.",
      sensitive: true,
      optional: true,
      multiline: true,
      placeholder: "refresh_token from wcloud/credentials.json",
      helpLink: {
        label: "Get the wcloud CLI",
        url: "https://github.com/weaviate/weaviate-cloud#install",
      },
    },
    {
      key: "endpoint",
      providerHost: true,
      label: "REST Endpoint",
      description:
        "A cluster to connect directly: in the Weaviate Cloud console open the cluster and copy the REST Endpoint from its details panel. For a self-hosted cluster, its base URL. Optional when a sign-in is set.",
      sensitive: false,
      optional: true,
      placeholder: "https://<cluster-id>.c0.<region>.gcp.weaviate.cloud",
      helpLink: {
        label: "Open the Weaviate Cloud console",
        url: "https://console.weaviate.cloud/",
      },
    },
    {
      key: "apiKey",
      label: "API Key",
      description:
        "The REST Endpoint cluster's key: in its details panel open API Keys, then New key, and copy it (shown once). Use an Admin key, or a key whose user has the admin role, so collections, users and roles can be managed; a ReadOnly key lists everything but cannot change it. Leave empty only for a self-hosted cluster with anonymous access.",
      sensitive: true,
      optional: true,
      placeholder: "Admin API key from the cluster details panel",
    },
    {
      key: "clusters",
      label: "More Clusters",
      description:
        "Further clusters on this account, one per line: the REST endpoint, a space, then its API key. Clusters connected from Infrawrench are added here, and removing a line disconnects that cluster. Behind a bastion, pick self-hosted ones under Self-Hosted Cluster Hosts too.",
      sensitive: true,
      optional: true,
      multiline: true,
      placeholder: "https://<cluster-host> <api-key>",
    },
    {
      // Its own field because More Clusters holds the keys too, and the bastion
      // allowlist reads only non-sensitive host fields.
      key: "clusterHosts",
      providerHost: true,
      label: CLUSTER_HOSTS_LABEL,
      description:
        "Only needed behind a bastion, for self-hosted clusters listed under More Clusters, whose hosts are your own rather than weaviate.cloud. Pick those hosts so the bastion lets them through. Public addresses only.",
      sensitive: false,
      optional: true,
      advanced: true,
      providerOptions: { dependsOn: ["clusters"], multiple: true },
    },
    caCertCredentialField,
  ]),
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

/**
 * Each More Clusters host a bastion does not already allow, with the endpoints on it.
 * Read from the field itself, with no request; only hosts leave it, never a key.
 */
export function clusterHostOptions(credentials: Record<string, string>): CredentialFieldOption[] {
  const primary = endpointHost(credentials["endpoint"] ?? "");
  const byHost = new Map<string, string[]>();
  for (const { endpoint } of parseClusterLines(credentials["clusters"])) {
    const host = endpointHost(endpoint);
    if (!host || host === primary || isWeaviateCloudHost(host)) continue;
    const seen = byHost.get(host) ?? [];
    if (!seen.includes(endpoint)) byHost.set(host, [...seen, endpoint]);
  }
  return [...byHost]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, endpoints]) => ({ id: host, label: host, description: endpoints.join(", ") }));
}

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new WeaviateClient(credentials, RESOURCE_TYPES, services),
  listCredentialOptions: (fieldKey, credentials) =>
    attempt(async () => {
      if (fieldKey !== "clusterHosts") return [];
      return clusterHostOptions(credentials);
    }),
  testCredentials: {
    endpoint: "https://test.c0.europe-west3.gcp.weaviate.cloud",
    apiKey: "test-weaviate-key",
  },
});
