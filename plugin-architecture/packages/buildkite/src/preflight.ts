import type { PolicyTemplate, PreflightCapability } from "@infrawrench/plugin-base";

/**
 * What each part of the plugin needs from the API access token. Buildkite
 * reports a token's scopes at `GET /v2/access-token`, so the preflight probe
 * compares them directly instead of trying each endpoint. Scope names are
 * from https://buildkite.com/docs/apis/managing-api-tokens (2026-10).
 */
export const PREFLIGHT_CAPABILITIES: PreflightCapability[] = [
  {
    id: "resources",
    label: "Organization, pipelines and builds",
    description: "List the organization, pipelines, builds and jobs.",
    essential: true,
    requiredPermissions: [
      { id: "read_organizations", label: "Read organizations" },
      { id: "read_pipelines", label: "Read pipelines" },
      { id: "read_builds", label: "Read builds" },
    ],
  },
  {
    id: "manage-pipelines",
    label: "Edit pipelines and schedules",
    description: "Create, edit, archive and delete pipelines and their schedules.",
    requiredPermissions: [{ id: "write_pipelines", label: "Modify pipelines" }],
  },
  {
    id: "run-builds",
    label: "Start, cancel and retry builds",
    requiredPermissions: [{ id: "write_builds", label: "Modify builds" }],
  },
  {
    id: "logs",
    label: "Job logs",
    requiredPermissions: [{ id: "read_build_logs", label: "Read build logs" }],
  },
  {
    id: "artifacts",
    label: "Build artifacts",
    requiredPermissions: [{ id: "read_artifacts", label: "Read artifacts" }],
  },
  {
    id: "agents",
    label: "Agents",
    description: "List agents, and stop, pause or resume them.",
    requiredPermissions: [
      { id: "read_agents", label: "Read agents" },
      { id: "write_agents", label: "Modify agents" },
    ],
  },
  {
    id: "clusters",
    label: "Clusters, queues and agent tokens",
    requiredPermissions: [
      { id: "read_clusters", label: "Read clusters" },
      { id: "write_clusters", label: "Modify clusters" },
    ],
  },
  {
    id: "secrets",
    label: "Cluster secrets",
    requiredPermissions: [
      { id: "read_secrets_details", label: "Read secret details" },
      { id: "write_secrets", label: "Modify secrets" },
    ],
  },
  {
    id: "templates",
    label: "Pipeline templates (Enterprise)",
    requiredPermissions: [
      { id: "read_pipeline_templates", label: "Read pipeline templates" },
      { id: "write_pipeline_templates", label: "Modify pipeline templates" },
    ],
  },
  {
    id: "test-engine",
    label: "Test Engine suites and flaky tests",
    requiredPermissions: [
      { id: "read_suites", label: "Read suites" },
      { id: "write_suites", label: "Modify suites" },
    ],
  },
  {
    id: "teams",
    label: "Team pickers",
    description: "Offer teams when creating pipelines and suites.",
    requiredPermissions: [{ id: "read_teams", label: "Read teams" }],
  },
];

export const TOKEN_PAGE = "https://buildkite.com/user/api-access-tokens/new";

/** The "New API access token" URL with the scopes for `capabilityIds` ticked. */
export function tokenUrl(capabilityIds: string[]): string {
  const wanted = new Set(capabilityIds);
  const scopes = new Set<string>();
  for (const c of PREFLIGHT_CAPABILITIES) {
    if (wanted.size > 0 && !wanted.has(c.id)) continue;
    for (const p of c.requiredPermissions) scopes.add(p.id);
  }
  const params = new URLSearchParams({ description: "Infrawrench" });
  for (const s of scopes) params.append("scopes[]", s);
  return `${TOKEN_PAGE}?${params.toString()}`;
}

export function policyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = new Set(capabilityIds);
  const scopes = PREFLIGHT_CAPABILITIES.filter(
    (c) => wanted.size === 0 || wanted.has(c.id),
  ).flatMap((c) => c.requiredPermissions.map((p) => p.id));
  return {
    formatLabel: "Buildkite API token scopes",
    language: "text",
    document: [...new Set(scopes)].join("\n"),
    instructions:
      "Open the link, check the scopes listed here (the link ticks them for you), and limit the token to the organization you are connecting.",
    helpLink: { label: "New API access token", url: tokenUrl(capabilityIds) },
  };
}
