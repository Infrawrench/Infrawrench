import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { WasabiClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";

const manifest: PluginManifest = {
  id: "wasabi",
  version: "0.1.0",
  displayName: "Wasabi",
  description:
    "Hot cloud storage. Browse and upload objects, manage buckets with versioning, Object Lock, policies, lifecycle and CORS rules, IAM users and access keys, Account Control sub-accounts, and daily storage and estimated spend from the Stats API.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKey",
      label: "Access Key",
      description:
        "In the Wasabi console, open Access Keys and choose Create Access Key for the root user. Root keys see everything, including the Stats API used for usage and costs; a sub-user key works too when its policy grants S3, IAM and billing access.",
      sensitive: false,
      placeholder: "ABCDEFGHIJKLMNOPQRST",
      helpLink: { label: "Wasabi access keys", url: "https://console.wasabisys.com/#/access_keys" },
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description: "The secret shown once when the access key is created.",
      sensitive: true,
      placeholder: "40-character secret",
    },
    {
      key: "wacApiKey",
      label: "Account Control API Key (optional)",
      description:
        "Only for Wasabi Account Control (WAC) control accounts: the WAC API key Wasabi issues (in WACM, or from Wasabi support) to list, create and manage sub-accounts. Leave empty otherwise.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    caCertCredentialField,
  ],
  costs: {
    // Stats API daily per-bucket utilization × pay-as-you-go list price
    // (active plus timed-deleted storage; no egress or request fees).
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 3,
    estimated: true,
  },
  preflight: {
    capabilities: [
      {
        id: "resources",
        label: "Buckets and objects",
        essential: true,
        requiredPermissions: [{ id: "s3:ListAllMyBuckets", label: "List buckets" }],
      },
      {
        id: "iam",
        label: "IAM users and access keys",
        description: "Also needed by Get credentials on a bucket.",
        requiredPermissions: [{ id: "iam:ListUsers", label: "List IAM users" }],
      },
      {
        id: "costs",
        label: "Usage and costs",
        description: "The Stats API accepts only root keys or keys with billing permissions.",
        requiredPermissions: [{ id: "billing", label: "Root key or billing permissions" }],
      },
      {
        id: "sub-accounts",
        label: "Sub-accounts",
        description: "Needs the optional Account Control API key.",
        requiredPermissions: [{ id: "wac", label: "Wasabi Account Control API key" }],
      },
    ],
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new WasabiClient(credentials, services),
  parseStatusFeed,
};
