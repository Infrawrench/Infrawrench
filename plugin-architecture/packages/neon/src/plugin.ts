import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { NeonClient } from "./client.js";
import { NeonProjectResourceType } from "./resources/project.js";
import { NeonBranchResourceType } from "./resources/branch.js";
import { NeonEndpointResourceType } from "./resources/endpoint.js";
import { NeonDatabaseResourceType } from "./resources/database.js";
import { NeonRoleResourceType } from "./resources/role.js";

const manifest: PluginManifest = {
  id: "neon",
  version: "0.1.0",
  displayName: "Neon",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0A0A0A"/>
    <g transform="translate(15,15) scale(0.7)">
      <path d="M12.948 0C5.816 0 0 5.856 0 13.038v62.143c0 7.183 5.282 10.354 11.308 5.674L30.35 65.17c1.466-1.14 3.588-.067 3.588 1.818v19.084c0 7.66 5.682 14.022 12.814 13.928C53.856 99.898 60 93.654 60 86.472V13.038C60 5.856 54.108 0 46.976 0H12.948z" fill="#00E599"/>
      <path d="M47.052 100C54.184 100 60 94.144 60 86.962V24.819c0-7.183-5.282-10.354-11.308-5.674L29.65 34.83c-1.466 1.14-3.588.067-3.588-1.818V13.928C26.062 6.268 20.38-.094 13.248.002 6.144.098 0 6.346 0 13.528v73.434C0 94.144 5.892 100 13.024 100h34.028z" fill="url(#neon-gradient)"/>
      <defs>
        <linearGradient id="neon-gradient" x1="30" y1="0" x2="30" y2="100" gradientUnits="userSpaceOnUse">
          <stop stop-color="#00E599" stop-opacity="0.6"/>
          <stop offset="1" stop-color="#00E599" stop-opacity="0"/>
        </linearGradient>
      </defs>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description: "A Neon API key. Generate one at https://console.neon.tech/app/settings/api-keys",
      sensitive: true,
      placeholder: "neon_...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  NeonProjectResourceType,
  NeonBranchResourceType,
  NeonEndpointResourceType,
  NeonDatabaseResourceType,
  NeonRoleResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new NeonClient(credentials, services),
};
