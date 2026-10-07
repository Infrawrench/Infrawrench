import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { WeaviateClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/**
 * No `statusFeed`: status.weaviate.cloud is an incident.io page whose
 * Statuspage-compatible API answers `{"page": null}` and whose advertised
 * RSS/Atom feeds 404 (checked 2026-10), so there is nothing to parse.
 * No `costs`, no `terraformExport`: Weaviate Cloud has no public management,
 * billing or Terraform surface.
 */
const manifest: PluginManifest = {
  id: "weaviate-cloud",
  version: "0.1.0",
  displayName: "Weaviate Cloud",
  description:
    "Weaviate vector database clusters (Weaviate Cloud or self-hosted). Manage collections with their vectorizers, properties, replication and tenancy, tenants, aliases, backups, database users with key rotation, and RBAC roles. Node health, object and shard counts as metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "endpoint",
      label: "REST Endpoint",
      description:
        "In the Weaviate Cloud console open the cluster and copy the REST Endpoint from its details panel. For a self-hosted cluster, its base URL.",
      sensitive: false,
      placeholder: "https://abc123.c0.europe-west3.gcp.weaviate.cloud",
      helpLink: {
        label: "Open the Weaviate Cloud console",
        url: "https://console.weaviate.cloud/",
      },
    },
    {
      key: "apiKey",
      label: "API Key",
      description:
        "In the cluster's details panel open API Keys, then New key, and copy it (shown once). Use an Admin key, or a key whose user has the admin role, so collections, users and roles can be managed; a ReadOnly key lists everything but cannot change it. Leave empty only for a self-hosted cluster with anonymous access.",
      sensitive: true,
      optional: true,
      placeholder: "Admin API key from the cluster details panel",
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
