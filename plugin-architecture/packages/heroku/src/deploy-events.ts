import {
  deployField,
  deployStatusFrom,
  deployTime,
  type DeployEventsCapability,
} from "@infrawrench/plugin-base";

/**
 * Heroku releases as deploy events. A release is also cut for every config
 * var or add-on change, which ships no code, so only releases whose
 * description says they deploy, promote or roll back count. Heroku writes
 * "Rollback to vN" for its own rollbacks. An app has no environment (staging
 * is another app), so the environment is `production`.
 */
export const herokuDeployEvents: DeployEventsCapability = {
  resourceTypeIds: ["release"],
  toDeployEvent(resource, target) {
    const description = deployField(resource, "description") ?? "";
    const rollback = /^rollback\b/i.test(description);
    if (!rollback && !/^(deploy|promote)\b/i.test(description)) return null;
    const at = deployTime(resource, "createdAt");
    if (!at) return null;
    // "Deploy 1a2b3c4d" names the slug's commit.
    const sha = /^deploy\s+([0-9a-f]{7,40})\b/i.exec(description)?.[1] ?? null;
    return {
      kind: "deployment",
      name: deployField(resource, "appName") ?? target?.displayName ?? resource.displayName,
      environment: "production",
      repository: null,
      commitSha: sha,
      commitAt: null,
      deployedAt: at,
      status: deployStatusFrom(deployField(resource, "status"), {
        success: ["succeeded"],
        failure: ["failed", "expired"],
      }),
      isRollback: rollback,
      url: null,
    };
  },
};
