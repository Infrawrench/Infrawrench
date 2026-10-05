import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `doctl` commands for savings findings. doctl reads its token
 * from its own config (`doctl auth init`), so no placeholders are needed.
 */
export function digitaloceanRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "droplet") return [];
    const id = remediationId(resource);
    if (!id || !finding.targetSize) return [];
    // https://docs.digitalocean.com/reference/doctl/reference/compute/droplet-action/resize/
    // Without --resize-disk the resize is CPU/RAM only and can be reverted.
    return [
      {
        tool: "doctl",
        command: `doctl compute droplet-action resize ${shellQuote(id)} --size ${shellQuote(finding.targetSize)} --wait`,
        description: `Resize the Droplet to ${finding.targetSize} (CPU/RAM only, disk unchanged); DigitalOcean powers it off for the change, which causes downtime.`,
        destructive: false,
      },
      {
        tool: "doctl",
        command: `doctl compute droplet-action power-on ${shellQuote(id)} --wait`,
        description: "Power the Droplet back on if it is still off after the resize.",
        destructive: false,
      },
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "droplet") return [];
    const id = remediationId(resource);
    if (!id) return [];
    // https://docs.digitalocean.com/reference/doctl/reference/compute/droplet-action/power-off/
    // https://docs.digitalocean.com/reference/doctl/reference/compute/droplet-action/power-on/
    return [
      {
        tool: "doctl",
        command: `doctl compute droplet-action power-off ${shellQuote(id)} --wait`,
        description:
          "Power off the Droplet (DigitalOcean still bills powered-off Droplets, so only destroying one stops billing).",
        destructive: false,
      },
      {
        tool: "doctl",
        command: `doctl compute droplet-action power-on ${shellQuote(id)} --wait`,
        description: "Power the Droplet back on.",
        destructive: false,
      },
    ];
  }

  // orphan
  switch (resource.resourceTypeId) {
    case "volume": {
      const id = remediationId(resource);
      if (!id) return [];
      const base = remediationField(resource, "name") || resource.displayName || id;
      const snapshot = `${base}-pre-delete-${remediationDateStamp()}`;
      // https://docs.digitalocean.com/reference/doctl/reference/compute/volume/snapshot/
      // https://docs.digitalocean.com/reference/doctl/reference/compute/volume/delete/
      return [
        {
          tool: "doctl",
          command: `doctl compute volume snapshot ${shellQuote(id)} --snapshot-name ${shellQuote(snapshot)}`,
          description: "Snapshot the volume so its data can be restored later.",
          destructive: false,
        },
        {
          tool: "doctl",
          command: `doctl compute volume delete ${shellQuote(id)} --force`,
          description: "Delete the unattached volume and all of its data.",
          destructive: true,
        },
      ];
    }
    case "reserved-ip": {
      // externalId is the address itself.
      const ip = remediationId(resource, "ip");
      if (!ip) return [];
      // https://docs.digitalocean.com/reference/doctl/reference/compute/reserved-ip/delete/
      return [
        {
          tool: "doctl",
          command: `doctl compute reserved-ip delete ${shellQuote(ip)} --force`,
          description: "Release the unassigned reserved IP; the address cannot be got back.",
          destructive: true,
        },
      ];
    }
    case "load-balancer": {
      const id = remediationId(resource);
      if (!id) return [];
      // https://docs.digitalocean.com/reference/doctl/reference/compute/load-balancer/delete/
      return [
        {
          tool: "doctl",
          command: `doctl compute load-balancer delete ${shellQuote(id)} --force`,
          description: "Delete the load balancer that has no target Droplets; its IP is released.",
          destructive: true,
        },
      ];
    }
    case "firewall": {
      const id = remediationId(resource);
      if (!id) return [];
      // https://docs.digitalocean.com/reference/doctl/reference/compute/firewall/delete/
      return [
        {
          tool: "doctl",
          command: `doctl compute firewall delete ${shellQuote(id)} --force`,
          description: "Delete the firewall that is not applied to any Droplet or tag.",
          destructive: true,
        },
      ];
    }
    default:
      return [];
  }
}
