import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { VM } from "./resources.js";

/**
 * Ready-to-run `govc` commands for vSphere savings findings. The only finding
 * is a sleep schedule on virtual machines (the `lifecycle` declaration), so
 * this is guest shutdown and power on. govc reads the vCenter address and
 * login from `GOVC_URL`, `GOVC_USERNAME` and `GOVC_PASSWORD`.
 *
 * The VM is addressed by its managed object reference (`VirtualMachine:vm-42`)
 * rather than by name: names are not unique across folders, and govc's finder
 * resolves a `Type:moid` argument directly.
 *
 * References:
 * https://github.com/vmware/govmomi/blob/main/govc/USAGE.md#vmpower
 * https://github.com/vmware/govmomi/blob/main/find/finder.go (ReferenceFromString)
 */
export function vsphereRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== VM) return [];
  const moid = remediationId(resource);
  if (!moid) return [];
  const ref = shellQuote(`VirtualMachine:${moid}`);
  return [
    {
      tool: "govc",
      command: `govc vm.power -s ${ref}`,
      description:
        "Shut the guest OS down through VMware Tools (the same guest shutdown the schedule uses); the VM then powers off.",
      destructive: false,
    },
    {
      tool: "govc",
      command: `govc vm.power -on ${ref}`,
      description: "Power the VM back on.",
      destructive: false,
    },
  ];
}
