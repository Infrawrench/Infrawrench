import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DigitalOceanClient } from "./client.js";
import { ProjectResourceType } from "./resources/project.js";
import { DropletResourceType } from "./resources/droplet.js";
import { DOKSClusterResourceType } from "./resources/doks-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { SpacesResourceType } from "./resources/spaces.js";

const manifest: PluginManifest = {
  id: "digitalocean",
  version: "0.1.0",
  displayName: "DigitalOcean",
  description: "Manage DigitalOcean resources: Droplets, DOKS clusters, Managed Databases, Spaces, and more.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="50" fill="#0080FF"/>
    <path d="M50 18v16.5c8.8 0 15.5 8.7 12.4 18-1.2 3.8-4.3 6.9-8.2 8.2-9.3 3.1-18-3.6-18-12.4H20C20 65.9 34.2 80 50 80c17.6 0 30-14.3 30-30S67.6 18 50 18z" fill="white"/>
    <rect x="36" y="76" width="10" height="10" fill="white"/>
    <rect x="22" y="63" width="10" height="10" fill="white"/>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description: "A DigitalOcean personal access token with read scope.",
      sensitive: true,
      placeholder: "dop_v1_...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ProjectResourceType,
  DropletResourceType,
  DOKSClusterResourceType,
  ManagedDatabaseResourceType,
  SpacesResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new DigitalOceanClient(credentials),
};
