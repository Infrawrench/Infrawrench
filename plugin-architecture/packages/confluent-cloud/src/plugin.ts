import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { ConfluentCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { CONFLUENT_PREFLIGHT, confluentPolicyTemplate } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { confluentTerraformExport } from "./terraform.js";
import { confluentRemediationCommands } from "./remediation.js";

const manifest: PluginManifest = {
  id: "confluent-cloud",
  version: "0.1.0",
  displayName: "Confluent Cloud",
  description:
    "Managed Apache Kafka, Connect, Flink, ksqlDB and Schema Registry. Track Confluent Cloud spend by product, environment and resource, chart cluster throughput, consumer lag and CKU utilization, resize clusters, pause and resume connectors, manage Flink compute pools, service accounts and API keys, and browse topics through the Kafka plugin.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "Cloud API Key",
      description:
        "A Cloud API key (Administration, Cloud API keys), not a key scoped to one cluster. It carries its owner's role bindings: cost data needs BillingAdmin, metrics need MetricsViewer, and listing needs Operator. Check credentials lists exactly what each feature needs.",
      sensitive: false,
      placeholder: "16 characters, e.g. ABCD1234EFGH5678",
      helpLink: {
        label: "Create a Cloud API key",
        url: "https://confluent.cloud/settings/api-keys",
      },
    },
    {
      key: "apiSecret",
      label: "Cloud API Secret",
      description: "The secret shown once when the Cloud API key was created.",
      sensitive: true,
    },
    caCertCredentialField,
  ],
  costs: {
    // Billing Costs API: product -> service, the billed resource's region
    // (joined from inventory), the provider resource id, and environment,
    // line type, network access type and cloud as tags. History is capped
    // at one year by the API; data can take 72 hours to land and is
    // restated meanwhile.
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    restatementDays: 5,
    chargeTypes: true,
  },
  preflight: CONFLUENT_PREFLIGHT,
  statusFeed,
  rateLimit: { capacity: 20, refillPerSecond: 1 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new ConfluentCloudClient(credentials, services),
  parseStatusFeed,
  policyTemplate: confluentPolicyTemplate,
  terraformExport: confluentTerraformExport,
  remediationCommands: confluentRemediationCommands,
};
