import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { CloudflareClient } from "./client.js";
import { ZoneResourceType } from "./resources/zone.js";
import { DnsRecordResourceType } from "./resources/dns-record.js";
import { WorkerResourceType } from "./resources/worker.js";

const manifest: PluginManifest = {
  id: "cloudflare",
  version: "0.1.0",
  displayName: "Cloudflare",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#F48120"/>
    <g transform="translate(15,25) scale(0.7)" fill="white">
      <path d="M65.8 54.3l2.3-7.9c.4-1.4.2-2.7-.6-3.6-.7-.9-1.9-1.4-3.2-1.4l-38.7-.5c-.3 0-.5-.1-.6-.3-.1-.2-.1-.4 0-.6.2-.5.6-.8 1.1-.8l39-.5c4.7-.3 9.8-4.2 11.5-9l2.1-5.9c.1-.3.1-.6 0-.9C74.7 13.6 65.6 6 54.8 6 45 6 36.6 12.2 33.4 20.8c-2.7-2-6.2-3-9.9-2.5-6.3.9-11.4 6-12.2 12.3-.2 1.5-.1 2.9.2 4.3C5.3 35.3 0 41 0 47.8c0 1.3.2 2.6.5 3.8.2.7.8 1.2 1.5 1.2h62.7c.5 0 1-.4 1.1-.9z"/>
      <path d="M73.4 34.9c-.5 0-.9 0-1.4.1-.3.1-.5.3-.6.6l-1.6 5.6c-.4 1.4-.2 2.7.6 3.6.7.9 1.9 1.4 3.2 1.4l8.3.5c.3 0 .5.1.6.3.1.2.1.4 0 .6-.2.5-.6.8-1.1.8l-8.6.5c-4.7.3-9.8 4.2-11.5 9l-.6 1.7c-.2.5.1 1 .7 1h28c.5 0 1-.3 1.1-.8.6-2.1 1-4.3 1-6.6C91.5 42.5 83.4 34.9 73.4 34.9z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description: "A Cloudflare API token with Zone:Read and DNS:Read permissions. Create one at dash.cloudflare.com/profile/api-tokens.",
      sensitive: true,
      placeholder: "Scoped API token...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ZoneResourceType,
  DnsRecordResourceType,
  WorkerResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new CloudflareClient(credentials),
};
