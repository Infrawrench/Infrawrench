import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { AnyscaleClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const manifest: PluginManifest = {
  id: "anyscale",
  version: "0.1.0",
  displayName: "Anyscale",
  description:
    "Managed Ray platform. Track Anyscale spend by project, workload type, user and workload, follow credit balances, chart cluster node counts and utilization per cloud, find idle workspaces, start and terminate workspaces, terminate jobs and services, roll back service rollouts, and manage projects, compute configs and budgets.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "An Anyscale API key. A service account key is best: it does not expire. User keys expire after at most the organization's maximum lifetime. Cost, credits and budgets are visible to organization owners only, so give the service account the Owner role to collect spend.",
      sensitive: true,
      placeholder: "Paste the API key",
      helpLink: {
        label: "Create an API key",
        url: "https://docs.anyscale.com/auth/service-accounts",
      },
    },
  ],
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
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new AnyscaleClient(credentials, services),
};
