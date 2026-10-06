/**
 * Credential preflight for a Vultr API key.
 *
 * A key acts with its user's permissions: the account owner can do
 * everything, while a sub-user's key is limited by that user's ACLs
 * (`subscriptions_view`, `subscriptions`, `provisioning`, `billing`, `dns`,
 * `firewall`, `objstore`, `loadbalancer`, ...). There is no introspection
 * of what a key may write, so each capability is probed with one cheap list
 * call: 2xx is ok, 401/403 is missing, anything else unknown. Vultr also
 * answers 401 when the caller's IP is not on the key's Access Control list,
 * which is called out in the message because it is the usual cause.
 */

import type {
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import { type VultrApi, statusOf } from "./api.js";
import type { VultrAccount } from "./types.js";

interface Probe {
  capability: PreflightCapability;
  path: string;
}

const acl = (id: string, label: string) => ({ id, label });

const PROBES: Probe[] = [
  {
    capability: {
      id: "compute",
      label: "Instances, bare metal and Kubernetes",
      description: "List, create, resize, power and back up servers and VKE clusters.",
      requiredPermissions: [
        acl("subscriptions", "Manage Subscriptions"),
        acl("provisioning", "Provisioning"),
      ],
      essential: true,
    },
    path: "/instances",
  },
  {
    capability: {
      id: "storage",
      label: "Block storage, snapshots and backups",
      requiredPermissions: [acl("subscriptions", "Manage Subscriptions")],
    },
    path: "/blocks",
  },
  {
    capability: {
      id: "databases",
      label: "Managed Databases",
      requiredPermissions: [acl("subscriptions", "Manage Subscriptions")],
    },
    path: "/databases",
  },
  {
    capability: {
      id: "load-balancers",
      label: "Load balancers",
      requiredPermissions: [acl("loadbalancer", "Load Balancer")],
    },
    path: "/load-balancers",
  },
  {
    capability: {
      id: "firewall",
      label: "Firewall groups",
      requiredPermissions: [acl("firewall", "Firewall")],
    },
    path: "/firewalls",
  },
  {
    capability: {
      id: "dns",
      label: "DNS",
      requiredPermissions: [acl("dns", "DNS")],
    },
    path: "/domains",
  },
  {
    capability: {
      id: "object-storage",
      label: "Object Storage",
      requiredPermissions: [acl("objstore", "Object Storage")],
    },
    path: "/object-storage",
  },
  {
    capability: {
      id: "costs",
      label: "Costs, invoices and credit",
      description: "Invoices, month-to-date charges and the account balance.",
      requiredPermissions: [acl("billing", "Billing")],
    },
    path: "/billing/invoices",
  },
];

export const VULTR_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
};

const HELP = { label: "Manage API access", url: "https://my.vultr.com/settings/#settingsapi" };

export async function verifyVultrCredentials(api: VultrApi): Promise<PreflightResult> {
  let identity: string | undefined;
  try {
    const res = await api.get<{ account?: VultrAccount }>("/account");
    identity = res.account?.email || res.account?.name;
  } catch {
    identity = undefined;
  }
  const checks = await Promise.all(
    PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
      try {
        await api.get(p.path, { per_page: 1 });
        return { capabilityId: p.capability.id, status: "ok" };
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403) {
          const text = err instanceof Error ? err.message : "";
          return {
            capabilityId: p.capability.id,
            status: "missing",
            missingPermissions: p.capability.requiredPermissions,
            message: /ip/i.test(text)
              ? "Vultr refused the request from this IP address. Add Infrawrench's egress address (or your bastion's) to the key's Access Control list."
              : "The key's user lacks this permission. Grant it under Account, Users, or use the account owner's key.",
            helpLink: HELP,
          };
        }
        return {
          capabilityId: p.capability.id,
          status: "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return { checks, ...(identity ? { identity } : {}) };
}
