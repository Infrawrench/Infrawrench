/**
 * Credential preflight for Sentry.
 *
 * Internal integration and personal tokens both carry an explicit scope list
 * (`org:read`, `event:write`, `alerts:read` and so on), so the least-privilege
 * story is the scope list itself: every capability names the scopes its
 * endpoints declare in Sentry's published OpenAPI document
 * (getsentry/sentry-api-schema, 2026-10), and the template is the list to
 * tick when creating the token.
 *
 * Probes are three-way, as everywhere else: ok only on a 2xx, missing only on
 * a 403, unknown on anything else. A 401 means the token itself is wrong,
 * which no scope can fix.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { Query, SentryContext } from "./api.js";
import { sentryFetch, statusOf } from "./api.js";

interface CapabilityProbe {
  capability: PreflightCapability;
  path: (org: string) => string;
  query?: () => Query;
}

const scope = (id: string) => ({ id, label: id });

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "costs",
      label: "Usage and cost",
      description:
        "Usage per data category and project from the usage stats API, priced into estimated cost.",
      requiredPermissions: [scope("org:read")],
    },
    path: (org) => `/organizations/${org}/stats_v2/`,
    query: () => ({
      field: "sum(quantity)",
      groupBy: ["category"],
      statsPeriod: "1d",
      interval: "1d",
    }),
  },
  {
    capability: {
      id: "projects",
      label: "Projects and client keys",
      description:
        "List projects and their client keys (DSNs); create, rename and delete projects; edit, enable and disable keys.",
      requiredPermissions: [scope("org:read"), scope("project:read"), scope("project:write")],
      essential: true,
    },
    path: (org) => `/organizations/${org}/projects/`,
    query: () => ({ per_page: 1 }),
  },
  {
    capability: {
      id: "teams",
      label: "Teams",
      description: "List teams; create, rename and delete them.",
      requiredPermissions: [scope("team:read"), scope("team:write")],
    },
    path: (org) => `/organizations/${org}/teams/`,
    query: () => ({ per_page: 1 }),
  },
  {
    capability: {
      id: "issues",
      label: "Issues",
      description:
        "List unresolved issues and chart their events; resolve, archive and reopen them.",
      requiredPermissions: [scope("event:read"), scope("event:write")],
    },
    path: (org) => `/organizations/${org}/issues/`,
    query: () => ({ query: "is:unresolved", limit: 1, statsPeriod: "24h" }),
  },
  {
    capability: {
      id: "releases",
      label: "Releases",
      requiredPermissions: [scope("project:releases")],
    },
    path: (org) => `/organizations/${org}/releases/`,
    query: () => ({ per_page: 1 }),
  },
  {
    capability: {
      id: "alerts",
      label: "Alerts and monitors",
      description: "List alerts and monitors (detectors); enable, disable, rename and delete them.",
      requiredPermissions: [scope("alerts:read"), scope("alerts:write")],
    },
    path: (org) => `/organizations/${org}/workflows/`,
    query: () => ({ per_page: 1 }),
  },
  {
    capability: {
      id: "crons",
      label: "Cron and uptime monitors",
      description:
        "List cron and uptime monitors and chart check-ins; pause, resume, mute, edit and delete them.",
      requiredPermissions: [scope("alerts:read"), scope("alerts:write"), scope("project:write")],
    },
    path: (org) => `/organizations/${org}/monitors/`,
    query: () => ({ per_page: 1 }),
  },
];

export const SENTRY_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Token scopes", language: "text" },
};

const SCOPES_HELP = {
  label: "Sentry token scopes",
  url: "https://docs.sentry.io/api/permissions/",
};

/** What kind of token this is, from its documented prefix. */
export function tokenKind(token: string): string | undefined {
  if (token.startsWith("sntryi_")) return "Internal integration token";
  if (token.startsWith("sntryu_")) return "Personal token";
  if (token.startsWith("sntrya_")) return "User app token";
  if (token.startsWith("sntrys_")) return "Organization token";
  return undefined;
}

export async function verifySentryCredentials(
  ctx: SentryContext,
  org: string,
): Promise<PreflightResult> {
  const slug = encodeURIComponent(org);
  let identity: string | undefined;
  try {
    const detail = await sentryFetch<{ name?: string; slug?: string }>(
      ctx,
      `/organizations/${slug}/`,
    );
    const kind = tokenKind(ctx.token);
    identity = [kind, detail?.name ?? detail?.slug ?? org].filter(Boolean).join(" for ");
  } catch (err) {
    const status = statusOf(err);
    const message =
      status === 401
        ? "Sentry rejected the token. Check it, and that it has not been revoked."
        : status === 403 || status === 404
          ? `The token cannot read the organization "${org}". Check the organization and region, and that the token has the org:read scope.`
          : `Could not reach Sentry (${ctx.instance.label}): ${err instanceof Error ? err.message : String(err)}`;
    return {
      checks: PROBES.map((p) => ({ capabilityId: p.capability.id, status: "unknown", message })),
    };
  }

  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await sentryFetch<unknown>(ctx, probe.path(slug), { query: probe.query?.() ?? {} });
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message: "The token lacks the scopes this needs.",
            helpLink: SCOPES_HELP,
          };
        }
        return {
          capabilityId: probe.capability.id,
          status: "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return { checks, ...(identity ? { identity } : {}) };
}

export function sentryPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = PROBES.filter(
    (p) => capabilityIds.length === 0 || capabilityIds.includes(p.capability.id),
  );
  const scopes = [
    ...new Set(selected.flatMap((p) => p.capability.requiredPermissions.map((x) => x.id))),
  ].sort();
  return {
    formatLabel: "Token scopes",
    language: "text",
    document: scopes.join("\n"),
    instructions:
      "In Sentry, open Settings, then Developer Settings, create a New Internal Integration and grant it these permissions (Read for the :read scopes, Read & Write for :write), then copy its token. A personal token (User Settings, Personal Tokens) with the same scopes also works, limited to what your own role allows. Leave out the :write scopes for a read-only connection.",
    helpLink: SCOPES_HELP,
  };
}
