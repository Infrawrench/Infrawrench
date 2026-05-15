import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { fetchSigned } from "../signed-request.js";
import { AWS_REGIONS } from "../constants.js";
import type { AwsCreateContext } from "./shared.js";

export async function messagingGetCreateConfig(
  ctx: AwsCreateContext,
  typeId: string,
  _parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "sqs-queue") {
    return {
      fields: [
        { key: "queueName", label: "Queue Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "fifo",
          label: "FIFO Queue",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Standard" },
            { id: "true", label: "FIFO" },
          ],
          defaultValue: "false",
        },
      ],
    };
  }
  if (typeId === "sns-topic") {
    return {
      fields: [
        { key: "topicName", label: "Topic Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "fifo",
          label: "FIFO Topic",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Standard" },
            { id: "true", label: "FIFO" },
          ],
          defaultValue: "false",
        },
      ],
    };
  }
  if (typeId === "kinesis-stream") {
    return {
      fields: [
        { key: "streamName", label: "Stream Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "shardCount",
          label: "Shard Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 500,
        },
      ],
    };
  }
  if (typeId === "eventbridge-rule") {
    return {
      fields: [
        { key: "name", label: "Rule Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "scheduleExpression",
          label: "Schedule Expression",
          kind: "text",
          required: false,
          description: "e.g. rate(5 minutes) or cron(0 12 * * ? *)",
        },
        {
          key: "eventPattern",
          label: "Event Pattern (JSON)",
          kind: "text",
          required: false,
          description: "JSON event pattern (provide either schedule or pattern)",
        },
        { key: "description", label: "Description", kind: "text", required: false },
      ],
    };
  }
  if (typeId === "mq-broker") {
    return {
      fields: [
        { key: "brokerName", label: "Broker Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AWS_REGIONS,
          defaultValue: ctx.creds.region,
        },
        {
          key: "engineType",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "ACTIVEMQ", label: "ActiveMQ" },
            { id: "RABBITMQ", label: "RabbitMQ" },
          ],
          defaultValue: "RABBITMQ",
        },
        {
          key: "hostInstanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "mq.t3.micro", label: "mq.t3.micro" },
            { id: "mq.m5.large", label: "mq.m5.large" },
            { id: "mq.m5.xlarge", label: "mq.m5.xlarge" },
          ],
          defaultValue: "mq.t3.micro",
        },
        {
          key: "deploymentMode",
          label: "Deployment Mode",
          kind: "select",
          required: true,
          options: [
            { id: "SINGLE_INSTANCE", label: "Single Instance" },
            { id: "ACTIVE_STANDBY_MULTI_AZ", label: "Active/Standby Multi-AZ" },
            { id: "CLUSTER_MULTI_AZ", label: "Cluster Multi-AZ" },
          ],
          defaultValue: "SINGLE_INSTANCE",
        },
        {
          key: "username",
          label: "Admin Username",
          kind: "text",
          required: true,
          defaultValue: "admin",
        },
        { key: "password", label: "Admin Password", kind: "text", required: true },
      ],
    };
  }
  return null;
}

