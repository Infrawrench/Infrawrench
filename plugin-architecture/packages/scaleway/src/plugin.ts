import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { ScalewayClient } from "./client.js";
import { InstanceResourceType } from "./resources/instance.js";
import { KapsuleClusterResourceType } from "./resources/kapsule-cluster.js";
import { ManagedDatabaseResourceType } from "./resources/managed-database.js";
import { ObjectStorageResourceType } from "./resources/object-storage.js";

const manifest: PluginManifest = {
  id: "scaleway",
  version: "0.1.0",
  displayName: "Scaleway",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#4F0599"/>
    <g transform="translate(20,20) scale(0.6)" fill="white">
      <path d="M50 0C22.4 0 0 22.4 0 50s22.4 50 50 50 50-22.4 50-50S77.6 0 50 0zm0 8c23.2 0 42 18.8 42 42S73.2 92 50 92 8 73.2 8 50 26.8 8 50 8zm0 16c-14.4 0-26 11.6-26 26s11.6 26 26 26 26-11.6 26-26-11.6-26-26-26zm0 8c9.9 0 18 8.1 18 18s-8.1 18-18 18-18-8.1-18-18 8.1-18 18-18z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKey",
      label: "Access Key",
      description: "Your Scaleway access key (starts with SCW...).",
      sensitive: false,
      placeholder: "SCWXXXXXXXXXXXXXXXXX",
    },
    {
      key: "secretKey",
      label: "Secret Key",
      description: "Your Scaleway secret key (UUID format).",
      sensitive: true,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "defaultProjectId",
      label: "Default Project ID",
      description: "Your Scaleway project ID (UUID). Found in the Scaleway console under Project Settings.",
      sensitive: false,
      placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  InstanceResourceType,
  KapsuleClusterResourceType,
  ManagedDatabaseResourceType,
  ObjectStorageResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new ScalewayClient(credentials),
};
