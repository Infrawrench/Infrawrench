/**
 * Credential preflight for Honeycomb.
 *
 * Both key kinds describe themselves, so nothing has to be probed by trial:
 * `GET /1/auth` returns a configuration key's `api_key_access` flags (one per
 * permission checkbox in Honeycomb's key editor) and `GET /2/auth` returns a
 * management key's `scopes`. Each capability is checked against those.
 * There is no policy template: Honeycomb permissions are checkboxes on the
 * key, not a document to paste.
 */

import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { HoneycombContext } from "./api.js";
import { statusOf, v1, v2 } from "./api.js";
import type { HnyAuth, HnyAuthV2 } from "./types.js";

const perm = (id: string, label: string) => ({ id, label });

interface ConfigCapability {
  capability: PreflightCapability;
  /** `api_key_access` flags that must all be true (alternate spellings allowed). */
  flags: string[][];
}

const CONFIG_CAPABILITIES: ConfigCapability[] = [
  {
    capability: {
      id: "resources",
      label: "Datasets and columns",
      description: "List datasets, columns and derived columns, and edit their settings.",
      requiredPermissions: [perm("Manage Queries and Columns", "Manage Queries and Columns")],
      essential: true,
    },
    flags: [["columns"]],
  },
  {
    capability: {
      id: "metrics",
      label: "Metrics",
      description:
        "Charts on the Metrics tab run queries through the Query Data API (Pro and Enterprise plans).",
      requiredPermissions: [
        perm("Run Queries", "Run Queries"),
        perm("Manage Queries and Columns", "Manage Queries and Columns"),
      ],
    },
    flags: [["queries"], ["columns"]],
  },
  {
    capability: {
      id: "triggers",
      label: "Triggers",
      requiredPermissions: [perm("Manage Triggers", "Manage Triggers")],
    },
    flags: [["triggers"]],
  },
  {
    capability: {
      id: "slos",
      label: "SLOs and burn alerts",
      requiredPermissions: [perm("Manage SLOs", "Manage SLOs")],
    },
    flags: [["slos"]],
  },
  {
    capability: {
      id: "boards",
      label: "Boards",
      requiredPermissions: [perm("Manage Public Boards", "Manage Public Boards")],
    },
    flags: [["boards"]],
  },
  {
    capability: {
      id: "markers",
      label: "Markers",
      requiredPermissions: [perm("Manage Markers", "Manage Markers")],
    },
    flags: [["markers"]],
  },
  {
    capability: {
      id: "recipients",
      label: "Recipients",
      description: "Recipients are shared by the whole team.",
      requiredPermissions: [perm("Manage Recipients", "Manage Recipients")],
    },
    flags: [["recipients"]],
  },
];

const MANAGEMENT_CAPABILITIES: Array<{ capability: PreflightCapability; scopes: string[] }> = [
  {
    capability: {
      id: "environments",
      label: "Environments",
      description: "List, create, edit and delete environments, and connect them.",
      requiredPermissions: [
        perm("environments:read", "Environments: read"),
        perm("environments:write", "Environments: write"),
      ],
    },
    scopes: ["environments:read", "environments:write"],
  },
  {
    capability: {
      id: "api-keys",
      label: "API keys",
      description:
        "List, create, disable and delete ingest and configuration keys. Connect environment needs write.",
      requiredPermissions: [
        perm("api-keys:read", "API keys: read"),
        perm("api-keys:write", "API keys: write"),
      ],
    },
    scopes: ["api-keys:read", "api-keys:write"],
  },
];

export const HONEYCOMB_PREFLIGHT: PreflightDeclaration = {
  capabilities: [
    ...CONFIG_CAPABILITIES.map((c) => c.capability),
    ...MANAGEMENT_CAPABILITIES.map((c) => c.capability),
  ],
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function verifyHoneycombCredentials(
  ctx: HoneycombContext,
  configurationKey: string | undefined,
): Promise<PreflightResult> {
  const checks: PreflightCapabilityCheck[] = [];
  const identity: string[] = [];

  if (configurationKey) {
    try {
      const auth = await v1<HnyAuth>(ctx, configurationKey, "/1/auth");
      if (auth.type === "ingest") {
        for (const { capability } of CONFIG_CAPABILITIES) {
          checks.push({
            capabilityId: capability.id,
            status: "missing",
            missingPermissions: capability.requiredPermissions,
            message:
              "This is an ingest key, which can only send events. Use a configuration key from Environment Settings, API Keys.",
          });
        }
      } else {
        const access = auth.api_key_access ?? {};
        for (const { capability, flags } of CONFIG_CAPABILITIES) {
          const missing = flags
            .map((alternatives, i) => ({ ok: alternatives.some((f) => access[f] === true), i }))
            .filter((x) => !x.ok)
            .map((x) => capability.requiredPermissions[x.i])
            .filter((p): p is NonNullable<typeof p> => p !== undefined);
          checks.push(
            missing.length === 0
              ? { capabilityId: capability.id, status: "ok" }
              : { capabilityId: capability.id, status: "missing", missingPermissions: missing },
          );
        }
      }
      const env = auth.environment?.name || "Classic";
      identity.push(`${auth.team?.name ?? auth.team?.slug ?? "team"} / ${env}`);
    } catch (err) {
      const status = statusOf(err);
      for (const { capability } of CONFIG_CAPABILITIES) {
        checks.push(
          status === 401
            ? {
                capabilityId: capability.id,
                status: "missing",
                missingPermissions: capability.requiredPermissions,
                message: "Honeycomb rejected the configuration key. Check it and the region.",
              }
            : { capabilityId: capability.id, status: "unknown", message: message(err) },
        );
      }
    }
  } else {
    for (const { capability } of CONFIG_CAPABILITIES) {
      checks.push({
        capabilityId: capability.id,
        status: "unknown",
        message:
          "No configuration key on the account. Connect each environment to check its permissions.",
      });
    }
  }

  if (ctx.managementToken) {
    try {
      const auth = await v2<HnyAuthV2>(ctx, "/2/auth");
      const scopes = new Set(auth.data?.attributes?.scopes ?? []);
      for (const { capability, scopes: needed } of MANAGEMENT_CAPABILITIES) {
        const missing = capability.requiredPermissions.filter(
          (_, i) => !scopes.has(needed[i] ?? ""),
        );
        checks.push(
          missing.length === 0
            ? { capabilityId: capability.id, status: "ok" }
            : { capabilityId: capability.id, status: "missing", missingPermissions: missing },
        );
      }
      if (auth.data?.attributes?.name) identity.push(`management key ${auth.data.attributes.name}`);
    } catch (err) {
      const status = statusOf(err);
      for (const { capability } of MANAGEMENT_CAPABILITIES) {
        checks.push(
          status === 401
            ? {
                capabilityId: capability.id,
                status: "missing",
                missingPermissions: capability.requiredPermissions,
                message: "Honeycomb rejected the management key. Check its ID, secret and region.",
              }
            : { capabilityId: capability.id, status: "unknown", message: message(err) },
        );
      }
    }
  } else {
    for (const { capability } of MANAGEMENT_CAPABILITIES) {
      checks.push({
        capabilityId: capability.id,
        status: "missing",
        missingPermissions: capability.requiredPermissions,
        message:
          "Add a management key (Team Settings, API Keys) to manage environments and API keys.",
      });
    }
  }

  return { checks, ...(identity.length > 0 ? { identity: identity.join(", ") } : {}) };
}
