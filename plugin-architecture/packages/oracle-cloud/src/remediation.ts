import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { parseSizeId } from "./listers.js";

/**
 * Ready-to-run `oci` CLI commands for savings findings. Every resource is
 * addressed by its OCID (the stored externalId) plus its region field; the
 * CLI profile is account-level, so it is a placeholder.
 *
 * Reference: https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/
 */
const PROFILE: RemediationPlaceholder = {
  name: "OCI_CLI_PROFILE",
  description: "OCI CLI config profile (in ~/.oci/config) for this tenancy",
};

export function ociRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id) return [];
  const region = finding.kind === "oversized" ? finding.region || "" : "";
  const scope = scopeFlags(resource, region);
  const cmd = (command: string, description: string, destructive = false): RemediationCommand => ({
    tool: "oci",
    command: `${command} ${scope}`,
    description,
    destructive,
    placeholders: [PROFILE],
  });

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "instance" || !finding.targetSize) return [];
    const { shape, ocpus, memoryGb } = parseSizeId(finding.targetSize);
    if (!shape) return [];
    const shapeConfig =
      ocpus !== undefined && memoryGb !== undefined && Number.isFinite(ocpus + memoryGb)
        ? ` --shape-config ${shellQuote(JSON.stringify({ ocpus, memoryInGBs: memoryGb }))}`
        : "";
    // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/update.html
    // OCI reboots a running instance to apply the shape; a stopped one stays stopped.
    return [
      cmd(
        `oci compute instance update --instance-id ${shellQuote(id)} --shape ${shellQuote(shape)}${shapeConfig} --force`,
        `Change the instance to ${finding.targetSize}; OCI reboots a running instance to apply it, which causes downtime.`,
      ),
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId === "instance") {
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/action.html
      return [
        cmd(
          `oci compute instance action --instance-id ${shellQuote(id)} --action SOFTSTOP --wait-for-state STOPPED`,
          "Gracefully stop the instance (standard shapes stop billing for compute; volumes keep billing).",
        ),
        cmd(
          `oci compute instance action --instance-id ${shellQuote(id)} --action START --wait-for-state RUNNING`,
          "Start the instance again.",
        ),
      ];
    }
    if (resource.resourceTypeId === "autonomous-database") {
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/db/autonomous-database/stop.html
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/db/autonomous-database/start.html
      return [
        cmd(
          `oci db autonomous-database stop --autonomous-database-id ${shellQuote(id)} --wait-for-state STOPPED`,
          "Stop the database, which pauses compute billing (storage keeps billing).",
        ),
        cmd(
          `oci db autonomous-database start --autonomous-database-id ${shellQuote(id)} --wait-for-state AVAILABLE`,
          "Start the database again.",
        ),
      ];
    }
    return [];
  }

  // orphan
  const backupName = shellQuote(preDeleteName(resource));
  switch (resource.resourceTypeId) {
    case "instance": {
      const bootVolumeId = remediationField(resource, "bootVolumeId");
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/bv/boot-volume-backup/create.html
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/terminate.html
      const backup = bootVolumeId
        ? [
            cmd(
              `oci bv boot-volume-backup create --boot-volume-id ${shellQuote(bootVolumeId)} --display-name ${backupName} --type FULL --wait-for-state AVAILABLE`,
              "Back up the boot volume so the instance can be recreated from it later.",
            ),
          ]
        : [];
      return [
        ...backup,
        cmd(
          `oci compute instance terminate --instance-id ${shellQuote(id)} --preserve-boot-volume false --force`,
          "Terminate the stopped instance and delete its boot volume (data volumes created at launch are kept).",
          true,
        ),
      ];
    }
    case "boot-volume":
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/bv/boot-volume-backup/create.html
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/bv/boot-volume/delete.html
      return [
        cmd(
          `oci bv boot-volume-backup create --boot-volume-id ${shellQuote(id)} --display-name ${backupName} --type FULL --wait-for-state AVAILABLE`,
          "Back up the boot volume so it can be restored later.",
        ),
        cmd(
          `oci bv boot-volume delete --boot-volume-id ${shellQuote(id)} --force`,
          "Delete the detached boot volume and all of its data.",
          true,
        ),
      ];
    case "block-volume":
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/bv/backup/create.html
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/bv/volume/delete.html
      return [
        cmd(
          `oci bv backup create --volume-id ${shellQuote(id)} --display-name ${backupName} --type FULL --wait-for-state AVAILABLE`,
          "Back up the volume so it can be restored later.",
        ),
        cmd(
          `oci bv volume delete --volume-id ${shellQuote(id)} --force`,
          "Delete the unattached volume and all of its data.",
          true,
        ),
      ];
    case "reserved-ip":
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/network/public-ip/delete.html
      return [
        cmd(
          `oci network public-ip delete --public-ip-id ${shellQuote(id)} --force`,
          "Release the unassigned reserved public IP back to OCI's pool; the address cannot be got back.",
          true,
        ),
      ];
    case "load-balancer":
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/lb/load-balancer/delete.html
      return [
        cmd(
          `oci lb load-balancer delete --load-balancer-id ${shellQuote(id)} --force`,
          "Delete the load balancer that has no backend sets.",
          true,
        ),
      ];
    case "autonomous-database":
      // https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/db/autonomous-database/delete.html
      // No pre-delete backup: Autonomous Database backups, long-term ones
      // included, only live as long as the database itself.
      return [
        cmd(
          `oci db autonomous-database delete --autonomous-database-id ${shellQuote(id)} --force`,
          "Terminate the stopped database; its backups go with it, so export any data you need first.",
          true,
        ),
      ];
    default:
      return [];
  }
}

/** `--region` (from the row) and the profile placeholder. */
function scopeFlags(resource: RemediationResource, fallbackRegion: string): string {
  const region = remediationField(resource, "region") || fallbackRegion;
  const regionFlag = region ? `--region ${shellQuote(region)} ` : "";
  return `${regionFlag}--profile "$OCI_CLI_PROFILE"`;
}

function preDeleteName(resource: RemediationResource): string {
  const base = remediationField(resource, "name") || resource.displayName || "backup";
  return `${base}-pre-delete-${remediationDateStamp()}`;
}
