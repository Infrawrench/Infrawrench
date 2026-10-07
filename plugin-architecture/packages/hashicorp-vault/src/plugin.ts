import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { VAULT_PREFLIGHT, VaultClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { vaultTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "hashicorp-vault",
  version: "0.1.0",
  displayName: "HashiCorp Vault",
  description:
    "Self-hosted or HCP Vault: secrets engines, a KV v2 browser with versions, auth methods, editable ACL policies, PKI roles and certificates with expiry, leases, tokens, audit devices, and seal, health and client-count metrics.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "address",
      label: "Vault Address",
      description:
        "The address you reach Vault at, including the port: https://vault.example.com:8200, or the public or private address of an HCP Vault Dedicated cluster (HCP portal, Vault Dedicated, the cluster's Overview page).",
      sensitive: false,
      placeholder: "https://vault.example.com:8200",
    },
    {
      key: "namespace",
      label: "Namespace",
      description:
        "Vault Enterprise and HCP Vault only. HCP Vault clusters start everything in the admin namespace. Leave empty on Vault Community.",
      sensitive: false,
      optional: true,
      placeholder: "admin",
    },
    {
      key: "token",
      label: "Token",
      description:
        "A Vault token (hvs.…). Create one with vault token create -policy=<policy> -period=768h, or on HCP Vault from the cluster page (Generate token, which gives an admin token). Listing tokens, leases and audit devices needs sudo; Check credentials shows what a token reaches. Leave empty to use AppRole below.",
      sensitive: true,
      optional: true,
      placeholder: "hvs.CAESI…",
      helpLink: {
        label: "Vault tokens",
        url: "https://developer.hashicorp.com/vault/docs/concepts/tokens",
      },
    },
    {
      key: "roleId",
      label: "AppRole Role ID",
      description:
        "Instead of a token: the role ID of an AppRole (vault read auth/approle/role/<name>/role-id). Infrawrench logs in and renews the login itself.",
      sensitive: false,
      optional: true,
      placeholder: "59d6d1ca-47bb-4e7e-a40b-8be3bc5a0ba8",
    },
    {
      key: "secretId",
      label: "AppRole Secret ID",
      description: "The AppRole secret ID (vault write -f auth/approle/role/<name>/secret-id).",
      sensitive: true,
      optional: true,
      placeholder: "84896a0c-1347-aa90-a4f6-aca8b7558780",
    },
    {
      key: "appRoleMount",
      label: "AppRole Mount Path",
      description: "Only if AppRole is enabled somewhere other than approle/.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "approle",
    },
    caCertCredentialField,
  ],
  preflight: VAULT_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new VaultClient(credentials, services),
  parseStatusFeed,
  terraformExport: vaultTerraformExport,
};
