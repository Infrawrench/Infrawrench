import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { CT, POOL, VM } from "./resources.js";

/**
 * Ready-to-run commands for Proxmox VE savings findings, run in a shell on any
 * node of the cluster (as root, or a user with the matching privileges).
 *
 * - Sleep schedule (VMs and containers): `pvesh create` against the guest's
 *   `status/shutdown` and `status/start` API paths. pvesh proxies to the node
 *   the guest lives on, so unlike `qm` / `pct` it works from any node.
 * - Orphan (an empty pool): `pveum pool delete`.
 *
 * References:
 * https://pve.proxmox.com/pve-docs/pvesh.1.html
 * https://pve.proxmox.com/pve-docs/pveum.1.html
 * https://pve.proxmox.com/pve-docs/api-viewer/ (POST /nodes/{node}/{qemu,lxc}/{vmid}/status/{start,shutdown})
 */
export function proxmoxRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "sleep-schedule") {
    const { resource } = finding;
    const kind =
      resource.resourceTypeId === VM ? "qemu" : resource.resourceTypeId === CT ? "lxc" : "";
    if (!kind) return [];
    const node = remediationField(resource, "node");
    const vmid = remediationField(resource, "vmid") || (resource.externalId ?? "").trim();
    if (!node || !/^\d+$/.test(vmid)) return [];
    const path = `/nodes/${node}/${kind}/${vmid}/status`;
    const what = kind === "qemu" ? "VM" : "container";
    return [
      {
        tool: "pvesh",
        command: `pvesh create ${shellQuote(`${path}/shutdown`)}`,
        description: `Cleanly shut the ${what} down (ACPI${kind === "qemu" ? " or the guest agent" : ""}); its CPU and memory return to the node.`,
        destructive: false,
      },
      {
        tool: "pvesh",
        command: `pvesh create ${shellQuote(`${path}/start`)}`,
        description: `Start the ${what} again.`,
        destructive: false,
      },
    ];
  }

  if (finding.kind === "orphan" && finding.resource.resourceTypeId === POOL) {
    const poolid = remediationId(finding.resource, "poolid");
    if (!poolid) return [];
    return [
      {
        tool: "pveum",
        command: `pveum pool delete ${shellQuote(poolid)}`,
        description: "Delete the empty pool; any permissions granted on /pool/<id> go with it.",
        destructive: true,
      },
    ];
  }

  return [];
}
