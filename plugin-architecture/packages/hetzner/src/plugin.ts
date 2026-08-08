import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { HetznerClient } from "./client.js";
import { hetznerTerraformExport } from "./terraform.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { ServerResourceType } from "./resources/server.js";
import { VolumeResourceType } from "./resources/volume.js";
import { FloatingIpResourceType } from "./resources/floating-ip.js";
import { FirewallResourceType } from "./resources/firewall.js";
import { NetworkResourceType } from "./resources/network.js";
import { LoadBalancerResourceType } from "./resources/load-balancer.js";
import { PrimaryIpResourceType } from "./resources/primary-ip.js";
import { SshKeyResourceType } from "./resources/ssh-key.js";
import { ImageResourceType } from "./resources/image.js";
import { PlacementGroupResourceType } from "./resources/placement-group.js";

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
  /**
   * Estimated spend, not billed spend.
   *
   * Hetzner Cloud publishes no invoice or spend endpoint — the only money in
   * the API is the `/pricing` rate card — so these amounts are this project's
   * current inventory priced at list, net of VAT, in the project's own
   * currency. They will not reconcile against a Hetzner invoice line for line.
   *
   * `maxHistoryDays: 1` is deliberate and is the important part of this
   * declaration. A past day rebuilt from today's inventory omits everything
   * created and destroyed since — silently, and always downward — and the
   * traffic counters that would correct it hold the current billing period
   * only, with no history at all. Rather than backfill a year of confidently
   * wrong numbers, the collector prices the day it runs and the series builds
   * forward from the day the account is connected. Days before that are a gap,
   * not zero spend.
   *
   * `restatementDays: 31` exists for one row type: traffic overage is
   * cumulative over the billing period, so it is dated to the period's first
   * day and restated in place on each run. 31 days guarantees that day is
   * inside the incremental window whatever the date. Chunks containing neither
   * today nor the period start return nothing and issue no requests.
   */
  costs: {
    dimensions: ["service", "region", "resource"],
    maxHistoryDays: 1,
    restatementDays: 31,
    estimated: true,
  },
  statusFeed,
};

const resourceTypes: ResourceTypeDefinition[] = [
  ServerResourceType,
  VolumeResourceType,
  FloatingIpResourceType,
  FirewallResourceType,
  NetworkResourceType,
  LoadBalancerResourceType,
  PrimaryIpResourceType,
  SshKeyResourceType,
  ImageResourceType,
  PlacementGroupResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new HetznerClient(credentials, resourceTypes, services),
  terraformExport: hetznerTerraformExport,
  parseStatusFeed,
};
