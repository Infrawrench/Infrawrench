import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for RabbitMQ savings findings. The only finding is the orphan
 * rule on queues (no consumers, no messages), so the fix is a delete that
 * re-checks both conditions at the moment it runs: a consumer may have
 * reconnected or a publisher written since the last sync.
 *
 * - `rabbitmqctl delete_queue --if-empty --if-unused`, run on a cluster node.
 * - The same conditional delete over the management HTTP API (`curl`), for
 *   when there is no shell on a node. rabbitmqadmin v2 is not offered: its
 *   `queues delete` has no if-empty / if-unused guard.
 *
 * References:
 * https://www.rabbitmq.com/docs/man/rabbitmqctl.8 (delete_queue)
 * https://www.rabbitmq.com/docs/http-api-reference (DELETE /api/queues/{vhost}/{name})
 * https://www.rabbitmq.com/docs/management-cli
 */
export function rabbitmqRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "rabbitmq-queue") return [];
  const vhost = remediationField(resource, "vhost");
  const name = remediationField(resource, "name");
  if (!vhost || !name) return [];
  const path = `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}?if-empty=true&if-unused=true`;
  return [
    {
      tool: "rabbitmqctl",
      command: `rabbitmqctl delete_queue -p ${shellQuote(vhost)} ${shellQuote(name)} --if-empty --if-unused`,
      description:
        "On a cluster node: delete the queue, but only if it is still empty and has no consumers.",
      destructive: true,
    },
    {
      tool: "curl",
      command: `curl -sS -X DELETE -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" "$RABBITMQ_MANAGEMENT_URL"${shellQuote(path)}`,
      description:
        "Or the same conditional delete through the management API, from anywhere that can reach it.",
      destructive: true,
      placeholders: PLACEHOLDERS,
    },
  ];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "RABBITMQ_MANAGEMENT_URL",
    description:
      "The management API base URL, without a trailing slash (e.g. https://rabbit.example.com:15671)",
  },
  { name: "RABBITMQ_USER", description: "A management user with configure rights on the vhost" },
  { name: "RABBITMQ_PASSWORD", description: "That user's password" },
];
