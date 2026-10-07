/**
 * Credential preflight for PostHog. A personal API key carries an explicit
 * scope list chosen at creation (scope names below are the `security` entries
 * of each route in PostHog's OpenAPI schema, 2026-10), but there is no route
 * that reports a key's own scopes, so each area is probed with a one-item
 * list: ok on 2xx, missing on 403, unknown otherwise.
 */
import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { PostHogContext } from "./api.js";
import { phFetch, statusOf } from "./api.js";
import type { Obj } from "./mappers.js";

const perm = (id: string) => ({ id, label: id });

interface Probe {
  capability: PreflightCapability;
  /** Path to probe, given the org id and a project id. */
  path?: (org: string, project: string) => string;
}

const project = (route: string) => (_org: string, p: string) =>
  `/api/projects/${encodeURIComponent(p)}/${route}/`;

const PROBES: Probe[] = [
  {
    capability: {
      id: "org",
      label: "Organization and projects",
      description: "Read the organization and list its projects. Everything else builds on it.",
      requiredPermissions: [perm("organization:read"), perm("project:read")],
      essential: true,
    },
    path: (org) => `/api/organizations/${encodeURIComponent(org)}/projects/`,
  },
  {
    capability: {
      id: "flags",
      label: "Feature flags",
      description: "List, create, edit, toggle and delete feature flags.",
      requiredPermissions: [perm("feature_flag:read"), perm("feature_flag:write")],
    },
    path: project("feature_flags"),
  },
  {
    capability: {
      id: "experiments",
      label: "Experiments",
      description: "List experiments; launch, pause, resume, end and archive them.",
      requiredPermissions: [perm("experiment:read"), perm("experiment:write")],
    },
    path: project("experiments"),
  },
  {
    capability: {
      id: "content",
      label: "Dashboards, insights, cohorts, actions and annotations",
      description: "List and edit analytics content.",
      requiredPermissions: [
        perm("dashboard:read"),
        perm("dashboard:write"),
        perm("insight:read"),
        perm("insight:write"),
        perm("cohort:read"),
        perm("cohort:write"),
        perm("action:read"),
        perm("action:write"),
        perm("annotation:read"),
        perm("annotation:write"),
      ],
    },
    path: project("dashboards"),
  },
  {
    capability: {
      id: "pipeline",
      label: "Destinations and batch exports",
      description: "Toggle Hog functions and pause batch exports.",
      requiredPermissions: [
        perm("hog_function:read"),
        perm("hog_function:write"),
        perm("batch_export:read"),
        perm("batch_export:write"),
      ],
    },
    path: project("batch_exports"),
  },
  {
    capability: {
      id: "query",
      label: "HogQL and metrics",
      description: "Run HogQL from the Query tab and chart events and flag evaluations.",
      requiredPermissions: [perm("query:read")],
    },
  },
  {
    capability: {
      id: "members",
      label: "Members",
      description: "List members, change their level, remove them.",
      requiredPermissions: [perm("organization_member:read"), perm("organization_member:write")],
    },
    path: (org) => `/api/organizations/${encodeURIComponent(org)}/members/`,
  },
  {
    capability: {
      id: "billing",
      label: "Cost data",
      description:
        "Daily spend by product and project for Costs, and the billing period on the organization.",
      requiredPermissions: [perm("billing:read")],
    },
    path: () => "/api/billing/",
  },
];

export const POSTHOG_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Personal API key scopes", language: "text" },
};

export function posthogPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = PROBES.map((p) => p.capability).filter(
    (c) => capabilityIds.length === 0 || capabilityIds.includes(c.id) || c.essential,
  );
  const scopes = Array.from(new Set(wanted.flatMap((c) => c.requiredPermissions.map((p) => p.id))));
  return {
    formatLabel: "Personal API key scopes",
    language: "text",
    document: scopes.join("\n"),
    instructions:
      "In PostHog open Settings, Personal API keys, Create personal API key. Limit it to your organization, and pick these scopes.",
    helpLink: { label: "PostHog personal API keys", url: "https://posthog.com/docs/api" },
  };
}

export async function verifyPostHogCredentials(
  ctx: PostHogContext,
  orgId: () => Promise<string>,
  projects: () => Promise<Obj[]>,
): Promise<PreflightResult> {
  let org = "";
  let firstProject = "";
  try {
    org = await orgId();
    firstProject = String((await projects())[0]?.id ?? "");
  } catch {
    // Reported through the probes below.
  }
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      const id = p.capability.id;
      try {
        if (id === "query") {
          if (!firstProject)
            return { capabilityId: id, status: "unknown", message: "No project to test against." };
          await phFetch(ctx, `/api/projects/${encodeURIComponent(firstProject)}/query/`, {
            method: "POST",
            body: JSON.stringify({ query: { kind: "HogQLQuery", query: "SELECT 1" } }),
          });
          return { capabilityId: id, status: "ok" };
        }
        if (!p.path) return { capabilityId: id, status: "unknown" };
        if (p.path.length > 1 && !firstProject) {
          return { capabilityId: id, status: "unknown", message: "No project to test against." };
        }
        await phFetch(ctx, p.path(org || "@current", firstProject), { query: { limit: 1 } });
        return { capabilityId: id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403)
          return {
            capabilityId: id,
            status: "missing",
            missingPermissions: p.capability.requiredPermissions,
          };
        return {
          capabilityId: id,
          status: "unknown",
          message:
            status === 401
              ? "PostHog rejected the key: it is wrong, revoked, or for another region."
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }),
  );
  return { checks };
}
