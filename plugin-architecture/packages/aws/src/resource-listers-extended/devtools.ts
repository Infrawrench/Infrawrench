import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import type { ListerContext } from "../resource-listers.js";
import { collectPages, queryString, tokenParam } from "../paginate.js";

export async function listCodeBuildProjects(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // ListProjects has no page-size parameter (fixed pages of 100).
  const projectNames = await collectPages(async (nextToken) => {
    const listData = await ctx.json<{ projects?: string[]; nextToken?: string | null }>(
      "codebuild",
      "CodeBuild_20161006.ListProjects",
      tokenParam("nextToken", nextToken),
    );
    return { items: listData.projects ?? [], next: listData.nextToken };
  });
  if (projectNames.length === 0) return [];

  // BatchGetProjects takes at most 100 names per call.
  const projects: Record<string, unknown>[] = [];
  for (let i = 0; i < projectNames.length; i += 100) {
    const data = await ctx.json<{ projects?: Record<string, unknown>[] }>(
      "codebuild",
      "CodeBuild_20161006.BatchGetProjects",
      { names: projectNames.slice(i, i + 100) },
    );
    projects.push(...(data.projects ?? []));
  }

  return projects.map((p) => {
    const name = String(p["name"] ?? "");
    const source = p["source"] as Record<string, unknown> | undefined;
    const environment = p["environment"] as Record<string, unknown> | undefined;
    const cwLogs = (p["logsConfig"] as Record<string, unknown> | undefined)?.["cloudWatchLogs"] as
      Record<string, unknown> | undefined;

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
        // Read by the Logs tab. Underscored so they stay out of the Details list.
        _logGroupName: String(cwLogs?.["groupName"] ?? ""),
        _logStreamPrefix: String(cwLogs?.["streamName"] ?? ""),
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
  const pipelines = await collectPages(async (nextToken) => {
    const data = await ctx.json<{
      pipelines?: Record<string, unknown>[];
      nextToken?: string | null;
    }>("codepipeline", "CodePipeline_20150709.ListPipelines", {
      maxResults: 1000,
      ...tokenParam("nextToken", nextToken),
    });
    return { items: data.pipelines ?? [], next: data.nextToken };
  });

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
  // DescribeStacks has no page-size parameter; it pages by response size.
  const stacks = await collectPages(async (nextToken) => {
    const data = await ctx.ec2Query<Record<string, unknown>>(
      "cloudformation",
      "DescribeStacks",
      "2010-05-15",
      tokenParam("NextToken", nextToken),
    );
    const result = data["DescribeStacksResult"] as Record<string, unknown> | undefined;
    return {
      items: ensureArray(
        (result?.["Stacks"] as Record<string, unknown> | undefined)?.["member"],
      ) as Record<string, unknown>[],
      next: result?.["NextToken"],
    };
  });
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
  const databases = await collectPages(async (nextToken) => {
    const data = await ctx.json<{
      DatabaseList?: Record<string, unknown>[];
      NextToken?: string | null;
    }>("glue", "AWSGlue.GetDatabases", {
      MaxResults: 100,
      ...tokenParam("NextToken", nextToken),
    });
    return { items: data.DatabaseList ?? [], next: data.NextToken };
  });

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
  // API Gateway v2's REST API is camelCase on the wire (`items`, `apiId`,
  // ...); reading the PascalCase SDK names found nothing. The docs give no
  // range for maxResults, so the walk just follows `nextToken`.
  const apis = await collectPages(async (nextToken) => {
    const data = await ctx.jsonGet<{
      items?: Record<string, unknown>[];
      nextToken?: string | null;
    }>("apigateway", `/v2/apis${queryString({ nextToken })}`);
    return { items: data.items ?? [], next: data.nextToken };
  });

  return apis.map((api) => {
    const name = String(api["name"] ?? "");
    const apiId = String(api["apiId"] ?? "");
    const routeCount = Number(api["routeSelectionExpression"] ? 1 : 0);

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
        protocolType: String(api["protocolType"] ?? "HTTP"),
        description: String(api["description"] ?? ""),
        routeCount,
        createdDate: String(api["createdDate"] ?? ""),
      },
      resolvedOutputs: {
        apiEndpoint: String(api["apiEndpoint"] ?? ""),
        apiId,
      },
      secretStates: [],
      externalId: apiId,
      createdAt: String(api["createdDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
