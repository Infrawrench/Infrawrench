import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run Databricks CLI commands for savings findings. One account is
 * one workspace and the CLI picks the workspace from a `~/.databrickscfg`
 * profile, so every command names the profile through a placeholder.
 *
 * References:
 * https://docs.databricks.com/aws/en/dev-tools/cli/reference/clusters-commands
 * https://docs.databricks.com/aws/en/dev-tools/cli/reference/warehouses-commands
 * https://docs.databricks.com/aws/en/dev-tools/cli/reference/apps-commands
 */
export function databricksRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  switch (resource.resourceTypeId) {
    case "databricks-cluster": {
      const id = remediationId(resource, "clusterId");
      if (!id) return [];
      // `clusters delete` terminates (the cluster and its id survive);
      // permanent removal is the separate `permanent-delete`.
      return pair(
        `databricks clusters delete ${shellQuote(id)}`,
        "Terminate the cluster; its configuration and id are kept so it can be started again.",
        `databricks clusters start ${shellQuote(id)}`,
        "Start the terminated cluster with its previous configuration.",
      );
    }
    case "databricks-sql-warehouse": {
      const id = remediationId(resource, "warehouseId");
      if (!id) return [];
      return pair(
        `databricks warehouses stop ${shellQuote(id)}`,
        "Stop the SQL warehouse so it stops billing DBUs.",
        `databricks warehouses start ${shellQuote(id)}`,
        "Start the SQL warehouse.",
      );
    }
    case "databricks-app": {
      const name = remediationField(resource, "name") || remediationId(resource);
      if (!name) return [];
      return pair(
        `databricks apps stop ${shellQuote(name)}`,
        "Stop the app's compute so it stops billing.",
        `databricks apps start ${shellQuote(name)}`,
        "Start the app's compute again.",
      );
    }
    default:
      return [];
  }
}

const PROFILE: RemediationPlaceholder = {
  name: "DATABRICKS_PROFILE",
  description: "The ~/.databrickscfg profile for this workspace",
};

function pair(
  stop: string,
  stopDescription: string,
  start: string,
  startDescription: string,
): RemediationCommand[] {
  const profile = ` --profile "$DATABRICKS_PROFILE"`;
  return [
    {
      tool: "databricks",
      command: `${stop}${profile}`,
      description: stopDescription,
      destructive: false,
      placeholders: [PROFILE],
    },
    {
      tool: "databricks",
      command: `${start}${profile}`,
      description: startDescription,
      destructive: false,
      placeholders: [PROFILE],
    },
  ];
}
