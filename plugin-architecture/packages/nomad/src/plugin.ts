import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { NOMAD_PREFLIGHT, NomadClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { nomadRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { nomadTerraformExport } from "./terraform.js";

export const manifest = {
  id: "nomad",
  // Nomad is self-hosted: the agent address is user-supplied, so there is no fixed egress host (same as kubernetes).
  egressHosts: [],
  displayName: "HashiCorp Nomad",
  description:
    "Self-hosted Nomad: jobs with run, stop, scale, dispatch and revert, allocations with logs and restart, deployments with promote and fail, nodes with drain and eligibility, namespaces, node pools, variables, ACL policies and tokens, CSI and host volumes, and services.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "address",
      label: "Nomad Address",
      description:
        "Any server or client agent's HTTP address with its port, the same value as NOMAD_ADDR: https://nomad.example.com:4646. For a cluster on a private network, add an SSH tunnel to this account.",
      sensitive: false,
      placeholder: "https://nomad.example.com:4646",
    },
    {
      key: "token",
      label: "ACL Token",
      description:
        "The secret ID of an ACL token (NOMAD_TOKEN). A management token manages everything; create a narrower one with nomad acl token create -name=infrawrench -policy=<policy>. Leave empty if ACLs are disabled.",
      sensitive: true,
      optional: true,
      placeholder: "6f1c6ea1-…",
      helpLink: {
        label: "Nomad ACL tokens",
        url: "https://developer.hashicorp.com/nomad/docs/secure/acl/tokens",
      },
    },
    {
      key: "region",
      label: "Region",
      description: "Only for federated clusters: the region to manage, if not the agent's own.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "global",
    },
    caCertCredentialField,
  ]),
  preflight: NOMAD_PREFLIGHT,
  rateLimit: { capacity: 20, refillPerSecond: 10 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new NomadClient(credentials, services),
  testCredentials: { address: "https://nomad.example.com:4646", token: "test" },
  terraformExport: nomadTerraformExport,
  remediationCommands: nomadRemediationCommands,
});
