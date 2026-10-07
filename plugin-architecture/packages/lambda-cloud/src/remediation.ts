import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Lambda Cloud savings findings. Lambda publishes no CLI for
 * the Cloud API, so the one fix, deleting a filesystem no instance mounts, is
 * `curl` against the documented route the plugin's own delete calls.
 *
 * Lambda has no filesystem snapshot or backup operation, so there is no
 * preceding backup step; the description says to copy the data off first.
 *
 * Reference: https://docs.lambda.ai/api/cloud (Delete filesystem,
 * `DELETE /api/v1/filesystems/{id}`, Bearer API key).
 */
export function lambdaCloudRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "filesystem") return [];
  const id = remediationId(resource);
  if (!id) return [];
  const url = `https://cloud.lambda.ai/api/v1/filesystems/${encodeURIComponent(id)}`;
  return [
    {
      tool: "curl",
      command: `curl -sS -X DELETE ${shellQuote(url)} -H "Authorization: Bearer $LAMBDA_API_KEY"`,
      description:
        "Delete the unmounted filesystem and everything on it. Lambda keeps no backup, so copy off anything you need first.",
      destructive: true,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "LAMBDA_API_KEY",
  description: "A Lambda Cloud API key for this account",
};
