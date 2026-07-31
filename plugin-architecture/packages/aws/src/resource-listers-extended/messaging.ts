import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinIds, type ListerContext } from "../resource-listers.js";

export async function listKinesisStreams(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ StreamNames?: string[] }>(
    "kinesis",
    "Kinesis_20131202.ListStreams",
    {},
  );
  const streamNames = data.StreamNames ?? [];
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
  const data = await ctx.jsonGet<{
    ClusterInfoList?: Record<string, unknown>[];
  }>("kafka", "/v1/clusters");
  const clusters = data.ClusterInfoList ?? [];

  return clusters.map((c) => {
    const name = String(c["ClusterName"] ?? "");
    const brokerNodeGroupInfo = c["BrokerNodeGroupInfo"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "msk-cluster", name),
      pluginId: "aws",
      resourceTypeId: "msk-cluster",
      accountId,
      displayName: name,
      fields: {
        clusterName: name,
        region: ctx.region,
        state: String(c["State"] ?? ""),
        kafkaVersion: String(
          c["CurrentBrokerSoftwareInfo"]
            ? (c["CurrentBrokerSoftwareInfo"] as Record<string, unknown>)["KafkaVersion"]
            : "",
        ),
        numberOfBrokerNodes: Number(c["NumberOfBrokerNodes"] ?? 0),
        instanceType: String(brokerNodeGroupInfo?.["InstanceType"] ?? ""),
        storagePerBrokerGb: Number(
          ((brokerNodeGroupInfo?.["StorageInfo"] as Record<string, unknown> | undefined)?.[
            "EbsStorageInfo"
          ] as Record<string, unknown> | undefined)
            ? ((
                (brokerNodeGroupInfo?.["StorageInfo"] as Record<string, unknown>)?.[
                  "EbsStorageInfo"
                ] as Record<string, unknown>
              )?.["VolumeSize"] ?? 0)
            : 0,
        ),
        // Broker ENIs live in the client subnets, guarded by these groups.
        subnetIds: joinIds((brokerNodeGroupInfo?.["ClientSubnets"] as string[] | undefined) ?? []),
        securityGroupIds: joinIds(
          (brokerNodeGroupInfo?.["SecurityGroups"] as string[] | undefined) ?? [],
        ),
      },
      resolvedOutputs: {
        clusterArn: String(c["ClusterArn"] ?? ""),
        bootstrapBrokers: "",
      },
      secretStates: [],
      externalId: name,
      createdAt: String(c["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listMQBrokers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    BrokerSummaries?: Record<string, unknown>[];
  }>("mq", "/v1/brokers");
  const brokers = data.BrokerSummaries ?? [];

  return brokers.map((b) => {
    const brokerName = String(b["BrokerName"] ?? "");
    const brokerId = String(b["BrokerId"] ?? "");
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
        engineType: String(b["EngineType"] ?? ""),
        engineVersion: String(b["EngineVersion"] ?? ""),
        hostInstanceType: String(b["HostInstanceType"] ?? ""),
        deploymentMode: String(b["DeploymentMode"] ?? ""),
        status: String(b["BrokerState"] ?? ""),
      },
      resolvedOutputs: {
        brokerArn: String(b["BrokerArn"] ?? ""),
        consoleUrl: "",
      },
      secretStates: [],
      externalId: brokerId,
      createdAt: String(b["Created"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listEventBridgeRules(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Rules?: Record<string, unknown>[] }>(
    "events",
    "AWSEvents.ListRules",
    {},
  );
  const rules = data.Rules ?? [];
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
  const data = await ctx.json<{ stateMachines?: Record<string, unknown>[] }>(
    "states",
    "AWSStepFunctions.ListStateMachines",
    {},
  );
  const machines = data.stateMachines ?? [];
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
          // ListStateMachines carries no role — only DescribeStateMachine does.
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
