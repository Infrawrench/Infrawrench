import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { NATS_PREFLIGHT, NatsClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { natsTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "nats",
  version: "0.1.0",
  displayName: "NATS",
  description:
    "Self-hosted NATS through a server's monitoring endpoint: server health and limits, routes, gateways and leaf nodes, accounts, connections, and JetStream streams, key-value buckets and consumers with their progress. Read only.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "url",
      label: "Monitoring URL",
      description:
        "The server's HTTP monitoring endpoint, not the client port: http://nats.internal:8222 (enable it with http_port: 8222 in the server config, or -m 8222). Include the http_base_path if one is set. For a server on a private network, add an SSH tunnel to this account.",
      sensitive: false,
      placeholder: "http://nats.internal:8222",
    },
    {
      key: "username",
      label: "Username",
      description:
        "Only if a reverse proxy in front of the monitoring port asks for basic auth; nats-server itself has none there.",
      sensitive: false,
      optional: true,
      advanced: true,
    },
    { key: "password", label: "Password", sensitive: true, optional: true, advanced: true },
    {
      key: "token",
      label: "Bearer Token",
      description:
        "Only if a reverse proxy in front of the monitoring port expects a bearer token.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    caCertCredentialField,
  ],
  preflight: NATS_PREFLIGHT,
  quotas: { label: "Server limits", partial: true },
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new NatsClient(credentials, services),
  terraformExport: natsTerraformExport,
};
