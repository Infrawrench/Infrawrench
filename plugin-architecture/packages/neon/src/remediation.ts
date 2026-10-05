import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Neon savings findings. `neonctl` has no command to suspend
 * or start a compute, so the commands are `curl` against the Neon API with a
 * bearer API key.
 *
 * References:
 * https://api-docs.neon.tech/reference/suspendprojectendpoint
 * https://api-docs.neon.tech/reference/startprojectendpoint
 */
export function neonRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "neon-endpoint") return [];
  const endpoint = remediationId(resource);
  const project = remediationField(resource, "projectId");
  if (!endpoint.startsWith("ep-") || !project) return [];
  const base = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(project)}/endpoints/${encodeURIComponent(endpoint)}`;
  const auth = `-H "Authorization: Bearer $NEON_API_KEY"`;
  return [
    {
      tool: "curl",
      command: `curl -sS -X POST ${shellQuote(`${base}/suspend`)} ${auth}`,
      description:
        "Suspend the compute; it stops using compute units, though the next connection wakes it again.",
      destructive: false,
      placeholders: [API_KEY],
    },
    {
      tool: "curl",
      command: `curl -sS -X POST ${shellQuote(`${base}/start`)} ${auth}`,
      description: "Start the compute again.",
      destructive: false,
      placeholders: [API_KEY],
    },
  ];
}

const API_KEY: RemediationPlaceholder = {
  name: "NEON_API_KEY",
  description: "A Neon API key with access to this project",
};
