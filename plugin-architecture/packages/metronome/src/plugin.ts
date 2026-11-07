import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type {
  PluginManifest,
  ResourceTypeDefinition,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BUSINESS_METRIC_SOURCE } from "./business-metric.js";
import { MetronomeClient } from "./client.js";
import { METRONOME_LOGO_SVG } from "./logo.js";
import { BillableMetricResourceType } from "./resources/billable-metric.js";
import { CustomerResourceType } from "./resources/customer.js";

export const manifest = {
  id: "metronome",
  egressHosts: ["api.metronome.com"],
  displayName: "Metronome",
  description:
    "Metronome usage-based billing: lists customers and billable metrics, and imports a billable metric's daily usage or each day's invoiced revenue as a business metric for unit costs.",
  logoSvg: METRONOME_LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Metronome API token, created in the Metronome app under Developer, then API tokens. A token keeps its creator's permissions. Infrawrench only reads, so a read-only token works.",
      sensitive: true,
      helpLink: {
        label: "Create a Metronome API token",
        url: "https://docs.metronome.com/api-reference/authentication",
      },
    },
    caCertCredentialField,
  ]),
  businessMetricSource: BUSINESS_METRIC_SOURCE,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

const resourceTypes: ResourceTypeDefinition[] = [CustomerResourceType, BillableMetricResourceType];

export const plugin = definePlugin({
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MetronomeClient(credentials, services),
  testCredentials: { apiToken: "test-metronome-token" },
});
