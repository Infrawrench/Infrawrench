import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import type { PuContext } from "./api.js";
import { DEFAULT_API_URL, isPermissionError, normaliseApiUrl, puFetch } from "./api.js";
import { PulumiCloudClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { pulumiCloudRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { DEFAULT_PLAN, PLANS } from "./usage.js";

const manifest: PluginManifest = {
  id: "pulumi-cloud",
  version: "0.1.0",
  displayName: "Pulumi Cloud",
  description:
    "Pulumi Cloud: stacks with outputs other resources can reference, update history and drift, Pulumi Deployments with logs, schedules and settings, ESC environments with revisions, organization tokens, teams, webhooks, policy packs and policy groups, and usage-based cost.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessToken",
      label: "Access Token",
      description:
        "A personal token (Account, Personal access tokens) sees every organization you belong to; an organization token (Organization settings, Access tokens) is limited to that organization and suits shared use. Admin access is needed to list tokens, teams and webhooks and to read usage.",
      sensitive: true,
      placeholder: "pul-...",
      helpLink: {
        label: "Access tokens",
        url: "https://www.pulumi.com/docs/administration/access-identity/access-tokens/",
      },
    },
    {
      key: "organization",
      label: "Organization",
      description:
        "The organization to manage. The list shows every organization the token can see.",
      sensitive: false,
      providerOptions: { dependsOn: ["accessToken"] },
      placeholder: "acme",
    },
    {
      key: "plan",
      label: "Pulumi Plan",
      description:
        "Pulumi's API reports usage but not your plan, so pick yours: its published rates turn resource-hours, deployment minutes and ESC secret-hours into estimated cost.",
      sensitive: false,
      defaultValue: DEFAULT_PLAN,
      regions: PLANS.map((p) => ({ id: p.id, label: p.label, location: p.summary })),
    },
    {
      key: "rateOverrides",
      label: "Rate Overrides (optional)",
      description:
        "Replace a published rate for a contract price, one key=value per line: resourceHour, secretHour, deploymentMinute (USD).",
      sensitive: false,
      optional: true,
      multiline: true,
      advanced: true,
      placeholder: "resourceHour=0.0004\ndeploymentMinute=0.008",
    },
    {
      key: "apiUrl",
      label: "API URL (self-hosted only)",
      description:
        "Leave empty for Pulumi Cloud. For self-hosted Pulumi Cloud, the API service URL.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: DEFAULT_API_URL,
    },
    caCertCredentialField,
  ],
  costs: {
    // Daily usage from the resources, deployments and secrets summaries,
    // priced at the picked plan's published rates.
    dimensions: ["service", "tag"],
    maxHistoryDays: 360,
    restatementDays: 3,
    estimated: true,
  },
  statusFeed,
  rateLimit: { capacity: 10, refillPerSecond: 5 },
};

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "organization") return [];
  const token = (credentials["accessToken"] ?? "").trim();
  if (!token) throw new Error("Enter an access token first.");
  const caCert = (credentials["caCert"] ?? "").trim();
  const ctx: PuContext = {
    token,
    apiUrl: normaliseApiUrl(credentials["apiUrl"]),
    ...(services?.http ? { http: services.http } : {}),
    ...(caCert ? { caCert } : {}),
  };
  try {
    const user = await puFetch<{
      organizations?: Array<{ githubLogin: string; name?: string; role?: string }>;
      tokenInfo?: { organization?: string };
    }>(ctx, "/api/user");
    const orgs = (user?.organizations ?? []).map((o) => ({
      id: o.githubLogin,
      label: o.name || o.githubLogin,
      ...(o.role ? { description: `${o.githubLogin} (${o.role})` } : {}),
    }));
    const tokenOrg = user?.tokenInfo?.organization;
    if (tokenOrg && !orgs.some((o) => o.id === tokenOrg))
      orgs.push({ id: tokenOrg, label: tokenOrg });
    if (orgs.length === 0) throw new Error("The token belongs to no organizations.");
    return orgs.sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) throw new Error("Pulumi Cloud rejected the access token.");
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PulumiCloudClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
  remediationCommands: pulumiCloudRemediationCommands,
};
