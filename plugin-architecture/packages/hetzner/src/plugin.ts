import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { HetznerClient } from "./client.js";
import { ServerResourceType } from "./resources/server.js";
import { VolumeResourceType } from "./resources/volume.js";
import { FloatingIpResourceType } from "./resources/floating-ip.js";
import { FirewallResourceType } from "./resources/firewall.js";

const manifest: PluginManifest = {
  id: "hetzner",
  version: "0.1.0",
  displayName: "Hetzner Cloud",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#D50C2D"/>
    <g transform="translate(20,22)" fill="white">
      <rect x="0" y="0" width="12" height="56"/>
      <rect x="48" y="0" width="12" height="56"/>
      <rect x="12" y="22" width="36" height="12"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description: "A Hetzner Cloud API token. Generate one in the Hetzner Cloud Console under Security → API Tokens.",
      sensitive: true,
      placeholder: "",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ServerResourceType,
  VolumeResourceType,
  FloatingIpResourceType,
  FirewallResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new HetznerClient(credentials),
};
