/**
 * Credential preflight for Grafana Cloud.
 *
 * A cloud access policy token carries exactly the scopes of the policy it was
 * minted from, so least privilege means "create a policy with these scopes".
 * Every scope name below is the `x-permissions` value of the route it guards
 * in Grafana's published Cloud API OpenAPI document (2026-10), except
 * `billing-metrics:read`, which comes from the access policy scope reference
 * (the billing Prometheus endpoint is not in that document).
 *
 * Probes are three-way, as everywhere else: ok only on a 2xx, missing only on
 * a 403, unknown on anything else. A 401 means the token itself is wrong
 * (expired, revoked, mistyped), which no scope can fix, so it is reported
 * against every capability with that message. Write scopes are listed but
 * not probed: there is no read-only way to prove a write.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { listStacks, orgKeyFor, orgSlugOf, policyRegions, resolveOrg } from "./account.js";
import type { GrafanaContext } from "./api.js";
import { cloudFetch, statusOf } from "./api.js";

const perm = (id: string) => ({ id, label: id });

interface Probe {
  capability: PreflightCapability;
  run?: (ctx: GrafanaContext, orgSlug: string) => Promise<unknown>;
}

function currentMonthQuery(): { month: number; year: number } {
  const now = new Date();
  return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
}

async function firstStackId(ctx: GrafanaContext, orgSlug: string): Promise<number | undefined> {
  const stacks = await listStacks(ctx, orgSlug);
  return stacks.find((s) => s.id !== undefined)?.id;
}

const PROBES: Probe[] = [
  {
    capability: {
      id: "org",
      label: "Organization",
      description: "Read the organization, its plan and its slug. Everything else builds on it.",
      requiredPermissions: [perm("orgs:read")],
      essential: true,
    },
    // Straight to the route: `resolveOrg` tolerates a 403 when a slug was typed.
    run: (ctx, orgSlug) => cloudFetch(ctx, `/orgs/${encodeURIComponent(orgKeyFor(ctx, orgSlug))}`),
  },
  {
    capability: {
      id: "costs",
      label: "Cost data",
      description: "Billed usage by product and stack for the cost graphs and the monthly bill.",
      requiredPermissions: [perm("orgs:read")],
    },
    run: async (ctx, orgSlug) => {
      const slug = await orgSlugOf(ctx, orgSlug);
      return cloudFetch(ctx, `/orgs/${encodeURIComponent(slug)}/billed-usage`, {
        query: currentMonthQuery(),
      });
    },
  },
  {
    capability: {
      id: "stacks",
      label: "Stacks",
      description: "List stacks; create, edit, restart and delete them.",
      requiredPermissions: [perm("stacks:read"), perm("stacks:write"), perm("stacks:delete")],
    },
    run: (ctx, orgSlug) => listStacks(ctx, orgSlug),
  },
  {
    capability: {
      id: "plugins",
      label: "Installed plugins",
      description: "List the plugins installed on each stack; update and uninstall them.",
      requiredPermissions: [
        perm("stack-plugins:read"),
        perm("stack-plugins:write"),
        perm("stack-plugins:delete"),
      ],
    },
    run: async (ctx, orgSlug) => {
      const id = await firstStackId(ctx, orgSlug);
      if (id === undefined) return undefined;
      return cloudFetch(ctx, `/instances/${id}/plugins`);
    },
  },
  {
    capability: {
      id: "access-policies",
      label: "Access policies and tokens",
      description: "List access policies and their tokens; rename, turn off and delete them.",
      requiredPermissions: [
        perm("accesspolicies:read"),
        perm("accesspolicies:write"),
        perm("accesspolicies:delete"),
      ],
    },
    run: async (ctx, orgSlug) => {
      const region = (await policyRegions(ctx, orgSlug))[0];
      if (!region) return undefined;
      return cloudFetch(ctx, "/v1/accesspolicies", { query: { region, pageSize: 1 } });
    },
  },
  {
    capability: {
      id: "members",
      label: "Members",
      description: "List organization members; change their role or remove them.",
      requiredPermissions: [
        perm("org-members:read"),
        perm("org-members:write"),
        perm("org-members:delete"),
      ],
    },
    run: async (ctx, orgSlug) => {
      const slug = await orgSlugOf(ctx, orgSlug);
      return cloudFetch(ctx, `/orgs/${encodeURIComponent(slug)}/members`);
    },
  },
  {
    capability: {
      id: "connect",
      label: "Connect stacks automatically",
      description:
        "Create a service account and token on a stack with one click, so its dashboards, alert rules, contact points and data sources list without pasting a token.",
      requiredPermissions: [perm("stack-service-accounts:write")],
    },
  },
  {
    capability: {
      id: "usage-metrics",
      label: "Usage metrics",
      description:
        "Chart a stack's active series and ingest on its Metrics tab without connecting it. Connected stacks read the same metrics through their own data source instead.",
      requiredPermissions: [perm("billing-metrics:read")],
    },
  },
];

export const GRAFANA_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Access policy scopes", language: "text" },
};

function check(capability: PreflightCapability, err: unknown): PreflightCapabilityCheck {
  const status = statusOf(err);
  if (status === 403) {
    return {
      capabilityId: capability.id,
      status: "missing",
      missingPermissions: capability.requiredPermissions,
      message: "The token's access policy does not grant this.",
    };
  }
  return {
    capabilityId: capability.id,
    status: "unknown",
    message: err instanceof Error ? err.message.slice(0, 300) : String(err),
  };
}

export async function verifyGrafanaCredentials(
  ctx: GrafanaContext,
  orgSlug: string,
): Promise<PreflightResult> {
  let identity: string | undefined;
  try {
    const org = await resolveOrg(ctx, orgSlug);
    identity = org.name ? `${org.name} (${org.slug ?? ""})` : org.slug;
  } catch (err) {
    if (statusOf(err) === 401) {
      return {
        checks: PROBES.map((p) => ({
          capabilityId: p.capability.id,
          status: "unknown" as const,
          message:
            "Grafana Cloud rejected the token (401). Check that it is a cloud access policy token (glc_…) that has not expired or been revoked.",
        })),
      };
    }
  }
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      if (!p.run) {
        return {
          capabilityId: p.capability.id,
          status: "unknown",
          message: "Write scopes cannot be checked without making a change.",
        };
      }
      try {
        await p.run(ctx, orgSlug);
        return { capabilityId: p.capability.id, status: "ok" };
      } catch (err) {
        return check(p.capability, err);
      }
    }),
  );
  return { checks, ...(identity ? { identity } : {}) };
}

export function grafanaPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = new Set(capabilityIds);
  const scopes = new Set<string>();
  for (const p of PROBES) {
    if (!wanted.has(p.capability.id)) continue;
    for (const perm of p.capability.requiredPermissions) scopes.add(perm.id);
  }
  return {
    formatLabel: "Access policy scopes",
    language: "text",
    document: [...scopes].sort().join("\n"),
    instructions:
      "In the Grafana Cloud portal open Security, Access policies, create a policy with the organization as its realm and these scopes, then add a token to it and paste the token here.",
    helpLink: {
      label: "Create an access policy",
      url: "https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/create-access-policies/",
    },
  };
}
