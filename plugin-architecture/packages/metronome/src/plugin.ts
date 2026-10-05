import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { BUSINESS_METRIC_SOURCE } from "./business-metric.js";
import { MetronomeClient } from "./client.js";
import { METRONOME_LOGO_SVG } from "./logo.js";
import { BillableMetricResourceType } from "./resources/billable-metric.js";
import { CustomerResourceType } from "./resources/customer.js";

const manifest: PluginManifest = {
  id: "metronome",
  version: "0.1.0",
  displayName: "Metronome",
  description:
    "Metronome usage-based billing: lists customers and billable metrics, and imports a billable metric's daily usage or each day's invoiced revenue as a business metric for unit costs.",
  logoSvg: METRONOME_LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Metronome API token, created in the Metronome app under Developer, then API tokens. A token keeps the permissions of the user who made it; Infrawrench only reads, so a token Metronome support has scoped to read-only access works.",
      sensitive: true,
      helpLink: {
        label: "Create a Metronome API token",
        url: "https://docs.metronome.com/api-reference/authentication",
      },
    },
    caCertCredentialField,
  ],
  businessMetricSource: BUSINESS_METRIC_SOURCE,
};

const resourceTypes: ResourceTypeDefinition[] = [CustomerResourceType, BillableMetricResourceType];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new MetronomeClient(credentials, services),
};
