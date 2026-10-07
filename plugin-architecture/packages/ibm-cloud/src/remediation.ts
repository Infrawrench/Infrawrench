import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `ibmcloud is` (VPC infrastructure CLI plugin) commands for
 * savings findings. The VPC commands take no region flag, so every list
 * starts by targeting the resource's region; the login comes from
 * `ibmcloud login`. VPC resources store `{region}/{id}` external ids.
 *
 * Reference: https://cloud.ibm.com/docs/vpc?topic=vpc-vpc-reference
 * (`instance-start`, `instance-stop`, `instance-delete`, `snapshot-create
 * --source-volume`, `volume-delete`, `floating-ip-release`,
 * `load-balancer-delete`; `-f` skips the confirmation prompt)
 */
export function ibmRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;
  const ref = regionalRef(resource);
  if (!ref) return [];
  const id = shellQuote(ref.id);
  const target = ibm(
    `ibmcloud target -r ${shellQuote(ref.region)}`,
    `Target the ${ref.region} region, where the resource lives.`,
  );

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "instance") return [];
    return [
      target,
      ibm(
        `ibmcloud is instance-stop ${id} -f`,
        "Stop the server; most profiles stop billing vCPU and memory, its volumes keep billing.",
      ),
      ibm(`ibmcloud is instance-start ${id}`, "Start the server again."),
    ];
  }

  const stamp = remediationDateStamp();
  switch (resource.resourceTypeId) {
    case "instance": {
      const boot = remediationField(resource, "bootVolumeId");
      return [
        target,
        ...(boot
          ? [
              ibm(
                `ibmcloud is snapshot-create --source-volume ${shellQuote(boot)} --name ${shellQuote(snapshotName(boot, stamp))}`,
                "Snapshot the boot volume so the server can be recreated from it.",
              ),
            ]
          : []),
        ibm(
          `ibmcloud is instance-delete ${id} -f`,
          "Delete the stopped server; its boot volume, and any data volume set to delete with it, go too.",
          true,
        ),
      ];
    }
    case "volume":
      return [
        target,
        ibm(
          `ibmcloud is snapshot-create --source-volume ${id} --name ${shellQuote(snapshotName(ref.id, stamp))}`,
          "Snapshot the volume before deleting it.",
        ),
        ibm(
          `ibmcloud is volume-delete ${id} -f`,
          "Delete the unattached volume and all of its data.",
          true,
        ),
      ];
    case "floating-ip":
      return [
        target,
        ibm(
          `ibmcloud is floating-ip-release ${id} -f`,
          "Release the unbound floating IP; the address cannot be got back.",
          true,
        ),
      ];
    case "load-balancer":
      return [
        target,
        ibm(
          `ibmcloud is load-balancer-delete ${id} -f`,
          "Delete the load balancer that has no pools; its hostname stops resolving.",
          true,
        ),
      ];
    default:
      return [];
  }
}

/** VPC names are lowercase letters, digits and hyphens, starting with a letter. */
function snapshotName(volumeId: string, stamp: string): string {
  const slug = volumeId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `iw-${slug}-${stamp}`;
}

/** `{region}/{id}` from the external id, the region falling back to the stored field. */
function regionalRef(resource: RemediationResource): { region: string; id: string } | null {
  const ext = (resource.externalId ?? "").trim();
  const slash = ext.indexOf("/");
  const id = slash >= 0 ? ext.slice(slash + 1) : ext;
  const region = (slash >= 0 ? ext.slice(0, slash) : "") || remediationField(resource, "region");
  if (!id || !region || id.includes("/")) return null;
  return { region, id };
}

function ibm(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "ibmcloud", command, description, destructive };
}
