import {
  remediationDateStamp,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { FLOATING_IP, SERVER, VOLUME } from "./resources.js";

/**
 * Ready-to-run `openstack` (python-openstackclient) commands for savings
 * findings. The client picks its cloud from `OS_CLOUD` (clouds.yaml) or the
 * `OS_*` variables of an openrc file.
 *
 * - Sleep schedule (servers): `server stop` / `server start`, the same Nova
 *   actions the schedule calls. Many clouds keep billing a SHUTOFF server for
 *   its flavor; `server shelve` is the variant that frees the host.
 * - Orphans: an unattached volume is backed up, then deleted (a Cinder backup,
 *   not a snapshot: snapshots depend on their volume and block its deletion);
 *   an unassociated floating IP is released.
 *
 * References:
 * https://docs.openstack.org/python-openstackclient/latest/cli/command-objects/server.html
 * https://docs.openstack.org/python-openstackclient/latest/cli/command-objects/volume.html
 * https://docs.openstack.org/python-openstackclient/latest/cli/command-objects/volume-backup.html
 * https://docs.openstack.org/python-openstackclient/latest/cli/command-objects/floating-ip.html
 */
export function openstackRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "sleep-schedule") {
    const { resource } = finding;
    if (resource.resourceTypeId !== SERVER) return [];
    const id = remediationId(resource);
    if (!id) return [];
    return [
      {
        tool: "openstack",
        command: `openstack server stop ${shellQuote(id)}`,
        description:
          "Stop the server (SHUTOFF). Check whether your cloud still bills stopped servers; shelving frees the host instead.",
        destructive: false,
      },
      {
        tool: "openstack",
        command: `openstack server start ${shellQuote(id)}`,
        description: "Start the server again.",
        destructive: false,
      },
    ];
  }

  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  const id = remediationId(resource);
  if (!id) return [];
  switch (resource.resourceTypeId) {
    case VOLUME:
      return [
        {
          tool: "openstack",
          command: `openstack volume backup create --name ${shellQuote(`${id}-final-${remediationDateStamp()}`)} ${shellQuote(id)}`,
          description:
            "Back the volume up to the Cinder backup service first (needs it deployed); wait for the backup to be available before deleting.",
          destructive: false,
        },
        {
          tool: "openstack",
          command: `openstack volume delete ${shellQuote(id)}`,
          description: "Delete the unattached volume and its data.",
          destructive: true,
        },
      ];
    case FLOATING_IP:
      return [
        {
          tool: "openstack",
          command: `openstack floating ip delete ${shellQuote(id)}`,
          description: "Release the unassociated floating IP; the address cannot be got back.",
          destructive: true,
        },
      ];
    default:
      return [];
  }
}
