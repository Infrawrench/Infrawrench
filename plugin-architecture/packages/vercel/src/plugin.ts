import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { VercelClient } from "./client.js";
import { VercelProjectResourceType } from "./resources/project.js";
import { VercelDeploymentResourceType } from "./resources/deployment.js";
import { VercelDomainResourceType } from "./resources/domain.js";
import { VercelEnvironmentVariableResourceType } from "./resources/environment-variable.js";
import { VercelTeamResourceType } from "./resources/team.js";

const manifest: PluginManifest = {
  id: "vercel",
  version: "0.1.0",
  displayName: "Vercel",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000000"/>
    <polygon points="50,22 78,72 22,72" fill="white"/>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "A Vercel access token. Generate one at https://vercel.com/account/tokens. Grant full account scope for all features.",
      sensitive: true,
      placeholder: "Bearer token...",
    },
    {
      key: "teamId",
      label: "Team ID (optional)",
      description:
        "If you want to scope requests to a specific team, enter the Team ID. Find it in Team Settings > General. Leave blank for personal account.",
      sensitive: false,
      optional: true,
      placeholder: "team_...",
    },
    caCertCredentialField,
  ],
  // FOCUS billing charges (`/v1/billing/charges`), aggregated per day by
  // ServiceName + RegionId + project (surfaced as the `project` tag). Daily
  // granularity, ≤1-year window per request; works with the same access
  // token given a billing-capable team role.
  costs: { dimensions: ["service", "region", "tag"], maxHistoryDays: 365, restatementDays: 3 },
};

const resourceTypes: ResourceTypeDefinition[] = [
  VercelProjectResourceType,
  VercelDeploymentResourceType,
  VercelDomainResourceType,
  VercelEnvironmentVariableResourceType,
  VercelTeamResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new VercelClient(credentials, services),
};
