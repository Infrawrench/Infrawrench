/**
 * Credential preflight from `GET /access/permissions`, which any user or
 * token may call for itself: it returns `{ "<acl path>": { "<privilege>": 0|1 } }`
 * with the token's effective privileges (already intersected with its user's
 * when privilege separation is on).
 */
import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { ProxmoxApi } from "./api.js";

const p = (id: string, label: string) => ({ id, label });

export const PREFLIGHT_CAPABILITIES: PreflightCapability[] = [
  {
    id: "resources",
    label: "Inventory",
    description:
      "List nodes, guests, storage, pools, backups and the cluster's HA and firewall configuration",
    essential: true,
    requiredPermissions: [
      p("Sys.Audit", "Read node status, cluster, HA, firewall and backup job settings"),
      p("VM.Audit", "Read VM and container configuration"),
      p("Datastore.Audit", "Read storage and its content"),
      p("Pool.Audit", "Read resource pools"),
    ],
  },
  {
    id: "power",
    label: "Power actions",
    description: "Start, shut down, reboot, stop, suspend and resume guests",
    requiredPermissions: [p("VM.PowerMgmt", "Change guest power state")],
  },
  {
    id: "addresses",
    label: "Guest IP addresses",
    description: "Read VM addresses from the QEMU guest agent for SSH",
    requiredPermissions: [
      p(
        "VM.GuestAgent.Audit",
        "Run read-only guest agent commands (Proxmox VE 9; VM.Monitor on 8.x)",
      ),
    ],
  },
  {
    id: "create",
    label: "Create and edit guests",
    description: "Create VMs and containers, clone templates, edit CPU, memory and options",
    requiredPermissions: [
      p("VM.Allocate", "Create and remove guests"),
      p("VM.Clone", "Clone guests and templates"),
      p("VM.Config.CPU", "Change CPU settings"),
      p("VM.Config.Memory", "Change memory"),
      p("VM.Config.Disk", "Add and resize disks"),
      p("VM.Config.Network", "Configure network devices"),
      p("VM.Config.Options", "Change name, tags, notes and boot options"),
      p("VM.Config.CDROM", "Attach installation ISOs"),
      p("VM.Config.Cloudinit", "Set cloud-init user, keys and addresses"),
      p("Datastore.AllocateSpace", "Allocate disk space on storage"),
      p("SDN.Use", "Attach guests to bridges and VNets"),
    ],
  },
  {
    id: "snapshots",
    label: "Snapshots",
    requiredPermissions: [
      p("VM.Snapshot", "Take and delete snapshots"),
      p("VM.Snapshot.Rollback", "Roll back to snapshots"),
    ],
  },
  {
    id: "backups",
    label: "Backups and backup jobs",
    requiredPermissions: [
      p("VM.Backup", "Back up and restore guests"),
      p("Datastore.AllocateSpace", "Write backups to storage"),
      p("Sys.Modify", "Create and edit scheduled backup jobs"),
    ],
  },
  {
    id: "migrate",
    label: "Migration",
    requiredPermissions: [p("VM.Migrate", "Move guests between nodes")],
  },
  {
    id: "ha",
    label: "High availability",
    requiredPermissions: [p("Sys.Console", "Create and change HA resources and rules")],
  },
  {
    id: "firewall",
    label: "Firewall",
    requiredPermissions: [
      p("Sys.Modify", "Edit datacenter firewall rules, groups, aliases and IP sets"),
    ],
  },
  {
    id: "pools",
    label: "Pools",
    requiredPermissions: [p("Pool.Allocate", "Create, edit and remove pools")],
  },
  {
    id: "logs",
    label: "Node logs",
    requiredPermissions: [p("Sys.Syslog", "Read the node journal")],
  },
  {
    id: "downloads",
    label: "Download ISOs and templates",
    requiredPermissions: [
      p("Datastore.AllocateTemplate", "Store ISOs and container templates"),
      p("Sys.AccessNetwork", "Let the node fetch a URL (Proxmox VE 9; Sys.Modify on 8.x)"),
    ],
  },
];

