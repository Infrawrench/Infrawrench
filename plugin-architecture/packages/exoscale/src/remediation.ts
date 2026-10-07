import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `exo` (Exoscale CLI) commands for savings findings. exo reads
 * its API key from its own configured account (`exo config`), so no
 * placeholders are needed. Zonal resources store `{zone}/{uuid}` external ids;
 * every command passes the zone with `-z` and skips the prompt with `-f`.
 *
 * Reference (command definitions):
 * https://github.com/exoscale/cli/tree/master/cmd/compute
 */
export function exoscaleRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const ref = zonalRef(resource);
  if (!ref) return [];
  const id = shellQuote(ref.id);
  const z = shellQuote(ref.zone);

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    // instance_stop.go / instance_start.go
    return [
      exo(
        `exo compute instance stop -f -z ${z} ${id}`,
        "Stop the instance; Exoscale keeps billing its disk while it is stopped.",
      ),
      exo(`exo compute instance start -f -z ${z} ${id}`, "Start the instance again."),
    ];
  }

  switch (resource.resourceTypeId) {
    case "instance":
      // instance_snapshot_create.go / instance_delete.go
      return [
        exo(
          `exo compute instance snapshot create -z ${z} ${id}`,
          "Snapshot the instance's disk so it can be restored later.",
        ),
        exo(
          `exo compute instance delete -f -z ${z} ${id}`,
          "Delete the stopped instance and its disk; only the snapshot remains.",
          true,
        ),
      ];
    case "block-storage":
      // blockstorage_snapshot_create.go / blockstorage_delete.go
      return [
        exo(
          `exo compute block-storage snapshot create --name ${shellQuote(
            `${resource.displayName || ref.id}-${remediationDateStamp()}`,
          )} -z ${z} ${id}`,
          "Snapshot the volume before deleting it.",
        ),
        exo(
          `exo compute block-storage delete -f -z ${z} ${id}`,
          "Delete the unattached volume and all of its data.",
          true,
        ),
      ];
    case "elastic-ip":
      // elastic_ip_delete.go
      return [
        exo(
          `exo compute elastic-ip delete -f -z ${z} ${id}`,
          "Release the unattached elastic IP; the address cannot be got back.",
          true,
        ),
      ];
    case "nlb":
      // load_balancer/nlb_delete.go
      return [
        exo(
          `exo compute load-balancer delete -f -z ${z} ${id}`,
          "Delete the network load balancer that has no services; its IP is released.",
          true,
        ),
      ];
    default:
      return [];
  }
}

/** `{zone}/{uuid}` from the external id, the zone falling back to the stored field. */
function zonalRef(resource: RemediationResource): { zone: string; id: string } | null {
  const ext = (resource.externalId ?? "").trim();
  const slash = ext.indexOf("/");
  const id = slash >= 0 ? ext.slice(slash + 1) : ext;
  const zone = (slash >= 0 ? ext.slice(0, slash) : "") || remediationField(resource, "region");
  if (!id || !zone || id.includes("/")) return null;
  return { zone, id };
}

function exo(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "exo", command, description, destructive };
}
