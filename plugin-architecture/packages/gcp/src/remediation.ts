/**
 * Ready-to-run gcloud commands for GCP savings findings.
 *
 * Compute instances and disks store `externalId` as `<project>/<zone>/<name>`,
 * so their commands carry the real project. Static IPs (`<region>/<name>`)
 * and commitments do not, and reference `$GCP_PROJECT` instead.
 */
import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";

const GCP_PROJECT_PLACEHOLDER: RemediationPlaceholder = {
  name: "GCP_PROJECT",
  description: "The Google Cloud project ID for this account",
};

const PROJECT_VAR = `"$GCP_PROJECT"`;

/** GCP resource names: lowercase letter first, then [-a-z0-9], at most 63 chars. */
const GCP_NAME_MAX = 63;

interface ZonalTarget {
  name: string;
  zone: string;
  /** Shell-ready project argument: a quoted literal or `"$GCP_PROJECT"`. */
  project: string;
  placeholders: RemediationPlaceholder[] | undefined;
}

/**
 * Name, zone and project of a zonal compute resource. The lister writes
 * `<project>/<zone>/<name>` into externalId; the fields carry name and zone.
 */
function zonalTarget(resource: RemediationResource): ZonalTarget | null {
  const parts = (resource.externalId ?? "").split("/");
  const fromId = parts.length === 3 && parts.every(Boolean) ? parts : null;
  const name = remediationField(resource, "name") || fromId?.[2] || "";
  const zone = remediationField(resource, "zone") || fromId?.[1] || "";
  if (!name || !zone) return null;
  if (fromId) {
    return { name, zone, project: shellQuote(fromId[0]!), placeholders: undefined };
  }
  return { name, zone, project: PROJECT_VAR, placeholders: [GCP_PROJECT_PLACEHOLDER] };
}

function cmd(
  target: { placeholders: RemediationPlaceholder[] | undefined },
  command: string,
  description: string,
  destructive = false,
): RemediationCommand {
  return {
    tool: "gcloud",
    command,
    description,
    destructive,
    ...(target.placeholders ? { placeholders: target.placeholders } : {}),
  };
}

function snapshotName(diskName: string): string {
  const suffix = `-pre-delete-${remediationDateStamp()}`;
  const base = diskName.slice(0, GCP_NAME_MAX - suffix.length).replace(/-+$/, "");
  return `${base}${suffix}`;
}

// https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/stop
// https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/set-machine-type
// https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/start
function instanceResize(resource: RemediationResource, targetSize: string): RemediationCommand[] {
  const t = zonalTarget(resource);
  if (!t || !targetSize) return [];
  const loc = `--zone ${shellQuote(t.zone)} --project ${t.project}`;
  const name = shellQuote(t.name);
  return [
    cmd(
      t,
      `gcloud compute instances stop ${name} ${loc}`,
      "Stop the instance and wait for it to shut down; this causes downtime.",
    ),
    cmd(
      t,
      `gcloud compute instances set-machine-type ${name} --machine-type ${shellQuote(targetSize)} ${loc}`,
      `Change the machine type to ${targetSize} while the instance is stopped.`,
    ),
    cmd(t, `gcloud compute instances start ${name} ${loc}`, "Start the instance again."),
  ];
}

function instanceSleep(resource: RemediationResource): RemediationCommand[] {
  const t = zonalTarget(resource);
  if (!t) return [];
  const loc = `--zone ${shellQuote(t.zone)} --project ${t.project}`;
  const name = shellQuote(t.name);
  return [
    cmd(
      t,
      `gcloud compute instances stop ${name} ${loc}`,
      "Stop the instance; compute billing stops while disks and reserved IPs keep billing.",
    ),
    cmd(t, `gcloud compute instances start ${name} ${loc}`, "Start the instance again."),
  ];
}

// https://docs.cloud.google.com/sdk/gcloud/reference/compute/disks/snapshot
// https://docs.cloud.google.com/sdk/gcloud/reference/compute/disks/delete
function diskDelete(resource: RemediationResource): RemediationCommand[] {
  const t = zonalTarget(resource);
  if (!t) return [];
  const loc = `--zone ${shellQuote(t.zone)} --project ${t.project}`;
  const name = shellQuote(t.name);
  return [
    cmd(
      t,
      `gcloud compute disks snapshot ${name} --snapshot-names ${shellQuote(snapshotName(t.name))} ${loc}`,
      "Snapshot the disk so its data can be restored later.",
    ),
    cmd(
      t,
      `gcloud compute disks delete ${name} ${loc}`,
      "Delete the unattached disk once the snapshot has finished.",
      true,
    ),
  ];
}

// https://docs.cloud.google.com/sdk/gcloud/reference/compute/addresses/delete
function addressDelete(resource: RemediationResource): RemediationCommand[] {
  const parts = (resource.externalId ?? "").split("/");
  const name = remediationField(resource, "name") || parts[parts.length - 1] || "";
  if (!name) return [];
  // Global addresses have no region; the lister stores "" for them.
  const region = remediationField(resource, "region") || (parts.length === 2 ? parts[0]! : "");
  const scope = region ? `--region ${shellQuote(region)}` : "--global";
  const t = { placeholders: [GCP_PROJECT_PLACEHOLDER] };
  return [
    cmd(
      t,
      `gcloud compute addresses delete ${shellQuote(name)} ${scope} --project ${PROJECT_VAR}`,
      "Release the reserved static IP; the address cannot be reclaimed afterwards.",
      true,
    ),
  ];
}

// https://docs.cloud.google.com/sdk/gcloud/reference/compute/commitments/describe
// https://docs.cloud.google.com/sdk/gcloud/reference/compute/commitments/update
// gcloud compute commitments has no cancel or delete: a CUD runs to the end of its term.
function commitmentCommands(
  commitment: Extract<RemediationFinding, { kind: "idle-commitment" }>["commitment"],
): RemediationCommand[] {
  const id = commitment.id.trim();
  if (!id) return [];
  const region = commitment.region ? ` --region ${shellQuote(commitment.region)}` : "";
  const base = `${shellQuote(id)}${region} --project ${PROJECT_VAR}`;
  const t = { placeholders: [GCP_PROJECT_PLACEHOLDER] };
  return [
    cmd(
      t,
      `gcloud compute commitments describe ${base}`,
      "Show the commitment's resources, plan and end date; committed use discounts cannot be cancelled, so the fix is moving matching workloads into its region.",
    ),
    cmd(
      t,
      `gcloud compute commitments update ${base} --no-auto-renew`,
      "Turn off auto-renewal so the commitment ends with its current term.",
    ),
  ];
}

export function gcpRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  switch (finding.kind) {
    case "oversized":
      return finding.resource.resourceTypeId === "gce-instance"
        ? instanceResize(finding.resource, finding.targetSize)
        : [];
    case "sleep-schedule":
      return finding.resource.resourceTypeId === "gce-instance"
        ? instanceSleep(finding.resource)
        : [];
    case "orphan":
      switch (finding.resource.resourceTypeId) {
        case "gce-disk":
          return diskDelete(finding.resource);
        case "static-ip":
          return addressDelete(finding.resource);
        default:
          return [];
      }
    case "idle-commitment":
      return commitmentCommands(finding.commitment);
    default:
      return [];
  }
}
