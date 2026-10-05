import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Anyscale savings findings: the `anyscale` CLI's
 * `workspace_v2` commands, which call the same session routes this plugin's
 * start/terminate actions do. Terminating a workspace keeps its files and
 * configuration; only the cluster goes away.
 *
 * Reference: https://docs.anyscale.com/reference/cli/workspaces
 */
export function anyscaleRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan" && finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "workspace") return [];
  const id = remediationId(resource, "workspaceId");
  if (!id) return [];
  const terminate: RemediationCommand = {
    tool: "anyscale",
    command: `anyscale workspace_v2 terminate --id ${shellQuote(id)}`,
    description:
      finding.kind === "orphan"
        ? "Terminate the idle workspace's cluster; the workspace and its files stay."
        : "Terminate the workspace's cluster; the workspace and its files stay.",
    destructive: false,
  };
  if (finding.kind === "orphan") return [terminate];
  return [
    terminate,
    {
      tool: "anyscale",
      command: `anyscale workspace_v2 start --id ${shellQuote(id)}`,
      description: "Start the workspace again.",
      destructive: false,
    },
  ];
}
