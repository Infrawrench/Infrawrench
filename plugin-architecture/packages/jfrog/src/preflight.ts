/**
 * Credential preflight for the JFrog Platform.
 *
 * What a JFrog access token may do is decided by its scope: an admin token
 * (`applied-permissions/admin`) reaches everything, a user token
 * (`applied-permissions/user`) carries that user's permission targets, and the
 * Access APIs also accept narrow system scopes such as `system:identities:r`.
 * Every capability below names what its endpoint's reference page lists
 * under Security (docs.jfrog.com, 2026-10).
 *
 * Probes are three-way: ok on a 2xx, missing on a 401/403, unknown on
 * anything else (a 404 here usually means the product, e.g. Xray, is not part
 * of the subscription).
 */
import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { JfrogContext, Query, RequestOptions } from "./api.js";
import { jfrogFetch, statusOf } from "./api.js";

const perm = (id: string, label = id) => ({ id, label });
const ADMIN = perm("applied-permissions/admin", "Admin token (applied-permissions/admin)");

interface Probe {
  capability: PreflightCapability;
  path: string;
  query?: Query;
  opts?: RequestOptions;
}

const PROBES: Probe[] = [
  {
    capability: {
      id: "repositories",
      label: "Repositories and artifacts",
      description:
        "List repositories and browse their artifacts. Creating, editing and deleting repositories needs an admin token; uploads and deletes need deploy and delete permission on the repository.",
      requiredPermissions: [
        perm("applied-permissions/user", "Read permission on the repositories"),
      ],
      essential: true,
    },
    path: "/artifactory/api/repositories",
  },
  {
    capability: {
      id: "storage",
      label: "Storage summary and metrics",
      description: "Binaries, artifacts and per-repository usage from the storage summary.",
      requiredPermissions: [ADMIN, perm("system:info/storage:r")],
    },
    path: "/artifactory/api/storageinfo",
  },
  {
    capability: {
      id: "builds",
      label: "Builds",
      description: "List builds and their runs; delete them (needs delete permission on builds).",
      requiredPermissions: [perm("applied-permissions/user", "Read permission on builds")],
    },
    path: "/artifactory/api/build",
  },
  {
    capability: {
      id: "xray",
      label: "Xray watches, policies and violations",
      description:
        "List watches and policies and the latest violations; enable, disable, edit and delete them. Needs Xray in the subscription.",
      requiredPermissions: [ADMIN, perm("Manage Watches / Manage Policies roles")],
    },
    path: "/xray/api/v2/watches",
  },
  {
    capability: {
      id: "identities",
      label: "Users and groups",
      description: "List, create, edit and delete users and groups.",
      requiredPermissions: [ADMIN, perm("system:identities:r")],
    },
    path: "/access/api/v2/users",
    query: { limit: 1 },
  },
  {
    capability: {
      id: "permissions",
      label: "Permissions",
      description: "List permission targets and their grants; delete them.",
      requiredPermissions: [ADMIN, perm("system:permissions:r")],
    },
    path: "/access/api/v2/permissions",
    query: { limit: 1 },
  },
  {
    capability: {
      id: "tokens",
      label: "Access tokens",
      description:
        "List and revoke access tokens and create new ones. An admin token sees every token; any other token sees only its own user's.",
      requiredPermissions: [perm("applied-permissions/user")],
    },
    path: "/access/api/v1/tokens",
  },
];

export const JFROG_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

export async function verifyJfrogCredentials(ctx: JfrogContext): Promise<PreflightResult> {
  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await jfrogFetch(ctx, probe.path, { ...(probe.query ? { query: probe.query } : {}) });
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message:
              status === 401
                ? "The token was rejected (expired or revoked?)."
                : "The token's scope does not allow this.",
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
  let identity: string | undefined;
  try {
    const me = await jfrogFetch<{ subject?: string }>(ctx, "/access/api/v1/tokens/me");
    identity = me?.subject;
  } catch {
    // Identity tokens and older platforms may not answer `me`; the checks still stand.
  }
  return { checks, ...(identity ? { identity } : {}) };
}