export async function messagingCreateResource(
  ctx: AwsCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  _parentResourceId?: string,
): Promise<ResourceInstance | null> {
  if (typeId === "sqs-queue") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const queueName =
      fields["fifo"] === "true"
        ? (fields["queueName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : (fields["queueName"] ?? "");
    const body: Record<string, unknown> = { QueueName: queueName };
    if (fields["fifo"] === "true") {
      body["Attributes"] = { FifoQueue: "true" };
    }
    const data = await rctx.json<{ QueueUrl?: string }>("sqs", "AmazonSQS.CreateQueue", body);
    const queueUrl = data.QueueUrl ?? "";
    return {
      id: ctx.makeId(accountId, "sqs-queue", queueName),
      pluginId: "aws",
      resourceTypeId: "sqs-queue",
      accountId,
      displayName: queueName,
      fields: {
        queueName,
        region,
        queueUrl,
        approximateMessages: 0,
        approximateMessagesDelayed: 0,
        approximateMessagesNotVisible: 0,
        isFifo: queueName.endsWith(".fifo"),
      },
      resolvedOutputs: { queueArn: "" },
      secretStates: [],
      externalId: queueName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "sns-topic") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const topicName =
      fields["fifo"] === "true"
        ? (fields["topicName"] ?? "").replace(/\.fifo$/, "") + ".fifo"
        : (fields["topicName"] ?? "");
    const body: Record<string, unknown> = { Name: topicName };
    if (fields["fifo"] === "true") {
      body["Attributes"] = { FifoTopic: "true" };
    }
    const data = await rctx.json<{ TopicArn?: string }>("sns", "SNS.CreateTopic", body);
    const topicArn = data.TopicArn ?? "";
    return {
      id: ctx.makeId(accountId, "sns-topic", topicName),
      pluginId: "aws",
      resourceTypeId: "sns-topic",
      accountId,
      displayName: topicName,
      fields: {
        topicName,
        region,
        topicArn,
        subscriptionCount: 0,
        isFifo: topicName.endsWith(".fifo"),
      },
      resolvedOutputs: { topicArn },
      secretStates: [],
      externalId: topicName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "kinesis-stream") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const streamName = fields["streamName"] ?? "";
    await rctx.json<Record<string, unknown>>("kinesis", "Kinesis_20131202.CreateStream", {
      StreamName: streamName,
      ShardCount: Number(fields["shardCount"] ?? "1"),
    });
    return {
      id: ctx.makeId(accountId, "kinesis-stream", streamName),
      pluginId: "aws",
      resourceTypeId: "kinesis-stream",
      accountId,
      displayName: streamName,
      fields: {
        streamName,
        region,
        status: "CREATING",
        shardCount: Number(fields["shardCount"] ?? "1"),
        retentionPeriodHours: 24,
        streamModeDetails: "PROVISIONED",
        encryptionType: "NONE",
      },
      resolvedOutputs: {
        streamArn: "",
      },
      secretStates: [],
      externalId: streamName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "eventbridge-rule") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const name = fields["name"] ?? "";
    const body: Record<string, unknown> = { Name: name };
    if (fields["scheduleExpression"]) body["ScheduleExpression"] = fields["scheduleExpression"];
    if (fields["eventPattern"]) body["EventPattern"] = fields["eventPattern"];
    if (fields["description"]) body["Description"] = fields["description"];
    const data = await rctx.json<{ RuleArn?: string }>("events", "AWSEvents.PutRule", body);
    const ruleArn = data.RuleArn ?? "";
    return {
      id: ctx.makeId(accountId, "eventbridge-rule", name),
      pluginId: "aws",
      resourceTypeId: "eventbridge-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        state: "ENABLED",
        eventBusName: "default",
        scheduleExpression: fields["scheduleExpression"] ?? "",
        description: fields["description"] ?? "",
      },
      resolvedOutputs: { ruleArn },
      secretStates: [],
      externalId: name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (typeId === "mq-broker") {
    const region = fields["region"] ?? ctx.creds.region;
    const rctx = ctx.withRegion(region);
    const brokerName = fields["brokerName"] ?? "";
    const host = rctx.hostForService("mq");
    const url = `https://${host}/v1/brokers`;
    const bodyObj = {
      BrokerName: brokerName,
      EngineType: fields["engineType"] ?? "RABBITMQ",
      EngineVersion: fields["engineType"] === "ACTIVEMQ" ? "5.19" : "3.13",
      HostInstanceType: fields["hostInstanceType"] ?? "mq.t3.micro",
      DeploymentMode: fields["deploymentMode"] ?? "SINGLE_INSTANCE",
      PubliclyAccessible: false,
      Users: [
        {
          Username: fields["username"] ?? "admin",
          Password: fields["password"] ?? "",
        },
      ],
    };
    const bodyStr = JSON.stringify(bodyObj);
    const res = await fetchSigned({
      method: "POST",
      url,
      headers: { Host: host, "Content-Type": "application/json" },
      body: bodyStr,
      service: "mq",
      credentials: rctx.creds,
    });
    const result = (await res.json()) as Record<string, unknown>;
    const brokerId = String(result["BrokerId"] ?? "");
    return {
      id: ctx.makeId(accountId, "mq-broker", brokerId),
      pluginId: "aws",
      resourceTypeId: "mq-broker",
      accountId,
      displayName: brokerName,
      fields: {
        brokerName,
        region,
        brokerId,
        engineType: fields["engineType"] ?? "RABBITMQ",
        engineVersion: fields["engineType"] === "ACTIVEMQ" ? "5.19" : "3.13",
        hostInstanceType: fields["hostInstanceType"] ?? "mq.t3.micro",
        deploymentMode: fields["deploymentMode"] ?? "SINGLE_INSTANCE",
        status: "CREATION_IN_PROGRESS",
      },
      resolvedOutputs: {
        brokerArn: String(result["BrokerArn"] ?? ""),
        consoleUrl: "",
      },
      secretStates: [],
      externalId: brokerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}
