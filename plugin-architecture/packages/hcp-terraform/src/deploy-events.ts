import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * HCP Terraform runs as deploy events. A run deploys when it applies, so
 * plan-only, refresh-only and no-change runs are skipped; `applied` is
 * success. The workspace is the environment, and the workspace row supplies
 * the VCS repository.
 */
export const hcpTerraformDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["run"],
  toDeployEvent(resource, target) {
    if (resource.fields["planOnly"] === true || resource.fields["refreshOnly"] === true)
      return null;
    const status = (deployField(resource, "status") ?? "").toLowerCase();
    if (status === "planned_and_finished") return null;
    const at = deployTime(resource, "createdAt");
    if (!at) return null;
    const workspace = deployField(resource, "workspaceName");
    return {
      kind: "deployment",
      name: workspace ?? resource.displayName,
      environment: workspace,
      repository: target ? deployField(target, "vcsRepo") : null,
      commitSha: null,
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(status, {
        success: ["applied"],
        failure: ["errored"],
        canceled: ["canceled", "discarded", "force_canceled"],
      }),
      isRollback: false,
      url: deployOutput(resource, "url"),
    };
  },
};
