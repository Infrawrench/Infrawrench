import {
  remediationDateStamp,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `vultr-cli` commands for savings findings. vultr-cli reads its
 * key from `VULTR_API_KEY` or its config file, and none of the commands below
 * prompts for confirmation.
 *
 * Vultr bills a stopped instance or bare metal server at the full plan rate,
 * so a sleep schedule saves nothing there; the stop/start pair is still what
 * the schedule runs, and the descriptions say so.
 *
 * References (verified 2026-10 against the command definitions in
 * https://github.com/vultr/vultr-cli/tree/master/cmd):
 * instance start|stop|delete, bare-metal start|halt, snapshot create --id,
 * block-storage delete, load-balancer delete, firewall group delete,
 * reserved-ip delete.
 */
export function vultrRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id) return [];
  const q = shellQuote(id);

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId === "instance") {
      return [
        cmd(
          `vultr-cli instance stop ${q}`,
          "Stop the instance (Vultr keeps billing a stopped instance; only deleting it stops charges).",
        ),
        cmd(`vultr-cli instance start ${q}`, "Start the instance again."),
      ];
    }
    if (resource.resourceTypeId === "bare-metal") {
      return [
        cmd(
          `vultr-cli bare-metal halt ${q}`,
          "Halt the server (Vultr keeps billing a halted bare metal server; only deleting it stops charges).",
        ),
        cmd(`vultr-cli bare-metal start ${q}`, "Start the server again."),
      ];
    }
    return [];
  }

  switch (resource.resourceTypeId) {
    case "instance":
      return [
        cmd(
          `vultr-cli snapshot create --id ${q} --description ${shellQuote(`infrawrench-${id}-${remediationDateStamp()}`)}`,
          "Snapshot the instance first so it can be redeployed later; snapshots bill per GB.",
        ),
        cmd(
          `vultr-cli instance delete ${q}`,
          "Delete the stopped instance and its disk; billing stops.",
          true,
        ),
      ];
    case "block-storage":
      return [
        cmd(
          `vultr-cli block-storage delete ${q}`,
          "Delete the detached volume and all of its data; Vultr block storage has no snapshots, so copy anything you need first.",
          true,
        ),
      ];
    case "load-balancer":
      return [
        cmd(
          `vultr-cli load-balancer delete ${q}`,
          "Delete the load balancer with no backends; its IP addresses are released.",
          true,
        ),
      ];
    case "firewall-group":
      return [
        cmd(
          `vultr-cli firewall group delete ${q}`,
          "Delete the unused firewall group and its rules.",
          true,
        ),
      ];
    case "reserved-ip":
      return [
        cmd(
          `vultr-cli reserved-ip delete ${q}`,
          "Release the unattached reserved IP; the address cannot be got back.",
          true,
        ),
      ];
    default:
      return [];
  }
}

function cmd(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "vultr-cli", command, description, destructive };
}
