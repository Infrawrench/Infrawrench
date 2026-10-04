/**
 * Credential preflight for GitHub.
 *
 * Organizations: a fine-grained personal access token, resource owner the
 * organization, with the organization permissions below (permission names
 * and the endpoints behind them from GitHub's fine-grained token permission
 * reference, verified 2026-10). A classic token works too with `admin:org`,
 * `manage_billing:copilot`, `repo` and `codespace`.
 *
 * Enterprises: fine-grained tokens cannot reach enterprise endpoints at all,
 * so an enterprise account needs a classic token with
 * `manage_billing:enterprise` (billing, budgets, cost centres) and
 * `manage_billing:copilot` or `read:enterprise` (Copilot seats and metrics),
 * owned by an enterprise owner or billing manager.
 *
 * Probes are three-way: ok only on a 2xx, missing on a 403 (or the 404 GitHub
 * answers when a token may not see the resource at all), unknown otherwise.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { GitHubContext } from "./api.js";
import { billingBase, ghFetch, ownerBase, statusOf } from "./api.js";

const perm = (id: string, label: string) => ({ id, label });

interface CapabilityProbe {
  capability: PreflightCapability;
  /** Where to probe, per owner kind; absent means "organizations only". */
  org: (ctx: GitHubContext) => string;
  enterprise?: (ctx: GitHubContext) => string;
  query?: Record<string, string | number>;
}

