import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import type { ListerContext } from "../resource-listers.js";

export async function listCodeBuildProjects(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.json<{ projects?: string[] }>(
    "codebuild",
    "CodeBuild_20161006.ListProjects",
    {},
  );
  const projectNames = listData.projects ?? [];
  if (projectNames.length === 0) return [];

  const data = await ctx.json<{ projects?: Record<string, unknown>[] }>(
    "codebuild",
    "CodeBuild_20161006.BatchGetProjects",
    { names: projectNames },
  );
  const projects = data.projects ?? [];

  return projects.map((p) => {
    const name = String(p["name"] ?? "");
    const source = p["source"] as Record<string, unknown> | undefined;
    const environment = p["environment"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "codebuild-project", name),
      pluginId: "aws",
      resourceTypeId: "codebuild-project",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        description: String(p["description"] ?? ""),
        sourceType: String(source?.["type"] ?? ""),
        environment: String(environment?.["image"] ?? ""),
        computeType: String(environment?.["computeType"] ?? ""),
        lastBuildStatus: String(p["lastBuildStatus"] ?? ""),
        badge: (p["badge"] as Record<string, unknown> | undefined)?.["badgeEnabled"] === true,
      },
      resolvedOutputs: {
        projectArn: String(p["arn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(p["created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCodePipelines(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    pipelines?: Record<string, unknown>[];
  }>("codepipeline", "CodePipeline_20150709.ListPipelines", {});
  const pipelines = data.pipelines ?? [];

  return pipelines.map((p) => {
    const name = String(p["name"] ?? "");
    return {
      id: ctx.id(accountId, "codepipeline-pipeline", name),
      pluginId: "aws",
      resourceTypeId: "codepipeline-pipeline",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        stageCount: 0,
        version: Number(p["version"] ?? 0),
        createdAt: String(p["created"] ?? ""),
        updatedAt: String(p["updated"] ?? ""),
        pipelineType: String(p["pipelineType"] ?? ""),
      },
      resolvedOutputs: {
        pipelineArn: `arn:aws:codepipeline:${ctx.region}:${accountId}:${name}`,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(p["created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudFormationStacks(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "cloudformation",
    "DescribeStacks",
    "2010-05-15",
  );
  const result = data["DescribeStacksResult"] as Record<string, unknown> | undefined;
  const stacks = ensureArray(
    (result?.["Stacks"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];
  return stacks.map((s) => {
    const stackName = String(s["StackName"] ?? "");
    return {
      id: ctx.id(accountId, "cloudformation-stack", stackName),
      pluginId: "aws",
      resourceTypeId: "cloudformation-stack",
      accountId,
      displayName: stackName,
      fields: {
        stackName,
        region: ctx.region,
        stackId: String(s["StackId"] ?? ""),
        status: String(s["StackStatus"] ?? ""),
        description: String(s["Description"] ?? ""),
        driftStatus: String(
          s["DriftInformation"]
            ? (s["DriftInformation"] as Record<string, unknown>)["StackDriftStatus"]
            : "",
        ),
        enableTerminationProtection: String(s["EnableTerminationProtection"]) === "true",
      },
      resolvedOutputs: {
        stackArn: String(s["StackId"] ?? ""),
      },
      secretStates: [],
      externalId: stackName,
      createdAt: String(s["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listGlueDatabases(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    DatabaseList?: Record<string, unknown>[];
  }>("glue", "AWSGlue.GetDatabases", {});
  const databases = data.DatabaseList ?? [];

  return databases.map((db) => {
    const name = String(db["Name"] ?? "");
    return {
      id: ctx.id(accountId, "glue-database", name),
      pluginId: "aws",
      resourceTypeId: "glue-database",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        description: String(db["Description"] ?? ""),
        locationUri: String(db["LocationUri"] ?? ""),
        createTime: String(db["CreateTime"] ?? ""),
        catalogId: String(db["CatalogId"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(db["CreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAPIGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    Items?: Record<string, unknown>[];
  }>("apigateway", "/v2/apis");
  const apis = data.Items ?? [];

  return apis.map((api) => {
    const name = String(api["Name"] ?? "");
    const apiId = String(api["ApiId"] ?? "");
    const routeCount = Number(api["RouteSelectionExpression"] ? 1 : 0);

    return {
      id: ctx.id(accountId, "api-gateway", apiId),
      pluginId: "aws",
      resourceTypeId: "api-gateway",
      accountId,
      displayName: name || apiId,
      fields: {
        name,
        apiId,
        region: ctx.region,
        protocolType: String(api["ProtocolType"] ?? "HTTP"),
        description: String(api["Description"] ?? ""),
        routeCount,
        createdDate: String(api["CreatedDate"] ?? ""),
      },
      resolvedOutputs: {
        apiEndpoint: String(api["ApiEndpoint"] ?? ""),
        apiId,
      },
      secretStates: [],
      externalId: apiId,
      createdAt: String(api["CreatedDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
