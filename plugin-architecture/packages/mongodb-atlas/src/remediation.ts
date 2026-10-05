import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run Atlas CLI commands for savings findings. The `atlas` CLI reads
 * its credentials from its own profile (`atlas auth login`), so no
 * placeholders are needed; every command names the project explicitly from
 * the synced `groupId`.
 *
 * Reference: https://www.mongodb.com/docs/atlas/cli/current/command/atlas/
 */
export function mongodbAtlasRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "cluster") return [];
    return resizeCluster(resource, finding.targetSize);
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId !== "cluster") return [];
    return sleepCluster(resource);
  }

  switch (resource.resourceTypeId) {
    case "cluster":
      return deletePausedCluster(resource);
    case "online-archive":
      return deleteOnlineArchive(resource);
    case "private-endpoint-service":
      return deleteEndpointService(resource);
    default:
      return [];
  }
}

/** The cluster name and project id, or null when the row lacks either. */
function clusterRef(resource: RemediationResource): { name: string; project: string } | null {
  const name = remediationField(resource, "name") || resource.displayName.trim();
  const project = remediationField(resource, "groupId");
  if (!name || !project) return null;
  return { name, project };
}

// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-update/
function resizeCluster(resource: RemediationResource, targetSize: string): RemediationCommand[] {
  const ref = clusterRef(resource);
  if (!ref || !targetSize) return [];
  return [
    {
      tool: "atlas",
      command: `atlas clusters update ${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)} --tier ${shellQuote(targetSize)}`,
      description: `Change the cluster tier to ${targetSize}; Atlas resizes one node at a time with no downtime.`,
      destructive: false,
    },
  ];
}

// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-pause/
// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-start/
function sleepCluster(resource: RemediationResource): RemediationCommand[] {
  const ref = clusterRef(resource);
  if (!ref) return [];
  const args = `${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)}`;
  return [
    {
      tool: "atlas",
      command: `atlas clusters pause ${args}`,
      description:
        "Pause the cluster; compute stops billing but storage and backups still bill, and Atlas resumes it after 30 days.",
      destructive: false,
    },
    {
      tool: "atlas",
      command: `atlas clusters start ${args}`,
      description: "Resume the paused cluster.",
      destructive: false,
    },
  ];
}

// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-backups-snapshots-list/
// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-update/
// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-api-clusters-deleteCluster/
// A paused cluster cannot take an on-demand snapshot, and `atlas clusters
// delete` deletes the cluster's snapshots with it, so the delete goes through
// the Admin API command that can keep them (`--retainBackups`).
function deletePausedCluster(resource: RemediationResource): RemediationCommand[] {
  const ref = clusterRef(resource);
  if (!ref) return [];
  const commands: RemediationCommand[] = [
    {
      tool: "atlas",
      command: `atlas backups snapshots list ${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)}`,
      description:
        "Confirm a recent snapshot exists; it is the only copy of the data once the cluster is gone.",
      destructive: false,
    },
  ];
  if (resource.fields["terminationProtectionEnabled"] === true) {
    // A paused cluster's configuration cannot change, so it has to be resumed
    // before termination protection can be turned off.
    commands.push({
      tool: "atlas",
      command: `atlas clusters start ${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)}`,
      description: "Resume the cluster; Atlas does not change a paused cluster's settings.",
      destructive: false,
    });
    // https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-watch/
    commands.push({
      tool: "atlas",
      command: `atlas clusters watch ${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)}`,
      description: "Wait until the resumed cluster is available.",
      destructive: false,
    });
    commands.push({
      tool: "atlas",
      command: `atlas clusters update ${shellQuote(ref.name)} --projectId ${shellQuote(ref.project)} --disableTerminationProtection`,
      description: "Turn off termination protection, which otherwise blocks the delete.",
      destructive: false,
    });
  }
  commands.push({
    tool: "atlas",
    command: `atlas api clusters deleteCluster --groupId ${shellQuote(ref.project)} --clusterName ${shellQuote(ref.name)} --retainBackups`,
    description:
      "Delete the paused cluster, keeping its existing backup snapshots so it can be restored into a new cluster.",
    destructive: true,
  });
  return commands;
}

// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-onlineArchives-delete/
function deleteOnlineArchive(resource: RemediationResource): RemediationCommand[] {
  const id = remediationField(resource, "archiveId");
  const cluster = remediationField(resource, "clusterName");
  const project = remediationField(resource, "groupId");
  if (!id || !cluster || !project) return [];
  return [
    {
      tool: "atlas",
      command: `atlas clusters onlineArchives delete ${shellQuote(id)} --clusterName ${shellQuote(cluster)} --projectId ${shellQuote(project)} --force`,
      description: "Delete the orphaned online archive and the archived documents it still stores.",
      destructive: true,
    },
  ];
}

const ENDPOINT_PROVIDERS: Record<string, string> = { AWS: "aws", AZURE: "azure", GCP: "gcp" };

// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-privateEndpoints-aws-delete/
// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-privateEndpoints-azure-delete/
// https://www.mongodb.com/docs/atlas/cli/current/command/atlas-privateEndpoints-gcp-delete/
function deleteEndpointService(resource: RemediationResource): RemediationCommand[] {
  const id = remediationField(resource, "serviceId");
  const project = remediationField(resource, "groupId");
  const provider = ENDPOINT_PROVIDERS[remediationField(resource, "cloudProvider").toUpperCase()];
  if (!id || !project || !provider) return [];
  return [
    {
      tool: "atlas",
      command: `atlas privateEndpoints ${provider} delete ${shellQuote(id)} --projectId ${shellQuote(project)} --force`,
      description: "Delete the private endpoint service, which has no endpoint connected to it.",
      destructive: true,
    },
  ];
}
