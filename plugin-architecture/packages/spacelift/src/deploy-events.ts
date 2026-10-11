import {
  deployField,
  deployOutput,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Spacelift tracked runs as deploy events: a tracked run is the one that
 * applies (proposed runs only plan, tasks run commands). The stack is the
 * environment, matched against the org's production patterns, and the stack
 * row supplies the repository.
 */
export const spaceliftDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["run"],
  toDeployEvent(resource, target) {
    if ((deployField(resource, "type") ?? "").toLowerCase() !== "tracked") return null;
    if (resource.fields["drift"] === true) return null;
    const at = deployTime(resource, "createdAt");
    if (!at) return null;
    const stack = deployField(resource, "stackName");
    return {
      kind: "deployment",
      name: stack ?? resource.displayName,
      environment: stack,
      repository: target ? deployField(target, "repository") : null,
      commitSha: deployField(resource, "commit"),
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "state"), {
        success: ["finished"],
        failure: ["failed"],
        canceled: ["canceled", "discarded", "stopped"],
      }),
      isRollback: false,
      url: deployOutput(resource, "url"),
    };
  },
};
