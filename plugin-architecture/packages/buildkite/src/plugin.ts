import type {
  CredentialFieldOption,
  HostServices,
  Plugin,
  PluginManifest,
} from "@infrawrench/plugin-base";
import type { BkContext } from "./api.js";
import { bkPaged, isPermissionError } from "./api.js";
import { BuildkiteClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import type { BkOrganization } from "./mappers.js";
import { PREFLIGHT_CAPABILITIES, policyTemplate, tokenUrl } from "./preflight.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { buildkiteTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "buildkite",
  version: "0.1.0",
  displayName: "Buildkite",
  description:
    "CI/CD on your own or Buildkite hosted agents. Manage pipelines and their YAML steps, start, cancel and rebuild builds, read job logs, stop and pause agents, and manage clusters, queues, agent tokens, secrets, schedules, pipeline templates and Test Engine flaky tests.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiToken",
      label: "API Access Token",
      description:
        "Create one under Personal Settings, API Access Tokens, New API Access Token, and give it access to the organization you are connecting. Read scopes: read_organizations, read_pipelines, read_builds, read_build_logs, read_artifacts, read_agents, read_clusters, read_secrets_details, read_pipeline_templates, read_suites, read_teams. To manage things too, add write_pipelines, write_builds, write_agents, write_clusters, write_secrets, write_pipeline_templates and write_suites. The link opens the form with all of them ticked.",
      sensitive: true,
      placeholder: "bkua_...",
      helpLink: { label: "Create a token with these scopes", url: tokenUrl([]) },
    },
    {
      key: "organization",
      label: "Organization",
      description:
        "The Buildkite organization to manage. The list shows every organization the token can access.",
      sensitive: false,
      providerOptions: { dependsOn: ["apiToken"] },
      placeholder: "my-org",
    },
  ],
  statusFeed,
  preflight: {
    capabilities: PREFLIGHT_CAPABILITIES,
    templateFormat: { label: "Buildkite API token scopes", language: "text" },
  },
  // 50 REST requests a minute per user and 200 per organization; stay under
  // the per-user limit so a sync never trips it on its own.
  rateLimit: { capacity: 8, refillPerSecond: 0.6 },
};

/**
 * Options for the organization picker: every organization the token can
 * access (`GET /v2/organizations`, which omits organizations without an
 * active plan). Runs before an account exists, so it builds its own context.
 */
async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "organization") return [];
  const token = (credentials["apiToken"] ?? "").trim();
  if (!token) throw new Error("Enter an API access token first.");
  const ctx: BkContext = { token, ...(services?.http ? { http: services.http } : {}) };
  try {
    const orgs = await bkPaged<BkOrganization>(ctx, "/organizations");
    if (orgs.length === 0) {
      throw new Error(
        "The token can access no Buildkite organizations. Check the organization access on the token, and that the organization has an active plan.",
      );
    }
    return orgs
      .map((o) => ({ id: o.slug, label: o.name, description: o.slug }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error("Buildkite rejected the token, or it lacks the read_organizations scope.");
    }
    throw err;
  }
}

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new BuildkiteClient(credentials, services),
  parseStatusFeed,
  listCredentialOptions,
  terraformExport: buildkiteTerraformExport,
  policyTemplate,
};
