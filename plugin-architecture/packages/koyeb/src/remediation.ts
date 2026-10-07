import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Koyeb savings findings, written for the official `koyeb`
 * CLI (github.com/koyeb/koyeb-cli). Apps, services and volumes are addressed
 * by their UUID, which every resolver in the CLI accepts as-is.
 *
 * - Sleep schedule: `apps pause` / `apps resume` for an app, `services pause`
 *   / `services resume` for one service.
 * - Detached volume: `snapshots create NAME PARENT_VOLUME`, then
 *   `volumes delete`.
 *
 * Reference: https://github.com/koyeb/koyeb-cli/blob/master/docs/reference.md
 * (apps pause/resume, services pause/resume, volumes delete) and
 * pkg/koyeb/snapshots.go for `snapshots create`, which the reference page
 * does not list yet.
 */
export function koyebRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id) return [];

  if (finding.kind === "sleep-schedule") {
    const group =
      resource.resourceTypeId === "app"
        ? "apps"
        : resource.resourceTypeId === "service"
          ? "services"
          : "";
    if (!group) return [];
    const what = group === "apps" ? "every service in the app" : "the service";
    return [
      cmd(
        `koyeb ${group} pause ${shellQuote(id)}`,
        `Pause ${what}; paused instances stop billing.`,
      ),
      cmd(`koyeb ${group} resume ${shellQuote(id)}`, `Resume ${what}.`),
    ];
  }

  if (finding.kind === "orphan" && resource.resourceTypeId === "volume") {
    const snapshot = `${remediationField(resource, "name") || "volume"}-before-delete-${remediationDateStamp()}`;
    return [
      cmd(
        `koyeb snapshots create ${shellQuote(snapshot)} ${shellQuote(id)}`,
        "Snapshot the volume before deleting it (snapshots are billed per GB until deleted).",
      ),
      cmd(
        `koyeb volumes delete ${shellQuote(id)}`,
        "Delete the detached volume and its data.",
        true,
      ),
    ];
  }

  return [];
}

function cmd(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "koyeb", command, description, destructive };
}
