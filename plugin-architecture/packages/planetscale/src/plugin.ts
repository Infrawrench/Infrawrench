import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { PlanetScaleClient } from "./client.js";
import { PsDatabaseResourceType } from "./resources/ps-database.js";
import { PsBranchResourceType } from "./resources/ps-branch.js";

const manifest: PluginManifest = {
  id: "planetscale",
  version: "0.1.0",
  displayName: "PlanetScale",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000000"/>
    <g transform="translate(15,15) scale(0.7)">
      <circle cx="50" cy="50" r="42" fill="none" stroke="#FFFFFF" stroke-width="5"/>
      <path d="M50 8 L92 50 L50 50 Z" fill="#FFFFFF"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "serviceTokenId",
      label: "Service Token ID",
      description: "Your PlanetScale service token ID. Create one at Settings > Service tokens in the PlanetScale dashboard.",
      sensitive: false,
      placeholder: "psc_...",
    },
    {
      key: "serviceTokenSecret",
      label: "Service Token Secret",
      description: "The secret value for the service token.",
      sensitive: true,
      placeholder: "pscale_tkn_...",
    },
    {
      key: "organizationName",
      label: "Organization",
      description: "Your PlanetScale organization slug (shown in your dashboard URL).",
      sensitive: false,
      placeholder: "my-org",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  PsDatabaseResourceType,
  PsBranchResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new PlanetScaleClient(credentials, services),
};
