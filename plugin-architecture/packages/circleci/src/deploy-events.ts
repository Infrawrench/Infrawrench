import {
  deployField,
  deployOutput,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * CircleCI pipelines as pipeline runs, matched against the org's pipeline
 * patterns by project slug. The synced `state` is the pipeline's *creation*
 * state (`created`, `errored`), not its workflows' outcome, which the
 * pipeline listing does not carry: a created deploy pipeline therefore counts
 * as a deploy and an errored one as a failed deploy. `gh/` and `github/`
 * slugs name a GitHub repository, which is what lead time resolves against.
 */
export const circleciDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["pipeline"],
  toDeployEvent(resource) {
    const at = deployTime(resource, "createdAt");
    if (!at) return null;
    const slug = deployField(resource, "projectSlug");
    const parts = slug?.split("/") ?? [];
    const repository =
      parts.length === 3 && (parts[0] === "gh" || parts[0] === "github")
        ? `${parts[1]}/${parts[2]}`
        : slug;
    const state = (deployField(resource, "state") ?? "").toLowerCase();
    return {
      kind: "pipeline",
      name: slug ?? resource.displayName,
      environment: null,
      repository,
      commitSha: deployField(resource, "revision"),
      commitAt: null,
      deployedAt: at,
      status: state === "created" ? "success" : state === "errored" ? "failure" : "in_progress",
      isRollback: false,
      url: deployOutput(resource, "url"),
    };
  },
};
