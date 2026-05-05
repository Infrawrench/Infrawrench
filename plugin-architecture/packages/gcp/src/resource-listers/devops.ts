import type { ResourceInstance } from "@infrawrench/plugin-base";
import { CLOUD_BUILD_REGIONS } from "../regions.js";
import { type ListerContext } from "./shared.js";

/**
 * Cloud Build triggers can live either at the global scope or in any of
 * ~16 supported regions. The REST API has no `/locations/-/triggers`
 * aggregate, so we fan out across `CLOUD_BUILD_REGIONS` in parallel.
 * Failures per-region are swallowed (region might not have the API
 * enabled, or the project might not have any triggers there).
 *
 * The resulting `externalId` is `"<region>/<triggerId>"` so that
 * detail/delete handlers can recover the region and hit the matching
 * regional endpoint.
 */
export async function listCloudBuildTriggers(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const perRegion = await Promise.all(
    CLOUD_BUILD_REGIONS.map(async (region) => {
      const url =
        region === "global"
          ? `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers`
          : `https://cloudbuild.googleapis.com/v1/projects/${p}/locations/${region}/triggers`;
      try {
        const items = await ctx.paginate<Record<string, unknown>>(url, "triggers");
        return items.map((trigger) => buildTriggerInstance(ctx, accountId, region, trigger));
      } catch {
        return [] as ResourceInstance[];
      }
    }),
  );
  return perRegion.flat();
}

function buildTriggerInstance(
  ctx: ListerContext,
  accountId: string,
  region: string,
  trigger: Record<string, unknown>,
): ResourceInstance {
  const name = String(trigger["name"] ?? trigger["description"] ?? "");
  const id_ = String(trigger["id"] ?? "");
  const disabled = trigger["disabled"] === true;
  const repoSource = trigger["triggerTemplate"] as Record<string, unknown> | undefined;
  const github = trigger["github"] as Record<string, unknown> | undefined;
  let triggerType = "Manual";
  let repoName = "";
  let branchName = "";
  if (github) {
    triggerType = "GitHub";
    repoName = `${String(github["owner"] ?? "")}/${String(github["name"] ?? "")}`;
    const push = github["push"] as Record<string, unknown> | undefined;
    branchName = String(push?.["branch"] ?? "");
  } else if (repoSource) {
    triggerType = "Cloud Source";
    repoName = String(repoSource["repoName"] ?? "");
    branchName = String(repoSource["branchName"] ?? "");
  }
  const externalId = `${region}/${id_}`;
  return {
    id: ctx.id(accountId, "cloud-build-trigger", externalId),
    pluginId: "gcp",
    resourceTypeId: "cloud-build-trigger",
    accountId,
    displayName: name || id_,
    fields: {
      name: name || id_,
      description: String(trigger["description"] ?? ""),
      disabled,
      triggerType,
      repoName,
      branchName,
      filename: String(trigger["filename"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: String(trigger["createTime"] ?? ctx.now()),
    updatedAt: ctx.now(),
  };
}

export async function listCloudDeployPipelines(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://clouddeploy.googleapis.com/v1/projects/${p}/locations/-/deliveryPipelines`,
    "deliveryPipelines",
  );
  return items.map((pipeline) => {
    const fullName = String(pipeline["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const serialPipeline = pipeline["serialPipeline"] as Record<string, unknown> | undefined;
    const stages = serialPipeline?.["stages"] as Array<Record<string, unknown>> | undefined;
    return {
      id: ctx.id(accountId, "cloud-deploy-pipeline", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-deploy-pipeline",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        description: String(pipeline["description"] ?? ""),
        stageCount: Array.isArray(stages) ? stages.length : 0,
        stages: Array.isArray(stages)
          ? stages.map((s) => String(s["targetId"] ?? "")).join(", ")
          : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(pipeline["createTime"] ?? ctx.now()),
      updatedAt: String(pipeline["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listWorkflows(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://workflows.googleapis.com/v1/projects/${p}/locations/-/workflows`,
    "workflows",
  );
  return items.map((wf) => {
    const fullName = String(wf["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    return {
      id: ctx.id(accountId, "workflow", fullName),
      pluginId: "gcp",
      resourceTypeId: "workflow",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        state: String(wf["state"] ?? ""),
        revisionId: String(wf["revisionId"] ?? ""),
        serviceAccount:
          String(wf["serviceAccount"] ?? "")
            .split("/")
            .pop() ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(wf["createTime"] ?? ctx.now()),
      updatedAt: String(wf["updateTime"] ?? ctx.now()),
    };
  });
}
