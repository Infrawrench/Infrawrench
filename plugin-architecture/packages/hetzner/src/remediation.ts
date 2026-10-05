import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `hcloud` commands for savings findings. hcloud reads its token
 * from its own active context (`hcloud context create`), and every command
 * below waits for its action to finish by default.
 *
 * Reference: https://github.com/hetznercloud/cli/tree/main/docs/reference/manual
 */
export function hetznerRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "server") return [];
    const id = remediationId(resource);
    if (!id || !finding.targetSize) return [];
    // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_shutdown.md
    // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_change-type.md
    // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_poweron.md
    // --keep-disk leaves the disk at its current size, which is what makes a
    // downgrade possible and the change reversible.
    return [
      {
        tool: "hcloud",
        command: `hcloud server shutdown --wait --wait-timeout 5m ${shellQuote(id)}`,
        description:
          "Gracefully shut the server down; Hetzner requires it powered off to change type, which causes downtime.",
        destructive: false,
      },
      {
        tool: "hcloud",
        command: `hcloud server change-type --keep-disk ${shellQuote(id)} ${shellQuote(finding.targetSize)}`,
        description: `Change the server type to ${finding.targetSize}, keeping the current disk so the change can be reverted.`,
        destructive: false,
      },
      {
        tool: "hcloud",
        command: `hcloud server poweron ${shellQuote(id)}`,
        description: "Power the server back on.",
        destructive: false,
      },
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "server") return [];
    const id = remediationId(resource);
    if (!id) return [];
    // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_poweroff.md
    // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_server_poweron.md
    return [
      {
        tool: "hcloud",
        command: `hcloud server poweroff ${shellQuote(id)}`,
        description:
          "Power the server off (Hetzner keeps billing a powered-off server; only deleting it stops charges).",
        destructive: false,
      },
      {
        tool: "hcloud",
        command: `hcloud server poweron ${shellQuote(id)}`,
        description: "Power the server back on.",
        destructive: false,
      },
    ];
  }

  // orphan
  const id = remediationId(resource);
  if (!id) return [];
  switch (resource.resourceTypeId) {
    case "volume":
      // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_volume_delete.md
      // Hetzner Cloud volumes have no snapshot or backup feature, so there is
      // no restore point to take first.
      return [
        {
          tool: "hcloud",
          command: `hcloud volume delete ${shellQuote(id)}`,
          description:
            "Delete the detached volume and all of its data; Hetzner volumes cannot be snapshotted, so copy anything you need first.",
          destructive: true,
        },
      ];
    case "floating-ip":
      // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_floating-ip_delete.md
      return [
        {
          tool: "hcloud",
          command: `hcloud floating-ip delete ${shellQuote(id)}`,
          description: "Release the unassigned floating IP; the address cannot be got back.",
          destructive: true,
        },
      ];
    case "primary-ip":
      // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_primary-ip_delete.md
      return [
        {
          tool: "hcloud",
          command: `hcloud primary-ip delete ${shellQuote(id)}`,
          description: "Release the unassigned primary IP; the address cannot be got back.",
          destructive: true,
        },
      ];
    case "certificate":
      // https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_certificate_delete.md
      return [
        {
          tool: "hcloud",
          command: `hcloud certificate delete ${shellQuote(id)}`,
          description: "Delete the certificate that no load balancer uses.",
          destructive: true,
        },
      ];
    default:
      return [];
  }
}
