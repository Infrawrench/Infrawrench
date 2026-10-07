import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { WeaviateClient } from "./client.js";
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
const manifest: PluginManifest = {
  id: "weaviate-cloud",
  version: "0.1.0",
  displayName: "Weaviate Cloud",
  description:
    "Weaviate vector database clusters on Weaviate Cloud or self-hosted, many per account. List and create Weaviate Cloud clusters through a wcloud sign-in, then manage collections with their vectorizers, properties, replication and tenancy, tenants, aliases, backups, database users with key rotation, and RBAC roles. Node health, object and shard counts as metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
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
        "Further clusters on this account, one per line: the REST endpoint, a space, then its API key. Clusters connected from Infrawrench are added here, and removing a line disconnects that cluster.",
      sensitive: true,
      optional: true,
      multiline: true,
      placeholder: "https://<cluster-host> <api-key>",
    },
    caCertCredentialField,
  ],
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) =>
    new WeaviateClient(credentials, RESOURCE_TYPES, services),
};
