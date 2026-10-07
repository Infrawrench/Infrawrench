import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `qcloud` (Qdrant Cloud CLI) commands for savings findings. The
 * only finding is a cluster sleep schedule: suspend and unsuspend, the same
 * management API actions this plugin's own buttons call. qcloud reads the
 * management key and account from `QDRANT_CLOUD_API_KEY` and
 * `QDRANT_CLOUD_ACCOUNT_ID` (or a configured context).
 *
 * References:
 * https://qdrant.tech/documentation/cloud-cli/
 * https://github.com/qdrant/qcloud-cli/blob/main/internal/cmd/cluster/suspend.go
 * https://github.com/qdrant/qcloud-cli/blob/main/internal/cmd/cluster/unsuspend.go
 */
export function qdrantRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "cluster") return [];
  const id = remediationId(resource);
  if (!id) return [];
  const q = shellQuote(id);
  return [
    qcloud(
      `qcloud cluster suspend ${q} --force`,
      "Suspend the cluster: compute stops billing, while its disks (and data) are kept and still billed.",
    ),
    qcloud(`qcloud cluster unsuspend ${q}`, "Bring the cluster back."),
  ];
}

const PLACEHOLDERS: RemediationPlaceholder[] = [
  { name: "QDRANT_CLOUD_API_KEY", description: "A Qdrant Cloud management API key" },
  { name: "QDRANT_CLOUD_ACCOUNT_ID", description: "The Qdrant Cloud account id" },
];

function qcloud(command: string, description: string): RemediationCommand {
  return { tool: "qcloud", command, description, destructive: false, placeholders: PLACEHOLDERS };
}
