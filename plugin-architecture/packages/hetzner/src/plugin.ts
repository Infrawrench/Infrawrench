import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
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
    <g transform="translate(10,10) scale(3.33)" fill="white">
      <path d="M0 0v24h24V0H0zm4.602 4.025h2.244c.509 0 .716.215.716.717v5.64h8.883v-5.64c0-.509.215-.717.717-.717h2.229c.5 0 .71.23.724.717v14.516c0 .509-.215.717-.717.717h-2.23c-.51 0-.717-.215-.717-.717v-5.735H7.562v5.735c0 .516-.215.717-.716.717H4.602c-.51 0-.717-.208-.717-.717V4.742c0-.509.207-.717.717-.717z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Hetzner Cloud API token. Generate one in the Hetzner Cloud Console under Security → API Tokens.",
      sensitive: true,
      placeholder: "",
    },
    caCertCredentialField,
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
  createClient: (credentials, services) => new HetznerClient(credentials, resourceTypes, services),
};
