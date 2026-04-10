import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
} from "@infrawrench/plugin-base";
import { signRequest, parseXml, ensureArray } from "./auth.js";
import type { AwsCredentials } from "./auth.js";
import type { ListerContext } from "./resource-listers.js";
import {
  listEC2Instances,
  listEBSVolumes,
  listVPCs,
  listEKSClusters,
  listRDSInstances,
  listS3Buckets,
  listLambdaFunctions,
  listECSServices,
  listDynamoDBTables,
  listElastiCacheClusters,
  listSQSQueues,
  listSNSTopics,
  listECRRepositories,
  listSecretsManagerSecrets,
  listCloudFrontDistributions,
  listIAMUsers,
} from "./resource-listers.js";

const SERVICE_HOSTS: Record<string, string> = {
  ec2: "ec2.{region}.amazonaws.com",
  s3: "s3.{region}.amazonaws.com",
  rds: "rds.{region}.amazonaws.com",
  lambda: "lambda.{region}.amazonaws.com",
  ecs: "ecs.{region}.amazonaws.com",
  eks: "eks.{region}.amazonaws.com",
  dynamodb: "dynamodb.{region}.amazonaws.com",
  elasticache: "elasticache.{region}.amazonaws.com",
  sqs: "sqs.{region}.amazonaws.com",
  sns: "sns.{region}.amazonaws.com",
  ecr: "api.ecr.{region}.amazonaws.com",
  secretsmanager: "secretsmanager.{region}.amazonaws.com",
  cloudfront: "cloudfront.amazonaws.com",
  iam: "iam.amazonaws.com",
};

// Services that are global (no region in hostname)
const GLOBAL_SERVICES = new Set(["cloudfront", "iam"]);

export class AWSClient implements PluginClient {
  private readonly creds: AwsCredentials;

  constructor(credentials: Record<string, string>) {
    const accessKeyId = credentials["accessKeyId"];
    const secretAccessKey = credentials["secretAccessKey"];
    const region = credentials["region"] ?? "us-east-1";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS plugin: missing accessKeyId or secretAccessKey");
    }
    this.creds = { accessKeyId, secretAccessKey, region };
  }

  private hostForService(service: string): string {
    const template = SERVICE_HOSTS[service] ?? `${service}.${this.creds.region}.amazonaws.com`;
    return template.replace("{region}", this.creds.region);
  }

  /** Make an EC2-style XML query API call */
  private async ec2<T>(action: string, params?: Record<string, string>): Promise<T> {
    const host = this.hostForService("ec2");
    const searchParams = new URLSearchParams({
      Action: action,
      Version: "2016-11-15",
      ...params,
    });
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: "ec2",
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`EC2 ${action} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** Make a JSON API call (DynamoDB, ECS, etc.) */
  private async json<T>(service: string, target: string, body: Record<string, unknown>): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}/`;
    const bodyStr = JSON.stringify(body);
    const headers = await signRequest({
      method: "POST",
      url,
      headers: {
        Host: host,
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": target,
      },
      body: bodyStr,
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`${service} ${target} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** Make a JSON REST GET call (Lambda, EKS, CloudFront) */
  private async jsonGet<T>(service: string, path: string): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}${path}`;
    const svc = GLOBAL_SERVICES.has(service) ? service : service;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: svc,
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${service} GET ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private makeId(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private get ctx(): ListerContext {
    return {
      ec2: <T>(action: string, params?: Record<string, string>) => this.ec2<T>(action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) => this.json<T>(service, target, body),
      jsonGet: <T>(service: string, path: string) => this.jsonGet<T>(service, path),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      region: this.creds.region,
    };
  }

  private static readonly LISTERS: Record<string, (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>> = {
    "ec2-instance": listEC2Instances,
    "ebs-volume": listEBSVolumes,
    "vpc": listVPCs,
    "eks-cluster": listEKSClusters,
    "rds-instance": listRDSInstances,
    "s3-bucket": listS3Buckets,
    "lambda-function": listLambdaFunctions,
    "ecs-service": listECSServices,
    "dynamodb-table": listDynamoDBTables,
    "elasticache-cluster": listElastiCacheClusters,
    "sqs-queue": listSQSQueues,
    "sns-topic": listSNSTopics,
    "ecr-repository": listECRRepositories,
    "secrets-manager-secret": listSecretsManagerSecrets,
    "cloudfront-distribution": listCloudFrontDistributions,
    "iam-user": listIAMUsers,
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = AWSClient.LISTERS[typeId];
    if (!lister) throw new Error(`AWS plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`AWS plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(`AWS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    }
    return String(value);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? fields["status"] ?? "");

    const statusMap: Record<string, ResourceStatus> = {
      running: "healthy",
      active: "healthy",
      "in-use": "healthy",
      available: "healthy",
      stopped: "degraded",
      stopping: "degraded",
      pending: "provisioning",
      creating: "provisioning",
      "shutting-down": "error",
      terminated: "error",
      deleting: "error",
      failed: "error",
    };
    const dotStatus = statusMap[state.toLowerCase()] ?? "unknown";

    return {
      title: resource.displayName,
      subtitle: `${resource.resourceTypeId} \u00B7 ${this.creds.region}`,
      status: state
        ? { kind: "status-dot", status: dotStatus, label: state }
        : { kind: "status-dot", status: dotStatus },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
        ...(Object.keys(resource.resolvedOutputs).length > 0
          ? [
              {
                kind: "section" as const,
                title: "Outputs",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: Object.entries(resource.resolvedOutputs).map(([key, value]) => ({
                      key,
                      value: String(value),
                      copyable: true,
                    })),
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
    const statusMap: Record<string, ResourceStatus> = {
      running: "healthy",
      active: "healthy",
      available: "healthy",
      "in-use": "healthy",
      stopped: "degraded",
      terminated: "error",
    };
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: statusMap[state.toLowerCase()] ?? "unknown" },
    };
  }
}
