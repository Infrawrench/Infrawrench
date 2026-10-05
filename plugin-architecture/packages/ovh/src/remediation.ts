import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run commands for the official OVHcloud CLI (`ovhcloud`,
 * https://github.com/ovh/ovhcloud-cli). The Public Cloud project id is a
 * credential, not a field on the synced row, so it is passed as a variable.
 */
const PROJECT: RemediationPlaceholder = {
  name: "OVH_CLOUD_PROJECT",
  description: "OVHcloud Public Cloud project ID (service name) for this account",
};
const PROJECT_FLAG = `--cloud-project "$OVH_CLOUD_PROJECT"`;

export function ovhRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id) return [];

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    // https://github.com/ovh/ovhcloud-cli/blob/main/doc/ovhcloud_cloud_instance_stop.md
    // https://github.com/ovh/ovhcloud-cli/blob/main/doc/ovhcloud_cloud_instance_start.md
    return [
      {
        tool: "ovhcloud",
        command: `ovhcloud cloud instance stop ${shellQuote(id)} ${PROJECT_FLAG}`,
        description:
          "Stop the instance (OVHcloud keeps billing a stopped instance at the full rate; only shelving stops the compute charge).",
        destructive: false,
        placeholders: [PROJECT],
      },
      {
        tool: "ovhcloud",
        command: `ovhcloud cloud instance start ${shellQuote(id)} ${PROJECT_FLAG}`,
        description: "Start the instance again.",
        destructive: false,
        placeholders: [PROJECT],
      },
    ];
  }

  // orphan
  if (resource.resourceTypeId !== "volume") return [];
  const base = remediationField(resource, "name") || resource.displayName || id;
  const snapshot = `${base}-pre-delete-${remediationDateStamp()}`;
  // https://github.com/ovh/ovhcloud-cli/blob/main/doc/ovhcloud_cloud_storage_block_snapshot_create.md
  // https://github.com/ovh/ovhcloud-cli/blob/main/doc/ovhcloud_cloud_storage_block_volume_delete.md
  return [
    {
      tool: "ovhcloud",
      command: `ovhcloud cloud storage block snapshot create ${shellQuote(id)} --name ${shellQuote(snapshot)} --wait ${PROJECT_FLAG}`,
      description: "Snapshot the volume so its data can be restored later.",
      destructive: false,
      placeholders: [PROJECT],
    },
    {
      tool: "ovhcloud",
      command: `ovhcloud cloud storage block volume delete ${shellQuote(id)} ${PROJECT_FLAG}`,
      description: "Delete the unattached volume and all of its data.",
      destructive: true,
      placeholders: [PROJECT],
    },
  ];
}
