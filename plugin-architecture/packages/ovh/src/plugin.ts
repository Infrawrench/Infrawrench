import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { OvhClient } from "./client.js";
import { InstanceResourceType } from "./resources/instance.js";
import { ManagedKubeResourceType } from "./resources/managed-kube.js";
import { ManagedDbResourceType } from "./resources/managed-db.js";
import { VolumeResourceType } from "./resources/volume.js";
import { ObjectStorageResourceType } from "./resources/object-storage.js";
import { LoadBalancerResourceType } from "./resources/load-balancer.js";
import { PrivateNetworkResourceType } from "./resources/private-network.js";
import { FloatingIpResourceType } from "./resources/floating-ip.js";
import { GatewayResourceType } from "./resources/gateway.js";
import { ovhTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "ovh",
  version: "0.1.0",
  displayName: "OVHcloud",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000E9C"/>
    <g transform="translate(10,20) scale(3.33)" fill="white">
      <path d="M19.881 10.095l2.563-4.45C23.434 7.389 24 9.404 24 11.555c0 2.88-1.017 5.523-2.71 7.594h-6.62l2.04-3.541h-2.696l3.176-5.513h2.691zm-2.32-5.243L9.333 19.14l.003.009H2.709C1.014 17.077 0 14.435 0 11.555c0-2.152.57-4.17 1.561-5.918L5.855 13.1 10.6 4.852h6.961z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "applicationKey",
      label: "Application Key",
      description:
        "Your OVHcloud API application key (AK). Create one at https://api.ovh.com/createApp/",
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
      description:
        "Your OVHcloud API consumer key (CK). Generated when you validate API credentials.",
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
      description:
        "Your OVHcloud Public Cloud project UUID. Found in the OVHcloud control panel under Public Cloud.",
      sensitive: false,
      placeholder: "12345678-abcd-1234-abcd-1234567890ab",
    },
    caCertCredentialField,
  ],
  // /me/bill invoices (+ per-line details) for finalized spend and
  // /me/consumption/usage/current for the unbilled in-progress period.
  // Account-level dimensions only — bill lines identify the billed service,
  // not regions/resources. The consumer key needs the access rules
  // `GET /me/bill*` and `GET /me/consumption*` on top of the usual
  // `/cloud/project/*` rules.
  costs: { dimensions: ["service"], maxHistoryDays: 365, restatementDays: 5, periodNative: true },
};

const resourceTypes: ResourceTypeDefinition[] = [
  InstanceResourceType,
  ManagedKubeResourceType,
  ManagedDbResourceType,
  VolumeResourceType,
  ObjectStorageResourceType,
  LoadBalancerResourceType,
  PrivateNetworkResourceType,
  FloatingIpResourceType,
  GatewayResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new OvhClient(credentials, resourceTypes, services),
  terraformExport: ovhTerraformExport,
};
