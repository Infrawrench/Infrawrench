import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `confluent` CLI commands for savings findings. The CLI reads
 * its credentials from its own login (`confluent login`), so no placeholders
 * are needed; every command names the environment explicitly so it works
 * whatever environment the CLI context currently points at.
 *
 * Reference: https://docs.confluent.io/confluent-cli/current/command-reference/index.html
 */
export function confluentRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "sleep-schedule") return [];
  const { resource } = finding;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "kafka-cluster") return [];
    return resizeCluster(resource, finding.currentSize, finding.targetSize);
  }

  switch (resource.resourceTypeId) {
    case "kafka-cluster":
      return deleteCluster(resource);
    case "connector":
      return deleteConnector(resource);
    case "network":
      return deleteNetwork(resource);
    default:
      return [];
  }
}

/** ` --environment env-…`, or "" when the row does not say. */
function envFlag(resource: RemediationResource): string {
  const env = remediationField(resource, "environmentId");
  return env ? ` --environment ${shellQuote(env)}` : "";
}

// https://docs.confluent.io/confluent-cli/current/command-reference/kafka/cluster/confluent_kafka_cluster_update.html
// The --cku flag is reduced one CKU at a time when shrinking, so a shrink is
// one update per step down (capped at ten); a grow is a single update.
function resizeCluster(
  resource: RemediationResource,
  currentSize: string,
  targetSize: string,
): RemediationCommand[] {
  const id = remediationId(resource, "clusterId");
  const target = Number(targetSize);
  const current = Number(currentSize);
  if (!id || !Number.isInteger(target) || target < 1) return [];
  const steps: number[] = [];
  if (Number.isInteger(current) && current > target) {
    for (let cku = current - 1; cku >= target && steps.length < 10; cku--) steps.push(cku);
  } else {
    steps.push(target);
  }
  const env = envFlag(resource);
  return steps.map((cku) => ({
    tool: "confluent",
    command: `confluent kafka cluster update ${shellQuote(id)} --cku ${cku}${env}`,
    description:
      steps.length > 1
        ? `Shrink the Dedicated cluster to ${cku} CKUs online; Confluent only shrinks one CKU at a time, so wait for each step to finish.`
        : `Resize the Dedicated cluster to ${cku} CKUs online; billing follows the new size from the next hour.`,
    destructive: false,
  }));
}

// https://docs.confluent.io/confluent-cli/current/command-reference/kafka/cluster/confluent_kafka_cluster_describe.html
// https://docs.confluent.io/confluent-cli/current/command-reference/kafka/topic/confluent_kafka_topic_list.html
// https://docs.confluent.io/confluent-cli/current/command-reference/kafka/cluster/confluent_kafka_cluster_delete.html
function deleteCluster(resource: RemediationResource): RemediationCommand[] {
  const id = remediationId(resource, "clusterId");
  if (!id) return [];
  const env = envFlag(resource);
  return [
    {
      tool: "confluent",
      command: `confluent kafka cluster describe ${shellQuote(id)}${env} --output json`,
      description: "Record the cluster's configuration before deleting it.",
      destructive: false,
    },
    {
      tool: "confluent",
      command: `confluent kafka topic list --cluster ${shellQuote(id)}${env}`,
      description: "List the topics that will be lost, to confirm nothing still needs them.",
      destructive: false,
    },
    {
      tool: "confluent",
      command: `confluent kafka cluster delete ${shellQuote(id)}${env} --force`,
      description:
        "Delete the cluster and every topic and record in it; Kafka clusters have no snapshot to restore from.",
      destructive: true,
    },
  ];
}

// https://docs.confluent.io/confluent-cli/current/command-reference/connect/cluster/confluent_connect_cluster_describe.html
// https://docs.confluent.io/confluent-cli/current/command-reference/connect/cluster/confluent_connect_cluster_delete.html
function deleteConnector(resource: RemediationResource): RemediationCommand[] {
  // The CLI addresses connectors by their lcc- id; the externalId falls back to
  // the connector name when Confluent did not return an id.
  const id = remediationField(resource, "connectorId");
  const cluster = remediationField(resource, "clusterId");
  if (!id || !cluster) return [];
  const scope = ` --cluster ${shellQuote(cluster)}${envFlag(resource)}`;
  const backup = `${id}-connector.json`;
  return [
    {
      tool: "confluent",
      command: `confluent connect cluster describe ${shellQuote(id)}${scope} --output json > ${shellQuote(backup)}`,
      description: "Save the connector's configuration so it can be recreated later.",
      destructive: false,
    },
    {
      tool: "confluent",
      command: `confluent connect cluster delete ${shellQuote(id)}${scope} --force`,
      description: "Delete the connector, which stops its task-hour billing (pausing it does not).",
      destructive: true,
    },
  ];
}

// https://docs.confluent.io/confluent-cli/current/command-reference/network/confluent_network_describe.html
// https://docs.confluent.io/confluent-cli/current/command-reference/network/confluent_network_delete.html
function deleteNetwork(resource: RemediationResource): RemediationCommand[] {
  const id = remediationId(resource, "networkId");
  if (!id) return [];
  const env = envFlag(resource);
  return [
    {
      tool: "confluent",
      command: `confluent network describe ${shellQuote(id)}${env} --output json`,
      description: "Record the network's CIDR, zones and connection types before deleting it.",
      destructive: false,
    },
    {
      tool: "confluent",
      command: `confluent network delete ${shellQuote(id)}${env} --force`,
      description:
        "Delete the idle network; a new one would get new DNS names and need peering or private links set up again.",
      destructive: true,
    },
  ];
}
