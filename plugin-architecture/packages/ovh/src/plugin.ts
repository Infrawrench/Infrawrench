import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { OvhClient } from "./client.js";
import { InstanceResourceType } from "./resources/instance.js";
import { ManagedKubeResourceType } from "./resources/managed-kube.js";
import { ManagedDbResourceType } from "./resources/managed-db.js";

const manifest: PluginManifest = {
  id: "ovh",
  version: "0.1.0",
  displayName: "OVHcloud",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000E9C"/>
    <g transform="translate(10,25) scale(0.8)">
      <path d="M25 0C11.2 0 0 11.2 0 25c0 9.1 4.9 17.1 12.2 21.4L20.5 31C18.3 29 17 26.2 17 23c0-5.5 4.5-10 10-10s10 4.5 10 10c0 3.2-1.3 6-3.5 8L41.8 46.4C49.1 42.1 54 34.1 54 25 54 11.2 42.8 0 27 0h-2z" fill="white"/>
      <path d="M50 62L75 12h25L66 62z" fill="white"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "applicationKey",
      label: "Application Key",
      description: "Your OVHcloud API application key (AK). Create one at https://api.ovh.com/createApp/",
      sensitive: false,
      placeholder: "a1b2c3d4e5f6g7h8",
    },
    {
      key: "applicationSecret",
      label: "Application Secret",
      description: "Your OVHcloud API application secret (AS).",
      sensitive: true,
      placeholder: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    },
    {
      key: "consumerKey",
      label: "Consumer Key",
      description: "Your OVHcloud API consumer key (CK). Generated when you validate API credentials.",
      sensitive: true,
      placeholder: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    },
    {
      key: "endpoint",
      label: "API Endpoint",
      description: "OVHcloud API region: eu (Europe), ca (Canada), us (United States).",
      sensitive: false,
      placeholder: "eu",
      defaultValue: "eu",
    },
    {
      key: "projectId",
      label: "Public Cloud Project ID",
      description: "Your OVHcloud Public Cloud project UUID. Found in the OVHcloud control panel under Public Cloud.",
      sensitive: false,
      placeholder: "12345678-abcd-1234-abcd-1234567890ab",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  InstanceResourceType,
  ManagedKubeResourceType,
  ManagedDbResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new OvhClient(credentials),
};
