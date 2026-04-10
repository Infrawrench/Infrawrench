// ─── Resource listing functions ─────────────────────────────────────────────
//
// Each function corresponds to an AWS resource type and returns ResourceInstance[].
// They receive a context object with helpers from the AWSClient.

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "./auth.js";

export interface ListerContext {
  ec2<T>(action: string, params?: Record<string, string>): Promise<T>;
  json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T>;
  jsonGet<T>(service: string, path: string): Promise<T>;
  /** Make an XML Query API call for non-EC2 services (ELBv2, AutoScaling, Redshift, CloudFormation) */
  ec2Query<T>(service: string, action: string, version: string, params?: Record<string, string>): Promise<T>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  region: string;
}

// ─── EC2 Instances ──────────────────────────────────────────────────────────

export async function listEC2Instances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeInstances");
  const reservations = ensureArray(
    (data["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  const results: ResourceInstance[] = [];
  for (const reservation of reservations) {
    const instances = ensureArray(
      (reservation["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];

    for (const inst of instances) {
      const instanceId = String(inst["instanceId"] ?? "");
      const state = String(
        (inst["instanceState"] as Record<string, unknown> | undefined)?.["name"] ?? "",
      );

      // Extract Name tag
      const tagSet = inst["tagSet"] as Record<string, unknown> | undefined;
      const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
      const nameTag = tags.find((t) => t["key"] === "Name");
      const name = nameTag ? String(nameTag["value"] ?? "") : "";

      // Network info
      const publicIp = String(inst["ipAddress"] ?? "");
      const privateIp = String(inst["privateIpAddress"] ?? "");
      const publicDns = String(inst["dnsName"] ?? "");

      results.push({
        id: ctx.id(accountId, "ec2-instance", instanceId),
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        accountId,
        displayName: name || instanceId,
        fields: {
          name,
          instanceId,
          instanceType: String(inst["instanceType"] ?? ""),
          availabilityZone: String(
            (inst["placement"] as Record<string, unknown> | undefined)?.["availabilityZone"] ?? "",
          ),
          state,
          imageId: String(inst["imageId"] ?? ""),
          vpcId: String(inst["vpcId"] ?? ""),
          subnetId: String(inst["subnetId"] ?? ""),
        },
        resolvedOutputs: { publicIp, privateIp, publicDns },
        secretStates: [],
        externalId: instanceId,
        createdAt: String(inst["launchTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

// ─── EBS Volumes ────────────────────────────────────────────────────────────

export async function listEBSVolumes(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeVolumes");
  const volumes = ensureArray(
    (data["volumeSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return volumes.map((vol) => {
    const volumeId = String(vol["volumeId"] ?? "");
    const attachments = ensureArray(
      (vol["attachmentSet"] as Record<string, unknown> | undefined)?.["item"],
    ) as Record<string, unknown>[];
    const attachedTo = attachments[0] ? String(attachments[0]["instanceId"] ?? "") : "";

    // Extract Name tag
    const tagSet = vol["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";

    return {
      id: ctx.id(accountId, "ebs-volume", volumeId),
      pluginId: "aws",
      resourceTypeId: "ebs-volume",
      accountId,
      displayName: name || volumeId,
      fields: {
        volumeId,
        availabilityZone: String(vol["availabilityZone"] ?? ""),
        sizeGb: Number(vol["size"] ?? 0),
        volumeType: String(vol["volumeType"] ?? ""),
        state: String(vol["status"] ?? ""),
        encrypted: String(vol["encrypted"]) === "true",
        attachedTo,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: volumeId,
      createdAt: String(vol["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── VPCs ───────────────────────────────────────────────────────────────────

export async function listVPCs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2<Record<string, unknown>>("DescribeVpcs");
  const vpcs = ensureArray(
    (data["vpcSet"] as Record<string, unknown> | undefined)?.["item"],
  ) as Record<string, unknown>[];

  return vpcs.map((vpc) => {
    const vpcId = String(vpc["vpcId"] ?? "");
    const tagSet = vpc["tagSet"] as Record<string, unknown> | undefined;
    const tags = ensureArray(tagSet?.["item"]) as Record<string, unknown>[];
    const nameTag = tags.find((t) => t["key"] === "Name");
    const name = nameTag ? String(nameTag["value"] ?? "") : "";

    return {
      id: ctx.id(accountId, "vpc", vpcId),
      pluginId: "aws",
      resourceTypeId: "vpc",
      accountId,
      displayName: name || vpcId,
      fields: {
        vpcId,
        name,
        cidrBlock: String(vpc["cidrBlock"] ?? ""),
        state: String(vpc["state"] ?? ""),
        isDefault: String(vpc["isDefault"]) === "true",
        tenancy: String(vpc["instanceTenancy"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: vpcId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

// ─── EKS Clusters ───────────────────────────────────────────────────────────

export async function listEKSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.jsonGet<{ clusters?: string[] }>(
    "eks",
    "/clusters",
  );
  const clusterNames = listData.clusters ?? [];
  const results: ResourceInstance[] = [];

  for (const name of clusterNames) {
    try {
      const detail = await ctx.jsonGet<{ cluster: Record<string, unknown> }>(
        "eks",
        `/clusters/${encodeURIComponent(name)}`,
      );
      const c = detail.cluster;
      const endpoint = String(c["endpoint"] ?? "");
      const caData = String(
        (c["certificateAuthority"] as Record<string, unknown> | undefined)?.["data"] ?? "",
      );
      // Generate a kubeconfig YAML for kubectl access
      const kubeconfig = [
        "apiVersion: v1",
        "kind: Config",
        "clusters:",
        `- name: ${name}`,
        "  cluster:",
        `    server: ${endpoint}`,
        `    certificate-authority-data: ${caData}`,
        "contexts:",
        `- name: ${name}`,
        "  context:",
        `    cluster: ${name}`,
        `    user: ${name}`,
        "current-context: " + name,
        "users:",
        `- name: ${name}`,
        "  user:",
        "    exec:",
        "      apiVersion: client.authentication.k8s.io/v1beta1",
        "      command: aws",
        "      args:",
        "        - eks",
        "        - get-token",
        "        - --cluster-name",
        `        - ${name}`,
        `        - --region`,
        `        - ${ctx.region}`,
      ].join("\n");

      results.push({
        id: ctx.id(accountId, "eks-cluster", name),
        pluginId: "aws",
        resourceTypeId: "eks-cluster",
        accountId,
        displayName: name,
        fields: {
          name,
          version: String(c["version"] ?? ""),
          status: String(c["status"] ?? ""),
          platformVersion: String(c["platformVersion"] ?? ""),
          roleArn: String(c["roleArn"] ?? ""),
        },
        resolvedOutputs: {
          endpoint,
          certificateAuthority: caData,
          kubeconfig,
        },
        secretStates: [],
        externalId: name,
        createdAt: String(c["createdAt"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip clusters we can't describe (permission issues)
    }
  }
  return results;
}

// ─── RDS Instances ──────────────────────────────────────────────────────────

export async function listRDSInstances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ DBInstances?: Record<string, unknown>[] }>(
    "rds",
    "AmazonRDSv19.DescribeDBInstances",
    {},
  );
  const instances = data.DBInstances ?? [];
  return instances.map((db) => {
    const dbId = String(db["DBInstanceIdentifier"] ?? "");
    const endpoint = db["Endpoint"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "rds-instance", dbId),
      pluginId: "aws",
      resourceTypeId: "rds-instance",
      accountId,
      displayName: dbId,
      fields: {
        dbInstanceId: dbId,
        engine: String(db["Engine"] ?? ""),
        engineVersion: String(db["EngineVersion"] ?? ""),
        instanceClass: String(db["DBInstanceClass"] ?? ""),
        status: String(db["DBInstanceStatus"] ?? ""),
        allocatedStorage: Number(db["AllocatedStorage"] ?? 0),
        availabilityZone: String(db["AvailabilityZone"] ?? ""),
        multiAZ: db["MultiAZ"] === true,
      },
      resolvedOutputs: {
        endpoint: String(endpoint?.["Address"] ?? ""),
        port: String(endpoint?.["Port"] ?? ""),
        masterUsername: String(db["MasterUsername"] ?? ""),
      },
      secretStates: [],
      externalId: dbId,
      createdAt: String(db["InstanceCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── S3 Buckets ─────────────────────────────────────────────────────────────

export async function listS3Buckets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // S3 ListBuckets uses XML REST — we use the global s3 endpoint
  const data = await ctx.json<{ Buckets?: Array<{ Name: string; CreationDate: string }> }>(
    "s3",
    "AmazonS3.ListBuckets",
    {},
  );
  // Fallback: S3 ListBuckets may not support JSON target on all endpoints
  // Try XML approach through the client's s3List method
  const buckets = data.Buckets ?? [];
  return buckets.map((b) => {
    const name = b.Name ?? "";
    return {
      id: ctx.id(accountId, "s3-bucket", name),
      pluginId: "aws",
      resourceTypeId: "s3-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        creationDate: b.CreationDate ?? "",
      },
      resolvedOutputs: {
        bucketArn: `arn:aws:s3:::${name}`,
        endpoint: `https://${name}.s3.${ctx.region}.amazonaws.com`,
      },
      secretStates: [],
      externalId: name,
      createdAt: b.CreationDate ?? ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

// ─── Lambda Functions ───────────────────────────────────────────────────────

export async function listLambdaFunctions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{ Functions?: Record<string, unknown>[] }>(
    "lambda",
    "/2015-03-31/functions",
  );
  const functions = data.Functions ?? [];
  return functions.map((fn) => {
    const name = String(fn["FunctionName"] ?? "");
    return {
      id: ctx.id(accountId, "lambda-function", name),
      pluginId: "aws",
      resourceTypeId: "lambda-function",
      accountId,
      displayName: name,
      fields: {
        name,
        runtime: String(fn["Runtime"] ?? ""),
        handler: String(fn["Handler"] ?? ""),
        codeSize: Number(fn["CodeSize"] ?? 0),
        memorySize: Number(fn["MemorySize"] ?? 0),
        timeout: Number(fn["Timeout"] ?? 0),
        state: String(fn["State"] ?? fn["LastUpdateStatus"] ?? "Active"),
        lastModified: String(fn["LastModified"] ?? ""),
      },
      resolvedOutputs: {
        functionArn: String(fn["FunctionArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(fn["LastModified"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── ECS Services ───────────────────────────────────────────────────────────

export async function listECSServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // First list clusters, then list services in each cluster
  const clustersData = await ctx.json<{ clusterArns?: string[] }>(
    "ecs",
    "AmazonEC2ContainerServiceV20141113.ListClusters",
    {},
  );
  const clusterArns = clustersData.clusterArns ?? [];
  const results: ResourceInstance[] = [];

  for (const clusterArn of clusterArns) {
    const clusterName = clusterArn.split("/").pop() ?? clusterArn;
    try {
      const servicesListData = await ctx.json<{ serviceArns?: string[] }>(
        "ecs",
        "AmazonEC2ContainerServiceV20141113.ListServices",
        { cluster: clusterArn },
      );
      const serviceArns = servicesListData.serviceArns ?? [];
      if (serviceArns.length === 0) continue;

      const servicesData = await ctx.json<{ services?: Record<string, unknown>[] }>(
        "ecs",
        "AmazonEC2ContainerServiceV20141113.DescribeServices",
        { cluster: clusterArn, services: serviceArns },
      );

      for (const svc of servicesData.services ?? []) {
        const serviceName = String(svc["serviceName"] ?? "");
        const serviceArn = String(svc["serviceArn"] ?? "");
        results.push({
          id: ctx.id(accountId, "ecs-service", `${clusterName}/${serviceName}`),
          pluginId: "aws",
          resourceTypeId: "ecs-service",
          accountId,
          displayName: serviceName,
          fields: {
            serviceName,
            clusterName,
            status: String(svc["status"] ?? ""),
            launchType: String(svc["launchType"] ?? ""),
            desiredCount: Number(svc["desiredCount"] ?? 0),
            runningCount: Number(svc["runningCount"] ?? 0),
            taskDefinition: String(svc["taskDefinition"] ?? "").split("/").pop() ?? "",
          },
          resolvedOutputs: { serviceArn },
          secretStates: [],
          externalId: `${clusterName}/${serviceName}`,
          createdAt: String(svc["createdAt"] ?? ctx.now()),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip clusters we can't access
    }
  }
  return results;
}

// ─── DynamoDB Tables ────────────────────────────────────────────────────────

export async function listDynamoDBTables(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const listData = await ctx.json<{ TableNames?: string[] }>(
    "dynamodb",
    "DynamoDB_20120810.ListTables",
    {},
  );
  const tableNames = listData.TableNames ?? [];
  const results: ResourceInstance[] = [];

  for (const tableName of tableNames) {
    try {
      const detail = await ctx.json<{ Table: Record<string, unknown> }>(
        "dynamodb",
        "DynamoDB_20120810.DescribeTable",
        { TableName: tableName },
      );
      const t = detail.Table;
      const keySchema = t["KeySchema"] as Array<Record<string, string>> | undefined;
      const partitionKey = keySchema?.find((k) => k["KeyType"] === "HASH")?.["AttributeName"] ?? "";
      const sortKey = keySchema?.find((k) => k["KeyType"] === "RANGE")?.["AttributeName"] ?? "";
      const billingMode = String(
        (t["BillingModeSummary"] as Record<string, unknown> | undefined)?.["BillingMode"] ?? "PROVISIONED",
      );

      results.push({
        id: ctx.id(accountId, "dynamodb-table", tableName),
        pluginId: "aws",
        resourceTypeId: "dynamodb-table",
        accountId,
        displayName: tableName,
        fields: {
          tableName,
          status: String(t["TableStatus"] ?? ""),
          itemCount: Number(t["ItemCount"] ?? 0),
          sizeBytes: Number(t["TableSizeBytes"] ?? 0),
          billingMode,
          partitionKey,
          ...(sortKey ? { sortKey } : {}),
        },
        resolvedOutputs: {
          tableArn: String(t["TableArn"] ?? ""),
        },
        secretStates: [],
        externalId: tableName,
        createdAt: String(t["CreationDateTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip tables we can't describe
    }
  }
  return results;
}

// ─── ElastiCache Clusters ───────────────────────────────────────────────────

export async function listElastiCacheClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ CacheClusters?: Record<string, unknown>[] }>(
    "elasticache",
    "AmazonElastiCacheV9.DescribeCacheClusters",
    { ShowCacheNodeInfo: true },
  );
  const clusters = data.CacheClusters ?? [];
  return clusters.map((c) => {
    const clusterId = String(c["CacheClusterId"] ?? "");
    const nodes = c["CacheNodes"] as Array<Record<string, unknown>> | undefined;
    const endpoint = nodes?.[0]?.["Endpoint"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "elasticache-cluster", clusterId),
      pluginId: "aws",
      resourceTypeId: "elasticache-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        clusterId,
        engine: String(c["Engine"] ?? ""),
        engineVersion: String(c["EngineVersion"] ?? ""),
        nodeType: String(c["CacheNodeType"] ?? ""),
        numNodes: Number(c["NumCacheNodes"] ?? 0),
        status: String(c["CacheClusterStatus"] ?? ""),
        availabilityZone: String(c["PreferredAvailabilityZone"] ?? ""),
      },
      resolvedOutputs: {
        endpoint: String(endpoint?.["Address"] ?? ""),
        port: String(endpoint?.["Port"] ?? ""),
      },
      secretStates: [],
      externalId: clusterId,
      createdAt: String(c["CacheClusterCreateTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── SQS Queues ─────────────────────────────────────────────────────────────

export async function listSQSQueues(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ QueueUrls?: string[] }>(
    "sqs",
    "AmazonSQS.ListQueues",
    {},
  );
  const queueUrls = data.QueueUrls ?? [];
  const results: ResourceInstance[] = [];

  for (const queueUrl of queueUrls) {
    try {
      const attrs = await ctx.json<{ Attributes?: Record<string, string> }>(
        "sqs",
        "AmazonSQS.GetQueueAttributes",
        {
          QueueUrl: queueUrl,
          AttributeNames: ["All"],
        },
      );
      const a = attrs.Attributes ?? {};
      const queueName = queueUrl.split("/").pop() ?? queueUrl;

      results.push({
        id: ctx.id(accountId, "sqs-queue", queueName),
        pluginId: "aws",
        resourceTypeId: "sqs-queue",
        accountId,
        displayName: queueName,
        fields: {
          queueName,
          queueUrl,
          approximateMessages: Number(a["ApproximateNumberOfMessages"] ?? 0),
          approximateMessagesDelayed: Number(a["ApproximateNumberOfMessagesDelayed"] ?? 0),
          approximateMessagesNotVisible: Number(a["ApproximateNumberOfMessagesNotVisible"] ?? 0),
          isFifo: queueName.endsWith(".fifo"),
        },
        resolvedOutputs: {
          queueArn: a["QueueArn"] ?? "",
        },
        secretStates: [],
        externalId: queueName,
        createdAt: String(a["CreatedTimestamp"] ? new Date(Number(a["CreatedTimestamp"]) * 1000).toISOString() : ctx.now()),
        updatedAt: ctx.now(),
      });
    } catch {
      // Skip queues we can't describe
    }
  }
  return results;
}

// ─── SNS Topics ─────────────────────────────────────────────────────────────

export async function listSNSTopics(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Topics?: Array<{ TopicArn: string }> }>(
    "sns",
    "SNS.ListTopics",
    {},
  );
  const topics = data.Topics ?? [];
  const results: ResourceInstance[] = [];

  for (const topic of topics) {
    const topicArn = topic.TopicArn;
    const topicName = topicArn.split(":").pop() ?? topicArn;
    try {
      const attrs = await ctx.json<{ Attributes?: Record<string, string> }>(
        "sns",
        "SNS.GetTopicAttributes",
        { TopicArn: topicArn },
      );
      const a = attrs.Attributes ?? {};
      results.push({
        id: ctx.id(accountId, "sns-topic", topicName),
        pluginId: "aws",
        resourceTypeId: "sns-topic",
        accountId,
        displayName: topicName,
        fields: {
          topicName,
          topicArn,
          subscriptionCount: Number(a["SubscriptionsConfirmed"] ?? 0),
          isFifo: topicName.endsWith(".fifo"),
        },
        resolvedOutputs: { topicArn },
        secretStates: [],
        externalId: topicName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    } catch {
      results.push({
        id: ctx.id(accountId, "sns-topic", topicName),
        pluginId: "aws",
        resourceTypeId: "sns-topic",
        accountId,
        displayName: topicName,
        fields: { topicName, topicArn, subscriptionCount: 0, isFifo: topicName.endsWith(".fifo") },
        resolvedOutputs: { topicArn },
        secretStates: [],
        externalId: topicName,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return results;
}

// ─── ECR Repositories ───────────────────────────────────────────────────────

export async function listECRRepositories(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ repositories?: Record<string, unknown>[] }>(
    "ecr",
    "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
    {},
  );
  const repos = data.repositories ?? [];
  return repos.map((repo) => {
    const name = String(repo["repositoryName"] ?? "");
    return {
      id: ctx.id(accountId, "ecr-repository", name),
      pluginId: "aws",
      resourceTypeId: "ecr-repository",
      accountId,
      displayName: name,
      fields: {
        repositoryName: name,
        registryId: String(repo["registryId"] ?? ""),
        imageCount: 0, // Would need a separate DescribeImages call
        imageScanOnPush: (repo["imageScanningConfiguration"] as Record<string, unknown> | undefined)?.["scanOnPush"] === true,
        encryptionType: String(
          (repo["encryptionConfiguration"] as Record<string, unknown> | undefined)?.["encryptionType"] ?? "AES256",
        ),
      },
      resolvedOutputs: {
        repositoryUri: String(repo["repositoryUri"] ?? ""),
        repositoryArn: String(repo["repositoryArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(repo["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── Secrets Manager Secrets ────────────────────────────────────────────────

export async function listSecretsManagerSecrets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ SecretList?: Record<string, unknown>[] }>(
    "secretsmanager",
    "secretsmanager.ListSecrets",
    {},
  );
  const secrets = data.SecretList ?? [];
  return secrets.map((s) => {
    const name = String(s["Name"] ?? "");
    return {
      id: ctx.id(accountId, "secrets-manager-secret", name),
      pluginId: "aws",
      resourceTypeId: "secrets-manager-secret",
      accountId,
      displayName: name,
      fields: {
        name,
        description: String(s["Description"] ?? ""),
        lastAccessedDate: String(s["LastAccessedDate"] ?? ""),
        lastChangedDate: String(s["LastChangedDate"] ?? ""),
        rotationEnabled: s["RotationEnabled"] === true,
      },
      resolvedOutputs: {
        secretArn: String(s["ARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(s["CreatedDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── CloudFront Distributions ───────────────────────────────────────────────

export async function listCloudFrontDistributions(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    DistributionList?: { Items?: Record<string, unknown>[] };
  }>("cloudfront", "/2020-05-31/distribution");

  const items = data.DistributionList?.Items ?? [];
  return items.map((dist) => {
    const distId = String(dist["Id"] ?? "");
    return {
      id: ctx.id(accountId, "cloudfront-distribution", distId),
      pluginId: "aws",
      resourceTypeId: "cloudfront-distribution",
      accountId,
      displayName: String(dist["Comment"] ?? "") || distId,
      fields: {
        distributionId: distId,
        domainName: String(dist["DomainName"] ?? ""),
        status: String(dist["Status"] ?? ""),
        enabled: dist["Enabled"] === true || dist["Enabled"] === "true",
        comment: String(dist["Comment"] ?? ""),
        priceClass: String(dist["PriceClass"] ?? ""),
        httpVersion: String(dist["HttpVersion"] ?? ""),
      },
      resolvedOutputs: {
        distributionArn: String(dist["ARN"] ?? ""),
      },
      secretStates: [],
      externalId: distId,
      createdAt: String(dist["LastModifiedTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

// ─── IAM Users ──────────────────────────────────────────────────────────────

export async function listIAMUsers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Users?: Record<string, unknown>[] }>(
    "iam",
    "AWSIdentityManagementService.ListUsers",
    {},
  );
  const users = data.Users ?? [];
  return users.map((u) => {
    const userName = String(u["UserName"] ?? "");
    return {
      id: ctx.id(accountId, "iam-user", userName),
      pluginId: "aws",
      resourceTypeId: "iam-user",
      accountId,
      displayName: userName,
      fields: {
        userName,
        userId: String(u["UserId"] ?? ""),
        path: String(u["Path"] ?? "/"),
        createDate: String(u["CreateDate"] ?? ""),
        passwordLastUsed: String(u["PasswordLastUsed"] ?? ""),
      },
      resolvedOutputs: {
        userArn: String(u["Arn"] ?? ""),
      },
      secretStates: [],
      externalId: userName,
      createdAt: String(u["CreateDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
