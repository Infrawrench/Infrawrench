import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BackblazeB2Client } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { B2_PREFLIGHT, b2PolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { b2TerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "backblaze-b2",
  version: "0.1.0",
  displayName: "Backblaze B2",
  description:
    "Object storage. Browse and upload files, manage buckets with lifecycle, CORS, replication and event notification rules, default encryption and Object Lock, mint bucket-scoped keys, and chart usage and estimated spend from the daily usage reports.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "applicationKeyId",
      label: "Application Key ID",
      description:
        "From the Backblaze web console: Application Keys → Add a New Application Key (or the Master Application Key). Use a key with access to all buckets and Read and Write access so every feature works; a single-bucket key only sees that bucket.",
      sensitive: false,
      placeholder: "005a1b2c3d4e5f60000000001",
      helpLink: {
        label: "Create an application key",
        url: "https://secure.backblaze.com/app_keys.htm",
      },
    },
    {
      key: "applicationKey",
      label: "Application Key",
      description: "The secret shown once when the key is created.",
      sensitive: true,
      placeholder: "K005…",
    },
    caCertCredentialField,
  ],
  costs: {
    // Estimated at list price from the daily usage reports: storage from
    // byte-hours, the download overage beyond 3x average storage, and Class D
    // calls, per bucket per day. The download allowance is monthly, so the
    // whole current month is re-read on every pass.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 31,
    estimated: true,
  },
  preflight: B2_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BackblazeB2Client(credentials, services),
  parseStatusFeed: (body) => parseStatusFeed(body),
  policyTemplate: b2PolicyTemplate,
  terraformExport: b2TerraformExport,
};
