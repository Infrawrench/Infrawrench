import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run commands for Nomad savings findings. The only finding is the
 * orphan rule on client nodes that are down, and the fix is a purge, the
 * same call the plugin's own Purge action makes. `nomad node` has no purge
 * subcommand, so it goes through `nomad operator api`, which reads
 * `NOMAD_ADDR`, `NOMAD_TOKEN` and the TLS variables like every other command.
 *
 * References:
 * https://developer.hashicorp.com/nomad/api-docs/nodes#purge-node (POST /v1/node/:node_id/purge, node:write)
 * https://developer.hashicorp.com/nomad/commands/operator/api
 * https://developer.hashicorp.com/nomad/commands/node/status
 */
export function nomadRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "nomad-node") return [];
  const id = remediationId(resource);
  if (!id) return [];
  return [
    {
      tool: "nomad",
      command: `nomad node status ${shellQuote(id)}`,
      description: "Confirm the node is still down before removing it.",
      destructive: false,
    },
    {
      tool: "nomad",
      command: `nomad operator api -X POST ${shellQuote(`/v1/node/${encodeURIComponent(id)}/purge`)}`,
      description:
        "Purge the down node from the cluster state; its allocations are marked lost and rescheduled. A node that comes back re-registers.",
      destructive: true,
    },
  ];
}
