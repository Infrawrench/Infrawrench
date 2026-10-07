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
    "Self-hosted NATS: server health and limits, routes, gateways and leaf nodes, accounts and connections from the monitoring endpoint, and through the client port JetStream streams, consumers, key-value buckets and object stores you can create, edit and delete, a message and key browser, and publish and request/reply.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "servers",
      label: "Server URL",
      description:
        "The client port: nats://nats.internal:4222, or tls://… when TLS is required. Separate several servers of one cluster with commas. Needed to publish and to create, edit and delete streams, consumers, buckets and object stores. For a server on a private network, add an SSH tunnel to this account.",
      sensitive: false,
      optional: true,
      placeholder: "nats://nats.internal:4222",
    },
    {
      key: "url",
      label: "Monitoring URL",
      description:
        "The server's HTTP monitoring endpoint: http://nats.internal:8222 (enable it with http_port: 8222 in the server config, or -m 8222). Include the http_base_path if one is set. Serves health, limits, routes, gateways, leaf nodes, accounts and connections. Set this, the server URL, or both.",
      sensitive: false,
      optional: true,
      placeholder: "http://nats.internal:8222",
    },
    {
      key: "natsUser",
      label: "User",
      description: "For a server with user and password authorization.",
      sensitive: false,
      optional: true,
    },
    { key: "natsPassword", label: "Password", sensitive: true, optional: true },
    {
      key: "natsToken",
      label: "Token",
      description: "For a server with token authorization (authorization { token: … }).",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    {
      key: "nkeySeed",
      label: "NKey Seed",
      description:
        "The user's NKey seed (the line starting SU in its .nk file), for NKey authentication.",
      sensitive: true,
      optional: true,
      advanced: true,
      placeholder: "SU...",
    },
    {
      key: "credsFile",
      label: "Credentials File",
      description:
        "The contents of a decentralised-auth .creds file (the user JWT and its NKey seed), as written by nsc or the nats CLI. Paste the whole file, not its path.",
      sensitive: true,
      optional: true,
      advanced: true,
      multiline: true,
      placeholder: "-----BEGIN NATS USER JWT-----\n…\n------END USER NKEY SEED------",
    },
    {
      key: "clientCert",
      label: "Client Certificate",
      description:
        "PEM client certificate, for a server that verifies clients (tls { verify: true }).",
      sensitive: false,
      optional: true,
      advanced: true,
      multiline: true,
      placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
    },
    {
      key: "clientKey",
      label: "Client Key",
      description: "The PEM private key for the client certificate.",
      sensitive: true,
      optional: true,
      advanced: true,
      multiline: true,
    },
    {
      key: "tlsServerName",
      label: "TLS Server Name",
      description:
        "The name the server's certificate is issued for, when it differs from the server URL's host (for example through an SSH tunnel to 127.0.0.1).",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "nats.internal",
    },
    {
      key: "username",
      label: "Monitoring Proxy Username",
      description:
        "Only if a reverse proxy in front of the monitoring port asks for basic auth; nats-server itself has none there.",
      sensitive: false,
      optional: true,
      advanced: true,
    },
    {
      key: "password",
      label: "Monitoring Proxy Password",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    {
      key: "token",
      label: "Monitoring Proxy Token",
      description:
        "Only if a reverse proxy in front of the monitoring port expects a bearer token.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    {
      ...caCertCredentialField,
      description:
        "PEM trust anchor for the server's certificate, used for both the client port and an HTTPS monitoring endpoint. Leave blank to use the system trust store.",
    },
  ],
  kvDriver: { driver: "nats", credentialKey: "servers" },
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
