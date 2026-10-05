/**
 * Credential preflight for a Linode personal access token.
 *
 * A token carries per-area scopes, each `read_only` or `read_write`
 * (techdocs "Get started", OAuth scopes list: `account`, `databases`,
 * `domains`, `events`, `firewall`, `images`, `ips`, `linodes`, `lke`,
 * `nodebalancers`, `object_storage`, `stackscripts`, `volumes`, `vpc`,
 * `monitor`). There is no token introspection endpoint, so each capability
 * is probed with one cheap list call: 2xx is ok, 401/403 is missing, anything
 * else unknown. The template is the scope list to tick when creating the
 * token in Cloud Manager.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { type LinodeApi, statusOf } from "./api.js";

interface Probe {
  capability: PreflightCapability;
  path: string;
}

const scope = (id: string, label: string) => ({ id, label });

const PROBES: Probe[] = [
  {
    capability: {
      id: "costs",
      label: "Costs, invoices and credits",
      description:
        "Invoices and their line items, the uninvoiced balance, promotions and the transfer pool.",
      requiredPermissions: [scope("account:read_only", "Account: Read Only")],
    },
    path: "/account/invoices",
  },
  {
    capability: {
      id: "linodes",
      label: "Linodes",
      description: "List, create, resize, power and back up Linodes, and read their statistics.",
      requiredPermissions: [scope("linodes:read_write", "Linodes: Read/Write")],
    },
    path: "/linode/instances",
  },
  {
    capability: {
      id: "volumes",
      label: "Block Storage",
      requiredPermissions: [scope("volumes:read_write", "Volumes: Read/Write")],
    },
    path: "/volumes",
  },
  {
    capability: {
      id: "nodebalancers",
      label: "NodeBalancers",
      requiredPermissions: [scope("nodebalancers:read_write", "NodeBalancers: Read/Write")],
    },
    path: "/nodebalancers",
  },
  {
    capability: {
      id: "lke",
      label: "Kubernetes (LKE)",
      description: "Clusters, node pools and kubeconfigs (reading a kubeconfig needs read/write).",
      requiredPermissions: [scope("lke:read_write", "Kubernetes: Read/Write")],
    },
    path: "/lke/clusters",
  },
  {
    capability: {
      id: "object-storage",
      label: "Object Storage",
      requiredPermissions: [scope("object_storage:read_write", "Object Storage: Read/Write")],
    },
    path: "/object-storage/buckets",
  },
  {
    capability: {
      id: "databases",
      label: "Managed Databases",
      requiredPermissions: [scope("databases:read_write", "Databases: Read/Write")],
    },
    path: "/databases/instances",
  },
  {
    capability: {
      id: "firewalls",
      label: "Cloud Firewalls",
      requiredPermissions: [scope("firewall:read_write", "Firewalls: Read/Write")],
    },
    path: "/networking/firewalls",
  },
  {
    capability: {
      id: "domains",
      label: "DNS Manager",
      requiredPermissions: [scope("domains:read_write", "Domains: Read/Write")],
    },
    path: "/domains",
  },
  {
    capability: {
      id: "vpcs",
      label: "VPCs",
      requiredPermissions: [scope("vpc:read_write", "VPCs: Read/Write")],
    },
    path: "/vpcs",
  },
  {
    capability: {
      id: "ips",
      label: "Reserved IPs",
      requiredPermissions: [scope("ips:read_write", "IPs: Read/Write")],
    },
    path: "/networking/reserved/ips",
  },
  {
    capability: {
      id: "images",
      label: "Images and StackScripts",
      requiredPermissions: [
        scope("images:read_write", "Images: Read/Write"),
        scope("stackscripts:read_write", "StackScripts: Read/Write"),
      ],
    },
    path: "/images",
  },
  {
    capability: {
      id: "monitor",
      label: "Database metrics",
      description: "Akamai Cloud Pulse metrics for Managed Databases.",
      requiredPermissions: [scope("monitor:read_only", "Monitor: Read Only")],
    },
    path: "/monitor/services",
  },
];

export const LINODE_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "Token scopes", language: "text" },
};

const TOKENS_HELP = {
  label: "Manage access tokens",
  url: "https://cloud.linode.com/profile/tokens",
};

export async function verifyLinodeCredentials(api: LinodeApi): Promise<PreflightResult> {
  let identity: string | undefined;
  try {
    const profile = await api.get<{ username?: string; email?: string }>("/profile");
    identity = profile.username || profile.email || undefined;
  } catch (err) {
    if (statusOf(err) === 401) {
      return {
        checks: PROBES.map((p) => ({
          capabilityId: p.capability.id,
          status: "unknown" as const,
          message:
            "Linode rejected the token. Check that it was copied whole and has not expired or been revoked.",
        })),
      };
    }
  }
  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<PreflightCapabilityCheck> => {
      try {
        await api.get(probe.path, { query: { page_size: 25 } });
        return { capabilityId: probe.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
          return {
            capabilityId: probe.capability.id,
            status: "missing",
            missingPermissions: probe.capability.requiredPermissions,
            message: "The token does not have this scope.",
            helpLink: TOKENS_HELP,
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

export function linodePolicyTemplate(capabilityIds: string[]): PolicyTemplate {
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
      "In Cloud Manager open your profile, then API Tokens, and create a personal access token. Set each listed area to the access shown and leave the rest at No Access. Choose Read Only everywhere for a read-only account.",
    helpLink: TOKENS_HELP,
  };
}