export const PREFLIGHT: PreflightDeclaration = {
  capabilities: PREFLIGHT_CAPABILITIES,
  templateFormat: { label: "pveum commands", language: "text" },
};

/** Privileges the token holds on `/` or on any path (a broad, honest approximation). */
export function heldPrivileges(perms: Record<string, Record<string, number | boolean>>): {
  root: Set<string>;
  anywhere: Set<string>;
} {
  const root = new Set<string>();
  const anywhere = new Set<string>();
  for (const [path, privs] of Object.entries(perms ?? {})) {
    for (const priv of Object.keys(privs ?? {})) {
      anywhere.add(priv);
      if (path === "/") root.add(priv);
    }
  }
  return { root, anywhere };
}

export async function proxmoxVerifyCredentials(api: ProxmoxApi): Promise<PreflightResult> {
  let perms: Record<string, Record<string, number | boolean>>;
  try {
    perms =
      (await api.get<Record<string, Record<string, number | boolean>>>("/access/permissions")) ??
      {};
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      checks: PREFLIGHT_CAPABILITIES.map((c) => ({
        capabilityId: c.id,
        status: "unknown" as const,
        message,
      })),
    };
  }
  const { root, anywhere } = heldPrivileges(perms);
  const checks: PreflightCapabilityCheck[] = PREFLIGHT_CAPABILITIES.map((cap) => {
    const missing = cap.requiredPermissions.filter((perm) => {
      // Accept a PVE 8 privilege that the PVE 9 one replaced.
      if (
        perm.id === "VM.GuestAgent.Audit" &&
        (anywhere.has("VM.Monitor") || anywhere.has("VM.GuestAgent.Unrestricted"))
      ) {
        return false;
      }
      if (perm.id === "Sys.AccessNetwork" && root.has("Sys.Modify")) return false;
      return !anywhere.has(perm.id);
    });
    if (missing.length === 0) return { capabilityId: cap.id, status: "ok" as const };
    return {
      capabilityId: cap.id,
      status: "missing" as const,
      missingPermissions: missing,
      message:
        "Grant a role with these privileges to the API token (and its user, when privilege separation is on).",
    };
  });
  const partial = Object.keys(perms).some((k) => k !== "/") && root.size === 0;
  return {
    checks,
    ...(partial ? { identity: "Token has privileges on specific paths only" } : {}),
  };
}

export function proxmoxPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = new Set(
    capabilityIds.length ? capabilityIds : PREFLIGHT_CAPABILITIES.map((c) => c.id),
  );
  const privs = new Set<string>();
  for (const cap of PREFLIGHT_CAPABILITIES) {
    if (!wanted.has(cap.id)) continue;
    for (const perm of cap.requiredPermissions) privs.add(perm.id);
  }
  const list = [...privs].sort().join(",");
  const document = [
    "# Run on any Proxmox VE node as root.",
    `pveum role add Infrawrench --privs "${list}"`,
    'pveum user add infrawrench@pve --comment "Infrawrench"',
    "pveum acl modify / --users infrawrench@pve --roles Infrawrench",
    "pveum user token add infrawrench@pve infrawrench --privsep 1",
    "pveum acl modify / --tokens 'infrawrench@pve!infrawrench' --roles Infrawrench",
    "# Token ID: infrawrench@pve!infrawrench   Secret: the 'value' printed by 'token add'.",
    "# On Proxmox VE 8.x replace VM.GuestAgent.Audit with VM.Monitor and drop Sys.AccessNetwork.",
  ].join("\n");
  return {
    formatLabel: "pveum commands",
    language: "text",
    document,
    instructions:
      "Run these in a root shell on a Proxmox VE node (Datacenter, node, Shell). They create a role, a user and a privilege-separated API token holding only what you selected.",
    helpLink: {
      label: "Proxmox VE user management",
      url: "https://pve.proxmox.com/pve-docs/chapter-pveum.html",
    },
  };
}
