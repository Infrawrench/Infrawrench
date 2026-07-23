import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { PlanetScaleClient } from "./client.js";
import { PsDatabaseResourceType } from "./resources/ps-database.js";
import { PsBranchResourceType } from "./resources/ps-branch.js";
import { PsPasswordResourceType } from "./resources/ps-password.js";
import { PsDeployRequestResourceType } from "./resources/ps-deploy-request.js";
import { PsBackupResourceType } from "./resources/ps-backup.js";

const manifest: PluginManifest = {
  id: "planetscale",
  version: "0.1.0",
  displayName: "PlanetScale",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#000000"/>
    <g transform="translate(14,14) scale(3)" fill="#fff">
      <path d="M0 12C0 5.373 5.373 0 12 0c4.873 0 9.067 2.904 10.947 7.077l-15.87 15.87a11.981 11.981 0 0 1-1.935-1.099L14.99 12H12l-8.485 8.485A11.962 11.962 0 0 1 0 12Zm12.004 12L24 12.004C23.998 18.628 18.628 23.998 12.004 24Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "serviceTokenId",
      label: "Service Token ID",
      description:
        "Your PlanetScale service token ID. Create one at Settings > Service tokens in the PlanetScale dashboard.",
      sensitive: false,
      placeholder: "psc_...",
    },
    {
      key: "serviceTokenSecret",
      label: "Service Token Secret",
      description: "The secret value for the service token.",
      sensitive: true,
      placeholder: "pscale_tkn_...",
    },
    {
      key: "organizationName",
      label: "Organization",
      description: "Your PlanetScale organization slug (shown in your dashboard URL).",
      sensitive: false,
      placeholder: "my-org",
    },
    caCertCredentialField,
  ],
  // Invoices API (GET /organizations/{org}/invoices + .../line-items):
  // monthly invoices with line items keyed by metric + database. In-progress
  // invoice line items refresh hourly; finalized invoices can still gain
  // late credits, hence the restatement window. Needs a service token with
  // the `read_invoices` organization access.
  costs: {
    dimensions: ["service", "resource"],
    maxHistoryDays: 365,
    restatementDays: 5,
    periodNative: true,
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  PsDatabaseResourceType,
  PsBranchResourceType,
  PsPasswordResourceType,
  PsDeployRequestResourceType,
  PsBackupResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new PlanetScaleClient(credentials, services),
};
