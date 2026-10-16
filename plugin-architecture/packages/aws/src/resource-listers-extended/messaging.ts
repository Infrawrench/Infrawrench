import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinIds, type ListerContext } from "../resource-listers.js";
import { collectPages, queryString, tokenParam } from "../paginate.js";

export async function listKinesisStreams(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // A Limit above 100 still returns at most 100 a page.
  const streamNames = await collectPages(async (nextToken) => {
    const data = await ctx.json<{ StreamNames?: string[]; NextToken?: string }>(
      "kinesis",
      "Kinesis_20131202.ListStreams",
      { Limit: 100, ...tokenParam("NextToken", nextToken) },
    );
    return { items: data.StreamNames ?? [], next: data.NextToken };
  });
  const results: ResourceInstance[] = [];

  for (const streamName of streamNames) {
    try {
      const detail = await ctx.json<{
        StreamDescription: Record<string, unknown>;
      }>("kinesis", "Kinesis_20131202.DescribeStream", { StreamName: streamName });
      const s = detail.StreamDescription;
      const shards = s["Shards"] as unknown[] | undefined;

      results.push({
        id: ctx.id(accountId, "kinesis-stream", streamName),
        pluginId: "aws",
        resourceTypeId: "kinesis-stream",
        accountId,
        displayName: streamName,
        fields: {
          streamName,
          region: ctx.region,
          status: String(s["StreamStatus"] ?? ""),
          shardCount: shards?.length ?? 0,
          retentionPeriodHours: Number(s["RetentionPeriodHours"] ?? 24),
          streamModeDetails: String(
            (s["StreamModeDetails"] as Record<string, unknown> | undefined)?.["StreamMode"] ??
              "PROVISIONED",
          ),
          encryptionType: String(s["EncryptionType"] ?? "NONE"),
        },
        resolvedOutputs: {
          streamArn: String(s["StreamARN"] ?? ""),
        },
        secretStates: [],
        externalId: streamName,
        createdAt: String(s["StreamCreationTimestamp"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip streams we can't describe
    }
  }
  return results;
}

export async function listMSKClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // MSK's REST API is camelCase on the wire (`clusterInfoList`, `clusterName`,
  // ...); reading the PascalCase SDK names found nothing.
  const clusters = await collectPages(async (nextToken) => {
    const data = await ctx.jsonGet<{
      clusterInfoList?: Record<string, unknown>[];
      nextToken?: string | null;
    }>("kafka", `/v1/clusters${queryString({ maxResults: 100, nextToken })}`);
    return { items: data.clusterInfoList ?? [], next: data.nextToken };
  });

  return clusters.map((c) => {
    const name = String(c["clusterName"] ?? "");
    const brokerNodeGroupInfo = c["brokerNodeGroupInfo"] as Record<string, unknown> | undefined;
    const ebsStorageInfo = (
      brokerNodeGroupInfo?.["storageInfo"] as Record<string, unknown> | undefined
    )?.["ebsStorageInfo"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "msk-cluster", name),
      pluginId: "aws",
      resourceTypeId: "msk-cluster",
      accountId,
      displayName: name,
      fields: {
        clusterName: name,
        region: ctx.region,
        state: String(c["state"] ?? ""),
        kafkaVersion: String(
          (c["currentBrokerSoftwareInfo"] as Record<string, unknown> | undefined)?.[
            "kafkaVersion"
          ] ?? "",
        ),
        numberOfBrokerNodes: Number(c["numberOfBrokerNodes"] ?? 0),
        instanceType: String(brokerNodeGroupInfo?.["instanceType"] ?? ""),
        storagePerBrokerGb: Number(ebsStorageInfo?.["volumeSize"] ?? 0),
        // Broker ENIs live in the client subnets, guarded by these groups.
        subnetIds: joinIds((brokerNodeGroupInfo?.["clientSubnets"] as string[] | undefined) ?? []),
        securityGroupIds: joinIds(
          (brokerNodeGroupInfo?.["securityGroups"] as string[] | undefined) ?? [],
        ),
      },
      resolvedOutputs: {
        clusterArn: String(c["clusterArn"] ?? ""),
        bootstrapBrokers: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(c["creationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listMQBrokers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // Amazon MQ's REST API is camelCase on the wire (`brokerSummaries`,
  // `brokerName`, ...); reading the PascalCase SDK names found nothing.
  // maxResults is 5-100 (default 20).
  const brokers = await collectPages(async (nextToken) => {
    const data = await ctx.jsonGet<{
      brokerSummaries?: Record<string, unknown>[];
      nextToken?: string | null;
    }>("mq", `/v1/brokers${queryString({ maxResults: 100, nextToken })}`);
    return { items: data.brokerSummaries ?? [], next: data.nextToken };
  });

  return brokers.map((b) => {
    const brokerName = String(b["brokerName"] ?? "");
    const brokerId = String(b["brokerId"] ?? "");
    return {
      id: ctx.id(accountId, "mq-broker", brokerId),
      pluginId: "aws",
      resourceTypeId: "mq-broker",
      accountId,
      displayName: brokerName,
      fields: {
        brokerName,
        brokerId,
        region: ctx.region,
        engineType: String(b["engineType"] ?? ""),
        // Not in ListBrokers' BrokerSummary; only DescribeBroker carries it.
        engineVersion: String(b["engineVersion"] ?? ""),
        hostInstanceType: String(b["hostInstanceType"] ?? ""),
        deploymentMode: String(b["deploymentMode"] ?? ""),
        status: String(b["brokerState"] ?? ""),
      },
      resolvedOutputs: {
        brokerArn: String(b["brokerArn"] ?? ""),
        consoleUrl: "",
      },
      secretStates: [],
      externalId: brokerId,
      createdAt: String(b["created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listEventBridgeRules(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const rules = await collectPages(async (nextToken) => {
    const data = await ctx.json<{ Rules?: Record<string, unknown>[]; NextToken?: string }>(
      "events",
      "AWSEvents.ListRules",
      { Limit: 100, ...tokenParam("NextToken", nextToken) },
    );
    return { items: data.Rules ?? [], next: data.NextToken };
  });
  return rules.map((rule) => {
    const name = String(rule["Name"] ?? "");
    return {
      id: ctx.id(accountId, "eventbridge-rule", name),
      pluginId: "aws",
      resourceTypeId: "eventbridge-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        state: String(rule["State"] ?? "ENABLED"),
        eventBusName: String(rule["EventBusName"] ?? "default"),
        scheduleExpression: String(rule["ScheduleExpression"] ?? ""),
        description: String(rule["Description"] ?? ""),
      },
      resolvedOutputs: {
        ruleArn: String(rule["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listStepFunctions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const machines = await collectPages(async (nextToken) => {
    const data = await ctx.json<{
      stateMachines?: Record<string, unknown>[];
      nextToken?: string | null;
    }>("states", "AWSStepFunctions.ListStateMachines", {
      maxResults: 1000,
      ...tokenParam("nextToken", nextToken),
    });
    return { items: data.stateMachines ?? [], next: data.nextToken };
  });
  const results: ResourceInstance[] = [];

  for (const sm of machines) {
    const name = String(sm["name"] ?? "");
    const arn = String(sm["stateMachineArn"] ?? "");
    try {
      const detail = await ctx.json<Record<string, unknown>>(
        "states",
        "AWSStepFunctions.DescribeStateMachine",
        { stateMachineArn: arn },
      );
      results.push({
        id: ctx.id(accountId, "step-function", name),
        pluginId: "aws",
        resourceTypeId: "step-function",
        accountId,
        displayName: name,
        fields: {
          name,
          region: ctx.region,
          status: String(detail["status"] ?? "ACTIVE"),
          type: String(detail["type"] ?? "STANDARD"),
          creationDate: String(detail["creationDate"] ?? ""),
          roleArn: String(detail["roleArn"] ?? ""),
        },
        resolvedOutputs: { stateMachineArn: arn },
        secretStates: [],
        externalId: name,
        createdAt: String(detail["creationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "step-function", name),
        pluginId: "aws",
        resourceTypeId: "step-function",
        accountId,
        displayName: name,
        fields: {
          name,
          region: ctx.region,
          status: "ACTIVE",
          type: String(sm["type"] ?? "STANDARD"),
          creationDate: String(sm["creationDate"] ?? ""),
          // ListStateMachines carries no role, only DescribeStateMachine does.
          roleArn: "",
        },
        resolvedOutputs: { stateMachineArn: arn },
        secretStates: [],
        externalId: name,
        createdAt: String(sm["creationDate"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}
