import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { TursoClient } from "./client.js";
import { TursoGroupResourceType } from "./resources/turso-group.js";
import { TursoDatabaseResourceType } from "./resources/turso-database.js";

const manifest: PluginManifest = {
  id: "turso",
  version: "0.1.0",
  displayName: "Turso",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0F1923"/>
    <g transform="translate(15,15) scale(0.7)">
      <path d="M50 5 L90 30 L90 70 L50 95 L10 70 L10 30 Z" fill="none" stroke="#4FF8D2" stroke-width="5"/>
      <path d="M50 20 L75 35 L75 65 L50 80 L25 65 L25 35 Z" fill="#4FF8D2" opacity="0.3"/>
      <circle cx="50" cy="50" r="12" fill="#4FF8D2"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description: "A Turso Platform API token. Generate one at https://turso.tech/app or via `turso auth api-tokens mint`.",
      sensitive: true,
      placeholder: "eyJ...",
    },
    {
      key: "organizationName",
      label: "Organization",
      description: "Your Turso organization slug (shown in your dashboard URL).",
      sensitive: false,
      placeholder: "my-org",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  TursoGroupResourceType,
  TursoDatabaseResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new TursoClient(credentials, services),
};
