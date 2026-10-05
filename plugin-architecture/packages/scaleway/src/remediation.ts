import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `scw` commands for savings findings. scw reads its keys from
 * its own config (`scw init`); the zone is passed explicitly because the CLI
 * otherwise defaults to fr-par-1.
 *
 * Reference: https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md
 */
export function scalewayRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;
  const target = zonedId(resource);
  if (!target) return [];
  const { id, zone } = target;
  const z = `zone=${shellQuote(zone)}`;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "instance" || !finding.targetSize) return [];
    // https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md#power-off-server
    // https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md#update-an-instance
    // Scaleway only changes the commercial type of a stopped Instance.
    return [
      {
        tool: "scw",
        command: `scw instance server stop ${shellQuote(id)} ${z} --wait`,
        description:
          "Power off the Instance; Scaleway only changes the type while it is stopped, which causes downtime.",
        destructive: false,
      },
      {
        tool: "scw",
        command: `scw instance server update ${shellQuote(id)} commercial-type=${shellQuote(finding.targetSize)} ${z}`,
        description: `Change the Instance's commercial type to ${finding.targetSize}.`,
        destructive: false,
      },
      {
        tool: "scw",
        command: `scw instance server start ${shellQuote(id)} ${z} --wait`,
        description: "Power the Instance back on.",
        destructive: false,
      },
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    // https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md#power-off-server
    // https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md#power-on-server
    return [
      {
        tool: "scw",
        command: `scw instance server stop ${shellQuote(id)} ${z} --wait`,
        description:
          "Power off the Instance, which stops compute billing (volumes and IPs keep billing).",
        destructive: false,
      },
      {
        tool: "scw",
        command: `scw instance server start ${shellQuote(id)} ${z} --wait`,
        description: "Power the Instance back on.",
        destructive: false,
      },
    ];
  }

  // orphan
  if (resource.resourceTypeId !== "flexible-ip") return [];
  // https://github.com/scaleway/scaleway-cli/blob/master/docs/commands/instance.md#delete-a-flexible-ip
  return [
    {
      tool: "scw",
      command: `scw instance ip delete ${shellQuote(id)} ${z}`,
      description: "Release the detached flexible IP; the address cannot be got back.",
      destructive: true,
    },
  ];
}

/** Instance and flexible IP externalIds are `{zone}/{uuid}`. */
function zonedId(resource: RemediationResource): { id: string; zone: string } | null {
  const ext = (resource.externalId ?? "").trim();
  const slash = ext.lastIndexOf("/");
  const id = slash >= 0 ? ext.slice(slash + 1) : ext;
  const zone = (slash >= 0 ? ext.slice(0, slash) : "") || remediationField(resource, "zone");
  if (!id || !zone) return null;
  return { id, zone };
}
