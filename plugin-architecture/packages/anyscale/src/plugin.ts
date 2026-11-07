import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import type { PluginManifest, CredentialsOf } from "@infrawrench/plugin-base";
import { AnyscaleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { anyscaleRemediationCommands } from "./remediation.js";

export const manifest = {
  id: "anyscale",
  egressHosts: ["console.anyscale.com"],
  displayName: "Anyscale",
  description:
    "Managed Ray platform. Track Anyscale spend by project, workload type, user and workload, follow credit balances, chart cluster node counts and utilization per cloud, find idle workspaces, start and terminate workspaces, terminate jobs and services, roll back service rollouts, and manage projects, compute configs and budgets.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiKey",
      label: "API Key",
      description:
        "An Anyscale API key. A service account key is best because it does not expire. Costs, credits and budgets are visible to organization owners only, so give the service account the Owner role.",
      sensitive: true,
      placeholder: "Paste the API key",
      helpLink: {
        label: "Create an API key",
        url: "https://docs.anyscale.com/auth/service-accounts",
      },
    },
  ]),
  costs: {
    // Usage dashboard data, per cluster per day: workload type → service,
    // the cloud's region → region, the workspace/job/service → resource, and
    // project, user, cloud, workload name, job queue and hosting model as
    // tags. Anyscale's own charges only (see cost-data.ts for why that never
    // overlaps the AWS / GCP / Azure plugins).
    dimensions: ["service", "region", "resource", "tag"],
    maxHistoryDays: 365,
    // The dashboard is a near-real-time estimate that settles over a few days.
    restatementDays: 5,
  },
  credits: {
    label: "Anyscale credits",
    topUpUrl: "https://www.anyscale.com/contact-sales",
  },
  rateLimit: { capacity: 10, refillPerSecond: 2 },
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AnyscaleClient(credentials, services),
  testCredentials: { apiKey: "test-anyscale-key" },
  remediationCommands: anyscaleRemediationCommands,
});