const now = new Date();
const ym = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "costs",
      label: "Billing usage and costs",
      description:
        "Daily cost by product, SKU, repository and cost centre with discounts, this month's summary, premium requests and AI credits by model.",
      requiredPermissions: [
        perm("organization_administration:read", "Organization: Administration (read)"),
        perm("manage_billing:enterprise", "Enterprise (classic token): manage_billing:enterprise"),
      ],
      essential: true,
    },
    org: (ctx) => `${billingBase(ctx.owner)}/usage/summary`,
    enterprise: (ctx) => `${billingBase(ctx.owner)}/usage/summary`,
    query: ym,
  },
  {
    capability: {
      id: "budgets",
      label: "Budgets",
      description: "List budgets; create, edit and delete them with write access.",
      requiredPermissions: [
        perm("organization_administration:write", "Organization: Administration (read and write)"),
        perm("manage_billing:enterprise", "Enterprise (classic token): manage_billing:enterprise"),
      ],
    },
    org: (ctx) => `${billingBase(ctx.owner)}/budgets`,
    enterprise: (ctx) => `${billingBase(ctx.owner)}/budgets`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "copilot-seats",
      label: "Copilot seats",
      description: "List seats with last activity; assign and remove seats with write access.",
      requiredPermissions: [
        perm(
          "organization_copilot_seat_management:write",
          "Organization: GitHub Copilot Business (read and write)",
        ),
        perm("manage_billing:copilot", "Enterprise (classic token): manage_billing:copilot"),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/copilot/billing/seats`,
    enterprise: (ctx) => `${ownerBase(ctx.owner)}/copilot/billing/seats`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "copilot-metrics",
      label: "Copilot usage metrics",
      description: "Daily and weekly Copilot active users on the Metrics tab.",
      requiredPermissions: [
        perm(
          "organization_copilot_metrics:read",
          "Organization: Organization Copilot metrics (read)",
        ),
        perm("read:enterprise", "Enterprise (classic token): read:enterprise"),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/copilot/metrics/reports/organization-28-day/latest`,
    enterprise: (ctx) => `${ownerBase(ctx.owner)}/copilot/metrics/reports/enterprise-28-day/latest`,
  },
  {
    capability: {
      id: "hosted-runners",
      label: "Larger runners",
      description:
        "List GitHub-hosted larger runners; create, edit and delete them with write access.",
      requiredPermissions: [
        perm("organization_administration:write", "Organization: Administration (read and write)"),
        perm("manage_runners:enterprise", "Enterprise (classic token): manage_runners:enterprise"),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/actions/hosted-runners`,
    enterprise: (ctx) => `${ownerBase(ctx.owner)}/actions/hosted-runners`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "runners",
      label: "Self-hosted runners",
      description: "List self-hosted runners and remove their registrations. Organizations only.",
      requiredPermissions: [
        perm(
          "organization_self_hosted_runners:write",
          "Organization: Self-hosted runners (read and write)",
        ),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/actions/runners`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "caches",
      label: "Actions caches",
      description:
        "Cache usage per repository (organization Administration read); listing and deleting caches also needs the repository permission Actions (read and write) on the repositories. Organizations only.",
      requiredPermissions: [
        perm("organization_administration:read", "Organization: Administration (read)"),
        perm("actions:write", "Repository: Actions (read and write)"),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/actions/cache/usage-by-repository`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "codespaces",
      label: "Codespaces",
      description: "List the organization's codespaces; stop and delete them. Organizations only.",
      requiredPermissions: [
        perm(
          "organization_codespaces:write",
          "Organization: Organization codespaces (read and write)",
        ),
      ],
    },
    org: (ctx) => `${ownerBase(ctx.owner)}/codespaces`,
    query: { per_page: 1 },
  },
  {
    capability: {
      id: "cost-centers",
      label: "Cost centres",
      description: "List, create, edit and delete enterprise cost centres. Enterprises only.",
      requiredPermissions: [
        perm("manage_billing:enterprise", "Enterprise (classic token): manage_billing:enterprise"),
      ],
    },
    org: () => "",
    enterprise: (ctx) => `${billingBase(ctx.owner)}/cost-centers`,
  },
];

export const GITHUB_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Token permissions", language: "text" },
};

async function probe(ctx: GitHubContext, p: CapabilityProbe): Promise<PreflightCapabilityCheck> {
  const id = p.capability.id;
  const path = ctx.owner.kind === "org" ? p.org(ctx) : p.enterprise?.(ctx);
  if (!path) {
    return {
      capabilityId: id,
      status: "unknown",
      message:
        ctx.owner.kind === "org"
          ? "Only available to enterprise accounts."
          : "Only available to organization accounts. Add each organization as its own account for this.",
    };
  }
  try {
    await ghFetch<unknown>(ctx, path, p.query ? { query: p.query } : undefined);
    return { capabilityId: id, status: "ok" };
  } catch (err) {
    const status = statusOf(err);
    const message = err instanceof Error ? err.message : String(err);
    if (status === 401) {
      return {
        capabilityId: id,
        status: "unknown",
        message: "GitHub rejected the token. It may have expired or been revoked.",
      };
    }
    if (status === 403 || status === 404) {
      const relevant = p.capability.requiredPermissions.filter((perm) =>
        ctx.owner.kind === "org"
          ? !perm.label.startsWith("Enterprise")
          : perm.label.startsWith("Enterprise"),
      );
      return {
        capabilityId: id,
        status: "missing",
        missingPermissions: relevant.length > 0 ? relevant : p.capability.requiredPermissions,
        message,
      };
    }
    return { capabilityId: id, status: "unknown", message };
  }
}

export async function verifyGitHubCredentials(ctx: GitHubContext): Promise<PreflightResult> {
  const user = await ghFetch<{ login?: string }>(ctx, "/user").catch(() => undefined);
  const checks = await Promise.all(PROBES.map((p) => probe(ctx, p)));
  return {
    checks,
    ...(user?.login
      ? {
          identity: `${user.login} on ${ctx.owner.kind === "org" ? "organization" : "enterprise"} ${ctx.owner.slug}`,
        }
      : {}),
  };
}

/** The permissions to grant, for the capabilities picked in the generator. */
export function githubPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const picked = PROBES.filter((p) => capabilityIds.includes(p.capability.id));
  const orgPerms = new Map<string, string>();
  const entScopes = new Set<string>();
  for (const p of picked) {
    for (const perm of p.capability.requiredPermissions) {
      if (perm.label.startsWith("Enterprise")) entScopes.add(perm.id);
      else orgPerms.set(perm.id, perm.label);
    }
  }
  // Read and write of the same permission collapse to the stronger one.
  for (const id of [...orgPerms.keys()]) {
    if (id.endsWith(":read") && orgPerms.has(id.replace(/:read$/, ":write"))) orgPerms.delete(id);
  }
  const lines = [
    "Organization account: fine-grained personal access token",
    "  Resource owner: the organization",
    "  Repository access: All repositories",
    ...[...orgPerms.values()].sort().map((l) => `  ${l}`),
    "",
    "Enterprise account: personal access token (classic)",
    ...(entScopes.size > 0
      ? [...entScopes].sort().map((s) => `  ${s}`)
      : ["  (none of the picked capabilities apply)"]),
  ];
  return {
    formatLabel: "Token permissions",
    language: "text",
    document: lines.join("\n"),
    instructions:
      "Create the token under Settings, Developer settings, Personal access tokens. Fine-grained tokens cannot reach enterprise endpoints, so enterprise accounts need a classic token. The token's owner must be an organization owner or billing manager (enterprise owner or billing manager for an enterprise).",
    helpLink: {
      label: "Create a fine-grained token",
      url: "https://github.com/settings/personal-access-tokens/new",
    },
  };
}
