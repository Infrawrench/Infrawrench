/**
 * Credential preflight for CoreWeave.
 *
 * A CoreWeave API access token carries the permissions of the user who
 * created it, granted through IAM Access Policies as named roles (IAM roles
 * reference, docs.coreweave.com/security/iam/access-policies/roles,
 * 2026-10). Each capability lists the role its endpoint needs, and the
 * template is the role list to put in an access policy for the token's
 * owner. Probes are three-way as everywhere else: ok on a 2xx, missing on a
 * 403, unknown on anything else.
 *
 * The usage export is the exception to "403 means a missing role": CoreWeave
 * documents a 403 from `/v1/billing/focus` as "FOCUS isn't enabled for your
 * organization", which only CoreWeave Support can change, so the message says
 * that instead.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { CoreWeaveContext } from "./api.js";
import { OBSERVE_BASE, bearerFetch, cwFetch, statusOf } from "./api.js";

interface CapabilityProbe {
  capability: PreflightCapability;
  run: (ctx: CoreWeaveContext) => Promise<unknown>;
  forbiddenMessage?: string;
}

const role = (id: string) => ({ id, label: id });

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "clusters",
      label: "CKS clusters and VPCs",
      description:
        "List clusters and VPCs (CKS Viewer); create, edit and delete them and manage Node Pools (CKS Admin).",
      requiredPermissions: [role("CKS Viewer"), role("CKS Admin")],
    },
    run: (ctx) => cwFetch(ctx, "/v1beta1/cks/clusters"),
  },
  {
    capability: {
      id: "usage",
      label: "Usage and estimated cost",
      description:
        "Hourly billable usage from the FOCUS usage export, priced at your negotiated rates or the published list prices.",
      requiredPermissions: [role("Billing Viewer")],
    },
    run: (ctx) =>
      cwFetch(ctx, "/v1/billing/focus", {
        query: {
          page_size: 1,
          start_time: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 86_400_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        },
      }),
    forbiddenMessage:
      "The FOCUS usage export is not enabled for this organization. It is in public preview and CoreWeave Support turns it on per organization: ask them to enable FOCUS export, then check again.",
  },
  {
    capability: {
      id: "object-storage",
      label: "AI Object Storage",
      description:
        "List buckets with their size, change bucket settings, create and delete buckets, browse objects and list access keys.",
      requiredPermissions: [role("Object Storage Admin")],
    },
    run: (ctx) => cwFetch(ctx, "/v1/cwobject/bucket-info", { query: { limit: 1 } }),
  },
  {
    capability: {
      id: "metrics",
      label: "GPU metrics",
      description: "GPU utilization, tensor activity, memory and power charts.",
      requiredPermissions: [role("Observability Viewer")],
    },
    run: (ctx) =>
      bearerFetch(ctx, `${OBSERVE_BASE}/api/v1/query`, { query: { query: "vector(1)" } }),
  },
];

export const COREWEAVE_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "IAM roles", language: "text" },
};

const ACCESS_POLICIES_HELP = {
  label: "IAM Access Policies",
  url: "https://docs.coreweave.com/security/iam/access-policies",
};

export async function verifyCoreWeaveCredentials(ctx: CoreWeaveContext): Promise<PreflightResult> {
  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await probe.run(ctx);
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message:
              probe.forbiddenMessage ??
              "The token's owner lacks the role this needs. An organization administrator can grant it in an IAM access policy.",
            helpLink: ACCESS_POLICIES_HELP,
          };
        }
        if (status === 401) {
          return {
            capabilityId: probe.capability.id,
            status: "unknown",
            message:
              "CoreWeave rejected the API access token. Check that it was copied whole and has not expired or been deleted on the Tokens page.",
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
  return { checks };
}

export function coreweavePolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = PROBES.filter(
    (p) => capabilityIds.length === 0 || capabilityIds.includes(p.capability.id),
  );
  const roles = [
    ...new Set(selected.flatMap((p) => p.capability.requiredPermissions.map((r) => r.id))),
  ];
  return {
    formatLabel: "IAM roles",
    language: "text",
    document: roles.join("\n"),
    instructions:
      "In the CoreWeave Cloud Console, open IAM, Access Policies, and add a rule granting these roles to the user (or group) that owns the API access token. CKS Admin is only needed to create, edit, scale and delete; CKS Viewer alone keeps the account read-only. The usage export also has to be enabled for the organization by CoreWeave Support.",
    helpLink: ACCESS_POLICIES_HELP,
  };
}
