import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { CONSUL_PREFLIGHT, ConsulClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { consulTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "consul",
  version: "0.1.0",
  displayName: "HashiCorp Consul",
  description:
    "Self-hosted Consul: catalog services and nodes with health checks, a KV browser with editing, intentions, config entries, ACL policies, roles and tokens, sessions, cluster peering, and Enterprise namespaces and admin partitions.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "address",
      label: "Consul Address",
      description:
        "Any agent's HTTP(S) address with its port, the same value as CONSUL_HTTP_ADDR: http://consul.internal:8500 or https://consul.example.com:8501. For a cluster on a private network, add an SSH tunnel to this account.",
      sensitive: false,
      placeholder: "https://consul.example.com:8501",
    },
    {
      key: "token",
      label: "ACL Token",
      description:
        "The secret ID of an ACL token (CONSUL_HTTP_TOKEN). A token with the global-management policy manages everything; create a narrower one with consul acl token create -policy-name=<policy>. Leave empty if ACLs are disabled.",
      sensitive: true,
      optional: true,
      placeholder: "e95b599e-166e-7d80-08ad-aee76e7ddf19",
      helpLink: {
        label: "Consul ACL tokens",
        url: "https://developer.hashicorp.com/consul/docs/secure/acl/token",
      },
    },
    {
      key: "datacenter",
      label: "Datacenter",
      description:
        "Only to manage a datacenter other than the agent's own (WAN-federated clusters).",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "dc2",
    },
    {
      key: "namespace",
      label: "Namespace",
      description:
        "Consul Enterprise only: the namespace to work in. Leave empty on Community Edition.",
      sensitive: false,
      optional: true,
      advanced: true,
    },
    {
      key: "partition",
      label: "Admin Partition",
      description: "Consul Enterprise only: the admin partition to work in.",
      sensitive: false,
      optional: true,
      advanced: true,
    },
    caCertCredentialField,
  ],
  preflight: CONSUL_PREFLIGHT,
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ConsulClient(credentials, services),
  terraformExport: consulTerraformExport,
};
