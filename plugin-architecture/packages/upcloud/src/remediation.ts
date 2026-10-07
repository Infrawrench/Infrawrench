import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for UpCloud savings findings, written for the official `upctl`
 * CLI (github.com/UpCloudLtd/upcloud-cli). Every command takes the UUID (or,
 * for an IP, the address) the listers store as the external id.
 *
 * - Sleep schedule: `server stop` / `server start`, `database stop` /
 *   `database start`.
 * - Stopped server: `server delete` without `--delete-storages`, so the disks
 *   survive as detached storages (their own findings, each with a backup step).
 * - Detached storage: `storage backup create`, then `storage delete --backups
 *   keep_latest` so that backup outlives the disk.
 * - Unassigned floating IP: `ip-address remove`.
 * - Load balancer with no backend members: `load-balancer delete`.
 *
 * Reference: the command definitions and examples in
 * https://github.com/UpCloudLtd/upcloud-cli/tree/main/internal/commands
 * (server/{start,stop,delete}.go, storage/delete.go, storage/backup/create.go,
 * ipaddress/remove.go, database/{start,stop}.go, loadbalancer/delete.go).
 */
export function upcloudRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const type = resource.resourceTypeId;

  if (finding.kind === "sleep-schedule") {
    const group = type === "server" ? "server" : type === "database" ? "database" : "";
    const id = remediationId(resource);
    if (!group || !id) return [];
    return [
      cmd(
        `upctl ${group} stop ${shellQuote(id)}`,
        group === "server"
          ? "Stop the server (soft shutdown). Its storage and IP addresses are still billed while stopped."
          : "Power off the managed database; its compute stops billing.",
      ),
      cmd(`upctl ${group} start ${shellQuote(id)}`, `Start the ${group} again.`),
    ];
  }

  switch (type) {
    case "server": {
      const id = remediationId(resource, "serverId");
      if (!id) return [];
      return [
        cmd(
          `upctl server delete ${shellQuote(id)}`,
          "Delete the stopped server. Its storages are kept, detached; back them up and delete them separately once nothing needs them.",
          true,
        ),
      ];
    }
    case "storage": {
      const id = remediationId(resource);
      if (!id) return [];
      const title = `${remediationField(resource, "title") || "storage"}-before-delete-${remediationDateStamp()}`;
      return [
        cmd(
          `upctl storage backup create ${shellQuote(id)} --title ${shellQuote(title)}`,
          "Back up the storage before deleting it.",
        ),
        cmd(
          `upctl storage delete ${shellQuote(id)} --backups keep_latest`,
          "Delete the detached storage, keeping its latest backup (backups are billed per GB until deleted).",
          true,
        ),
      ];
    }
    case "floating-ip": {
      const address = remediationField(resource, "address") || remediationId(resource);
      if (!address) return [];
      return [
        cmd(
          `upctl ip-address remove ${shellQuote(address)}`,
          "Release the unassigned floating IP; the address cannot be got back.",
          true,
        ),
      ];
    }
    case "load-balancer": {
      const id = remediationId(resource);
      if (!id) return [];
      return [
        cmd(
          `upctl load-balancer delete ${shellQuote(id)}`,
          "Delete the load balancer, which has no backend members to serve.",
          true,
        ),
      ];
    }
    default:
      return [];
  }
}

function cmd(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "upctl", command, description, destructive };
}
