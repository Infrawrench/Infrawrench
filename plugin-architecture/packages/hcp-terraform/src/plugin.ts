import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import type { TfContext } from "./api.js";
import {
  DEFAULT_HOSTNAME,
  isPermissionError,
  normaliseHostname,
  tfList,
  unsafeServerHostname,
} from "./api.js";
import { HcpTerraformClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { tfeTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "hcp-terraform",
  version: "0.1.0",
  displayName: "HCP Terraform",
  description:
    "HCP Terraform and Terraform Enterprise. Manage projects, workspaces and their variables, queue, apply and discard runs with plan and apply logs, reference state outputs from other resources, watch drift and checks, and manage variable sets, agent pools, policy sets, teams, run tasks and the private registry.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Token",
      description:
        "A user token (Account settings, Tokens, Create an API token) acts as you and sees what you can. A team token (Organization settings, Teams, the team, Team API token) works for automation. An organization token cannot queue runs or read state outputs. Tokens carry no scopes: what the token's user or team may do is what the plugin may do.",
      sensitive: true,
      placeholder: "xxxxxxxxxxxxxx.atlasv1.xxxxxxxx",
      helpLink: {
        label: "API tokens",
        url: "https://developer.hashicorp.com/terraform/cloud-docs/users-teams-organizations/api-tokens",
      },
    },
    {
      key: "hostname",
      label: "Hostname",
      description:
        "app.terraform.io for HCP Terraform, app.eu.terraform.io for HCP Europe, or your Terraform Enterprise hostname.",
      sensitive: false,
      defaultValue: DEFAULT_HOSTNAME,
      placeholder: DEFAULT_HOSTNAME,
    },
    {
      key: "organization",
      label: "Organization",
      description:
        "The organization to manage. The list shows every organization the token can see.",
      sensitive: false,
      providerOptions: { dependsOn: ["apiToken", "hostname"] },
      placeholder: "my-org",
    },
    caCertCredentialField,
  ],
  costs: {
    // One row per invoice, on its issue date. Credit-card-billed HCP
    // Terraform organizations only; everyone else reports nothing.
    dimensions: ["service", "resource", "tag"],
    maxHistoryDays: 730,
    restatementDays: 40,
  },
  quotas: {
    label: "Plan entitlements",
    partial: true,
  },
  statusFeed,
  // 30 requests a second per user.
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

function contextFor(credentials: Record<string, string>, services?: HostServices): TfContext {
  const token = (credentials["apiToken"] ?? "").trim();
  if (!token) throw new Error("Enter an API token first.");
  const caCert = (credentials["caCert"] ?? "").trim();
  return {
    token,
    hostname: normaliseHostname(credentials["hostname"] || DEFAULT_HOSTNAME),
    ...(services?.http ? { http: services.http } : {}),
    ...(caCert ? { caCert } : {}),
  };
}

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "organization") return [];
  const ctx = contextFor(credentials, services);
  try {
    const orgs = await tfList<Record<string, unknown>>(ctx, "/organizations");
    if (orgs.data.length === 0) throw new Error("The token can see no organizations.");
    return orgs.data
      .map((o) => ({
        id: o.id,
        label: o.id,
        ...(o.attributes["email"] ? { description: String(o.attributes["email"]) } : {}),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) throw new Error(`${ctx.hostname} rejected the token.`);
    throw err;
  }
}

/** The cloud host must not send a token to a private address someone typed in. */
function validateServerCredentials(credentials: Record<string, string>): string | null {
  let host: string;
  try {
    host = normaliseHostname(credentials["hostname"] || DEFAULT_HOSTNAME);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const problem = unsafeServerHostname(host);
  return problem
    ? `The hostname is ${problem}. Infrawrench cloud only connects to Terraform Enterprise on a public DNS name; use the desktop app or a bastion for a private install.`
    : null;
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new HcpTerraformClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
  validateServerCredentials,
  terraformExport: tfeTerraformExport,
};
