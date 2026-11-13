import { defineCredentials, definePlugin } from "@infrawrench/plugin-base";
import { attemptFn } from "@infrawrench/plugin-base/effect";
import type {
  CredentialFieldOption,
  HostServices,
  PluginManifest,
  CredentialsOf,
} from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { nfFetch, nfList } from "./api.js";
import { NORTHFLANK_CI_EXECUTOR } from "./ci-executor.js";
import { NorthflankClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { northflankRemediationCommands } from "./remediation.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import type { NfAuth, NfTeam } from "./types.js";

export const manifest = {
  id: "northflank",
  egressHosts: ["api.northflank.com"],
  displayName: "Northflank",
  description:
    "Manage Northflank projects, services, jobs, database addons, secret groups, volumes, pipelines, domains and BYOC clusters: deploy images, start builds, scale, pause, run jobs, back up and upgrade addons, tail logs and chart metrics, with daily spend by project.",
  logoSvg: LOGO_SVG,
  credentialFields: defineCredentials([
    {
      key: "apiToken",
      label: "API Token",
      description:
        "In Northflank, open your team (or organisation) settings, then API, then Tokens, and create a token using an API role. Give the role read access everywhere you want inventory, plus Manage permissions for the actions you will use (deploy, scale, run jobs, backups); billing data needs Billing read.",
      sensitive: true,
      placeholder: "nf-eyJhbGciOi...",
      helpLink: {
        label: "Manage API tokens",
        url: "https://northflank.com/docs/v1/application/secure/manage-api-tokens",
      },
    },
    {
      key: "teamId",
      label: "Team",
      description:
        "Only for organisation tokens: the team whose resources this account manages. Team tokens are already scoped to their team, so leave it empty.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiToken"], emptyLabel: "The token's own team" },
    },
    caCertCredentialField,
  ]),
  costs: {
    // Daily PaaS spend split by project (resource = project id) and by
    // CPU / memory / storage / GPU, plus BYOC, egress IP and load balancer
    // lines at account level.
    dimensions: ["service", "resource"],
    maxHistoryDays: 365,
    restatementDays: 3,
  },
  statusFeed,
  // Documented default: 1000 requests per hour per account.
  rateLimit: { capacity: 30, refillPerSecond: 0.25 },
  // CI jobs as manual job runs in a CI project per region. See ci-executor.ts.
  ciExecutor: NORTHFLANK_CI_EXECUTOR,
} satisfies PluginManifest;

export type Credentials = CredentialsOf<typeof manifest>;

async function listCredentialOptions(
  fieldKey: string,
  credentials: Record<string, string>,
  services?: HostServices,
): Promise<CredentialFieldOption[]> {
  if (fieldKey !== "teamId") return [];
  const token = (credentials["apiToken"] ?? "").trim();
  if (!token) return [];
  const caCert = (credentials["caCert"] ?? "").trim();
  const ctx = {
    token,
    ...(services?.http ? { http: services.http } : {}),
    ...(caCert ? { caCert } : {}),
  };
  const auth = await nfFetch<{ data?: NfAuth }>(ctx, "GET", "/v1/auth", { teamScoped: false });
  if (auth?.data?.entityType !== "org") return [];
  const teams = await nfList<NfTeam>(ctx, "/v1/teams", "teams", { teamScoped: false });
  return teams.map((t) => ({
    id: t.id ?? "",
    label: t.name ?? t.id ?? "",
    ...(t.description ? { description: t.description } : {}),
  }));
}

export const plugin = definePlugin({
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new NorthflankClient(credentials, services),
  testCredentials: { apiToken: "test-northflank-token" },
  parseStatusFeed: (body: string) => parseStatusFeed(body),
  listCredentialOptions: attemptFn(listCredentialOptions),
  remediationCommands: northflankRemediationCommands,
});
