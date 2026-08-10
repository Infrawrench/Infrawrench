import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { FlyClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { AppResourceType } from "./resources/app.js";
import { MachineResourceType } from "./resources/machine.js";
import { VolumeResourceType } from "./resources/volume.js";
import { CertificateResourceType } from "./resources/certificate.js";
import { IpAllocationResourceType } from "./resources/ip-allocation.js";

const manifest: PluginManifest = {
  id: "fly",
  version: "0.1.0",
  displayName: "Fly.io",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#7B3BE2"/>
    <g transform="translate(15,18) scale(0.7)">
      <path d="M50 10 L85 35 L85 70 L50 95 L15 70 L15 35 Z" fill="white" opacity="0.9"/>
      <path d="M50 25 L72 40 L72 62 L50 78 L28 62 L28 40 Z" fill="#7B3BE2"/>
      <path d="M50 38 L60 45 L60 57 L50 64 L40 57 L40 45 Z" fill="white"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A Fly.io API token. Generate one with `fly tokens create` or from the Fly.io dashboard under Account → Access Tokens.",
      sensitive: true,
      placeholder: "",
    },
    {
      key: "orgSlug",
      label: "Organization Slug",
      description:
        'The Fly.io organization slug. Use "personal" for your personal account, or the org slug from your Fly.io dashboard.',
      sensitive: false,
      placeholder: "personal",
      defaultValue: "personal",
    },
    caCertCredentialField,
  ],
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  AppResourceType,
  MachineResourceType,
  VolumeResourceType,
  CertificateResourceType,
  IpAllocationResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new FlyClient(credentials, resourceTypes, services),
  parseStatusFeed,
};
