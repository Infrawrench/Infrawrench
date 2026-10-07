import {
  remediationDateStamp,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `pspace` (Paperspace CLI) commands for savings findings. pspace
 * authenticates with `pspace login` (or `--api-key`), so no placeholders.
 * Machines are addressed by id, public IPs by the address itself.
 *
 * Deleting a machine also deletes its snapshots, so the backup step before a
 * delete is a custom template, which outlives the machine.
 *
 * References:
 * https://docs.digitalocean.com/reference/paperspace/pspace/commands/machine/
 * https://docs.digitalocean.com/reference/paperspace/pspace/commands/template/
 * https://docs.digitalocean.com/reference/paperspace/pspace/commands/public-ip/
 * https://docs.digitalocean.com/products/paperspace/machines/how-to/deactivate/
 */
export function paperspaceRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === "machine") {
    const id = remediationId(resource);
    if (!id) return [];
    const q = shellQuote(id);
    if (finding.kind === "sleep-schedule") {
      return [
        pspace(
          `pspace machine stop ${q}`,
          "Stop the machine; compute stops billing, its disk keeps billing.",
        ),
        pspace(`pspace machine start ${q}`, "Start the machine again."),
      ];
    }
    return [
      pspace(
        `pspace template create --name ${shellQuote(`${resource.displayName || id}-${remediationDateStamp()}`)} --machine-id ${q}`,
        "Save the machine's disk as a custom template (which bills its own storage); wait until it is ready before deleting.",
      ),
      pspace(
        `pspace machine delete ${q}`,
        "Delete the machine, its disk and its snapshots; only the template remains.",
        true,
      ),
    ];
  }

  if (resource.resourceTypeId === "public-ip" && finding.kind === "orphan") {
    const ip = remediationId(resource, "ip");
    if (!ip) return [];
    return [
      pspace(
        `pspace public-ip release ${shellQuote(ip)}`,
        "Release the unassigned static IP; the address cannot be got back.",
        true,
      ),
    ];
  }

  return [];
}

function pspace(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "pspace", command, description, destructive };
}
