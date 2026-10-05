import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `crusoe` CLI commands for savings findings. The CLI reads its
 * keys from its own config (`~/.crusoe/config`) and addresses VMs and disks by
 * name within a project, so every command carries `--project-id` from the row.
 *
 * Reference: https://docs.crusoecloud.com/reference/cli/
 *
 * Not covered, because the CLI has no command for them:
 * - disk snapshots (no `crusoe storage snapshots` command), so deletes are
 *   not preceded by a backup step;
 * - idle reservations: `crusoe reservations` has no subcommands, and Crusoe
 *   reservations are fixed contracts with no exchange or cancel operation.
 */
export function crusoeRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const target = namedTarget(resource);
  if (!target) return [];
  const name = shellQuote(target.name);
  const project = `--project-id ${shellQuote(target.projectId)}`;

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "vm") return [];
    // https://docs.crusoecloud.com/reference/cli/crusoe_compute_vms_stop
    // https://docs.crusoecloud.com/reference/cli/crusoe_compute_vms_start
    return [
      {
        tool: "crusoe",
        command: `crusoe compute vms stop ${name} ${project} --yes`,
        description: "Stop the VM, which stops compute billing (its disks keep billing).",
        destructive: false,
      },
      {
        tool: "crusoe",
        command: `crusoe compute vms start ${name} ${project}`,
        description: "Start the VM again.",
        destructive: false,
      },
    ];
  }

  // orphan
  switch (resource.resourceTypeId) {
    case "vm":
      // https://docs.crusoecloud.com/reference/cli/crusoe_compute_vms_delete
      return [
        {
          tool: "crusoe",
          command: `crusoe compute vms delete ${name} ${project} --yes`,
          description:
            "Delete the stopped VM; the CLI cannot snapshot disks, so take any snapshot you need in the console first.",
          destructive: true,
        },
      ];
    case "disk":
      // https://docs.crusoecloud.com/reference/cli/crusoe_storage_disks_delete
      return [
        {
          tool: "crusoe",
          command: `crusoe storage disks delete ${name} ${project}`,
          description:
            "Delete the detached disk and all of its data; the CLI cannot snapshot it, so take any snapshot you need in the console first.",
          destructive: true,
        },
      ];
    default:
      return [];
  }
}

/** Name plus project; the project comes from the field or the `<projectId>/<id>` externalId. */
function namedTarget(resource: RemediationResource): { name: string; projectId: string } | null {
  const name = remediationField(resource, "name");
  const ext = (resource.externalId ?? "").trim();
  const projectId =
    remediationField(resource, "projectId") || (ext.includes("/") ? ext.split("/")[0]! : "");
  if (!name || !projectId) return null;
  return { name, projectId };
}
