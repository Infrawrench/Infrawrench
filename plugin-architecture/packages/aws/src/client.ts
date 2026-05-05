import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  ResourceStatus,
  ResourceTypeDefinition,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  PolicyOption,
  DashboardStat,
  MetricSeries,
  CredentialExport,
} from "@infrawrench/plugin-base";
import {
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  dnsZoneStatus,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
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
import {
  listRoute53HostedZones,
  listRoute53RecordSets,
  listALBs,
  listTargetGroups,
  listAutoScalingGroups,
  listIAMRoles,
  listSecurityGroups,
  listSubnets,
  listNATGateways,
  listElasticIPs,
  listStepFunctions,
  listEventBridgeRules,
  listKinesisStreams,
  listRedshiftClusters,
  listRDSClusters,
  listOpenSearchDomains,
  listACMCertificates,
  listWAFWebACLs,
  listCodeBuildProjects,
  listCodePipelines,
  listCloudFormationStacks,
  listSSMParameters,
  listEFSFileSystems,
  listAPIGateways,
  listCloudWatchAlarms,
  listCloudWatchLogGroups,
  listAppRunnerServices,
  listGlueDatabases,
  listInternetGateways,
  listCloudTrailTrails,
  listMSKClusters,
  listNeptuneClusters,
  listDocumentDBClusters,
  listMQBrokers,
  listBatchJobQueues,
  listSageMakerEndpoints,
} from "./resource-listers-extended.js";
import type { AwsCreateContext } from "./create-handlers.js";
import { awsGetCreateConfig, awsCreateResource } from "./create-handlers.js";
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
  route53: "route53.amazonaws.com",
  elasticloadbalancing: "elasticloadbalancing.{region}.amazonaws.com",
  autoscaling: "autoscaling.{region}.amazonaws.com",
  states: "states.{region}.amazonaws.com",
  events: "events.{region}.amazonaws.com",
  kinesis: "kinesis.{region}.amazonaws.com",
  redshift: "redshift.{region}.amazonaws.com",
  es: "es.{region}.amazonaws.com",
  acm: "acm.{region}.amazonaws.com",
  wafv2: "wafv2.{region}.amazonaws.com",
  codebuild: "codebuild.{region}.amazonaws.com",
  codepipeline: "codepipeline.{region}.amazonaws.com",
  cloudformation: "cloudformation.{region}.amazonaws.com",
  ssm: "ssm.{region}.amazonaws.com",
  elasticfilesystem: "elasticfilesystem.{region}.amazonaws.com",
  apigateway: "apigateway.{region}.amazonaws.com",
  monitoring: "monitoring.{region}.amazonaws.com",
  logs: "logs.{region}.amazonaws.com",
  apprunner: "apprunner.{region}.amazonaws.com",
  glue: "glue.{region}.amazonaws.com",
  kafka: "kafka.{region}.amazonaws.com",
  cloudtrail: "cloudtrail.{region}.amazonaws.com",
  mq: "mq.{region}.amazonaws.com",
  batch: "batch.{region}.amazonaws.com",
  sagemaker: "api.sagemaker.{region}.amazonaws.com",
  neptune: "rds.{region}.amazonaws.com",
};

// Services that are global (no region in hostname)
const GLOBAL_SERVICES = new Set(["cloudfront", "iam", "route53"]);

export class AWSClient implements PluginClient {
  private readonly creds: AwsCredentials;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(credentials: Record<string, string>, resourceTypes: ResourceTypeDefinition[] = []) {
    this.resourceTypes = resourceTypes;
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
  private async json<T>(
    service: string,
    target: string,
    body: Record<string, unknown>,
  ): Promise<T> {
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

  /** Make an XML Query API call for non-EC2 services */
  private async ec2Query<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const host = this.hostForService(service);
    const searchParams = new URLSearchParams({
      Action: action,
      Version: version,
      ...params,
    });
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${service} ${action} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** Make a Query API POST call for mutations (Create/Delete on RDS, IAM, etc.) */
  private async queryPost<T>(
    service: string,
    action: string,
    version: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}/`;
    const bodyParams = new URLSearchParams({
      Action: action,
      Version: version,
      ...params,
    });
    const bodyStr = bodyParams.toString();
    const headers = await signRequest({
      method: "POST",
      url,
      headers: {
        Host: host,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyStr,
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "POST", headers, body: bodyStr });
    if (!res.ok) throw new Error(`${service} ${action} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** Make a signed XML GET request to a service path (e.g. S3 ListBuckets) */
  private async xmlGet<T>(service: string, path: string = "/"): Promise<T> {
    const host = this.hostForService(service);
    const url = `https://${host}${path}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service,
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${service} GET ${path} failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
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

  /**
   * Paginate IAM ListPolicies for a given scope ("AWS" | "Local" | "All").
   * Returns a flat list of policy objects (Arn, PolicyName, Description, Path).
   */
  private async listAllIAMPolicies(
    scope: "AWS" | "Local" | "All",
  ): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    let marker: string | undefined;
    for (let i = 0; i < 20; i++) {
      const params: Record<string, string> = { Scope: scope, MaxItems: "1000" };
      if (marker) params["Marker"] = marker;
      const data = await this.ec2Query<Record<string, unknown>>(
        "iam",
        "ListPolicies",
        "2010-05-08",
        params,
      );
      const result = data["ListPoliciesResult"] as Record<string, unknown> | undefined;
      const policies = ensureArray(
        (result?.["Policies"] as Record<string, unknown> | undefined)?.["member"],
      ) as Array<Record<string, unknown>>;
      all.push(...policies);
      const truncated = String(result?.["IsTruncated"] ?? "false") === "true";
      if (!truncated) break;
      marker = result?.["Marker"] ? String(result["Marker"]) : undefined;
      if (!marker) break;
    }
    return all;
  }

  /** Convert IAM ListPolicies output into PolicyOption[] sorted by label. */
  private policiesToOptions(raw: Array<Record<string, unknown>>, category: string): PolicyOption[] {
    const options: PolicyOption[] = raw
      .map((p) => {
        const arn = String(p["Arn"] ?? "");
        const name = String(p["PolicyName"] ?? arn);
        const option: PolicyOption = { id: arn, label: name, category };
        if (p["Description"]) option.description = String(p["Description"]);
        return option;
      })
      .filter((o) => o.id.length > 0);
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }

  private get ctx(): ListerContext {
    return {
      ec2: <T>(action: string, params?: Record<string, string>) => this.ec2<T>(action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) =>
        this.json<T>(service, target, body),
      jsonGet: <T>(service: string, path: string) => this.jsonGet<T>(service, path),
      ec2Query: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => this.ec2Query<T>(service, action, version, params),
      xmlGet: <T>(service: string, path?: string) => this.xmlGet<T>(service, path),
      id: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      now: () => new Date().toISOString(),
      region: this.creds.region,
    };
  }

  private get createCtx(): AwsCreateContext {
    return {
      creds: this.creds,
      hostForService: (s) => this.hostForService(s),
      ec2: <T>(action: string, params?: Record<string, string>) => this.ec2<T>(action, params),
      json: <T>(service: string, target: string, body: Record<string, unknown>) =>
        this.json<T>(service, target, body),
      ec2Query: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => this.ec2Query<T>(service, action, version, params),
      queryPost: <T>(
        service: string,
        action: string,
        version: string,
        params?: Record<string, string>,
      ) => this.queryPost<T>(service, action, version, params),
      xmlGet: <T>(service: string, path?: string) => this.xmlGet<T>(service, path),
      makeId: (accountId, typeId, externalId) => this.makeId(accountId, typeId, externalId),
      listAllIAMPolicies: (scope) => this.listAllIAMPolicies(scope),
      policiesToOptions: (raw, category) => this.policiesToOptions(raw, category),
      getResource: (typeId, resourceId, accountId) =>
        this.getResource(typeId, resourceId, accountId),
    };
  }

  private static readonly LISTERS: Record<
    string,
    (ctx: ListerContext, accountId: string) => Promise<ResourceInstance[]>
  > = {
    "ec2-instance": listEC2Instances,
    "ebs-volume": listEBSVolumes,
    vpc: listVPCs,
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
    "route53-hosted-zone": listRoute53HostedZones,
    "route53-record-set": listRoute53RecordSets,
    alb: listALBs,
    "target-group": listTargetGroups,
    "auto-scaling-group": listAutoScalingGroups,
    "iam-role": listIAMRoles,
    "security-group": listSecurityGroups,
    subnet: listSubnets,
    "nat-gateway": listNATGateways,
    "elastic-ip": listElasticIPs,
    "step-function": listStepFunctions,
    "eventbridge-rule": listEventBridgeRules,
    "kinesis-stream": listKinesisStreams,
    "redshift-cluster": listRedshiftClusters,
    "rds-cluster": listRDSClusters,
    "opensearch-domain": listOpenSearchDomains,
    "acm-certificate": listACMCertificates,
    "waf-web-acl": listWAFWebACLs,
    "codebuild-project": listCodeBuildProjects,
    "codepipeline-pipeline": listCodePipelines,
    "cloudformation-stack": listCloudFormationStacks,
    "ssm-parameter": listSSMParameters,
    "efs-file-system": listEFSFileSystems,
    "api-gateway": listAPIGateways,
    "cloudwatch-alarm": listCloudWatchAlarms,
    "cloudwatch-log-group": listCloudWatchLogGroups,
    "apprunner-service": listAppRunnerServices,
    "glue-database": listGlueDatabases,
    "internet-gateway": listInternetGateways,
    "cloudtrail-trail": listCloudTrailTrails,
    "msk-cluster": listMSKClusters,
    "neptune-cluster": listNeptuneClusters,
    "documentdb-cluster": listDocumentDBClusters,
    "mq-broker": listMQBrokers,
    "batch-job-queue": listBatchJobQueues,
    "sagemaker-endpoint": listSageMakerEndpoints,
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = AWSClient.LISTERS[typeId];
    if (!lister) throw new Error(`AWS plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`AWS plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  // Attach Elastic IP to EC2 Instance (minimal implementation)
  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "elastic-ip" && targetTypeId === "ec2-instance") {
      const [ipResource, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const allocationId = String(
        ipResource.fields["allocationId"] ?? ipResource.resolvedOutputs["allocationId"] ?? "",
      );
      const instanceId = String(
        instance.fields["instanceId"] ?? instance.resolvedOutputs["instanceId"] ?? "",
      );
      if (!allocationId || !instanceId) {
        throw new Error("Cannot determine AllocationId or InstanceId for attachment");
      }
      // Associate the Elastic IP with the EC2 instance
      await this.ec2<unknown>("AssociateAddress", {
        AllocationId: allocationId,
        InstanceId: instanceId,
      });
      return;
    }
    if (sourceTypeId === "ebs-volume" && targetTypeId === "ec2-instance") {
      const [volume, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const volumeId = String(volume.fields["volumeId"] ?? volume.externalId ?? "");
      const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
      const volumeAz = String(volume.fields["availabilityZone"] ?? "");
      const instanceAz = String(instance.fields["availabilityZone"] ?? "");
      if (!volumeId || !instanceId) {
        throw new Error("Cannot determine VolumeId or InstanceId for attachment");
      }
      if (volumeAz && instanceAz && volumeAz !== instanceAz) {
        throw new Error(
          `Volume AZ ${volumeAz} does not match instance AZ ${instanceAz} — EBS volumes must be in the same AZ as the instance.`,
        );
      }
      // Pick the first free device letter after /dev/sdf (sdf..sdp is the conventional range)
      const device = "/dev/sdf";
      await this.ec2("AttachVolume", {
        VolumeId: volumeId,
        InstanceId: instanceId,
        Device: device,
      });
      return;
    }
    if (sourceTypeId === "security-group" && targetTypeId === "ec2-instance") {
      const [sg, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const sgId = String(sg.fields["groupId"] ?? sg.externalId ?? "");
      const instanceId = String(instance.fields["instanceId"] ?? instance.externalId ?? "");
      if (!sgId || !instanceId) {
        throw new Error("Cannot determine security group or instance id for attachment");
      }
      // Fetch the instance's current SG IDs so we don't overwrite existing ones.
      const describeRes = await this.ec2<Record<string, unknown>>("DescribeInstances", {
        "InstanceId.1": instanceId,
      });
      const reservations = ensureArray(
        (describeRes["reservationSet"] as Record<string, unknown> | undefined)?.["item"],
      ) as Record<string, unknown>[];
      const inst = ensureArray(
        (reservations[0]?.["instancesSet"] as Record<string, unknown> | undefined)?.["item"],
      )[0] as Record<string, unknown> | undefined;
      const currentGroups = ensureArray(
        (inst?.["groupSet"] as Record<string, unknown> | undefined)?.["item"],
      ) as Record<string, unknown>[];
      const current = currentGroups.map((g) => String(g["groupId"] ?? "")).filter(Boolean);
      if (current.includes(sgId)) return;
      const next = [...current, sgId];
      const params: Record<string, string> = { InstanceId: instanceId };
      next.forEach((g, i) => {
        params[`GroupId.${i + 1}`] = g;
      });
      await this.ec2("ModifyInstanceAttribute", params);
      return;
    }
    throw new Error(
      `AWS plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (
      typeId === "acm-certificate" &&
      (outputKey === "dnsRecords" || outputKey === "domainValidationStatus")
    ) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const externalId = resource.externalId;
      if (!externalId) return "";
      try {
        const detail = await this.json<{ Certificate?: Record<string, unknown> }>(
          "acm",
          "CertificateManager.DescribeCertificate",
          {
            CertificateArn: externalId,
          },
        );
        const cert = detail.Certificate;
        if (!cert) return "";
        if (outputKey === "dnsRecords") {
          const domainValidationOptions = cert["DomainValidationOptions"] as
            | Record<string, unknown>[]
            | undefined;
          if (!domainValidationOptions) return "";
          const records = domainValidationOptions
            .map((dvo) => {
              const resourceRecord = dvo["ResourceRecord"] as Record<string, unknown> | undefined;
              if (!resourceRecord) return null;
              const name = resourceRecord["Name"] ?? "";
              const recordType = resourceRecord["Type"] ?? "CNAME";
              const value = resourceRecord["Value"] ?? "";
              if (!name) return null;
              return `${recordType} ${name} -> ${value}`;
            })
            .filter(Boolean);
          return records.join("\n");
        }
        if (outputKey === "domainValidationStatus") {
          const domainValidationOptions = cert["DomainValidationOptions"] as
            | Record<string, unknown>[]
            | undefined;
          if (!domainValidationOptions) return "";
          return domainValidationOptions
            .map((dvo) => {
              const domain = dvo["DomainName"] ?? "";
              const status = dvo["ValidationStatus"] ?? "";
              const method = dvo["ValidationMethod"] ?? "";
              return `${domain} (${method}): ${status}`;
            })
            .join("\n");
        }
      } catch {
        return "";
      }
    }
    if (typeId === "iam-user" && outputKey === "accessKey") {
      const exp = await this.exportCredential(typeId, resourceId, accountId, "access-key");
      return exp.content;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(`AWS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    }
    return String(value);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "ec2-instance": {
        const state = String(f.state ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "State",
            value: state,
            variant:
              state === "running"
                ? "status-healthy"
                : state === "stopped" || state === "terminated"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Instance Type", value: String(f.instanceType ?? "") },
          { label: "AZ", value: String(f.availabilityZone ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "rds-instance": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "available"
                ? "status-healthy"
                : status === "stopped"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Engine", value: `${f.engine ?? ""} ${f.engineVersion ?? ""}`.trim() },
          { label: "Instance Class", value: String(f.instanceClass ?? "") },
          { label: "Storage", value: `${f.allocatedStorage ?? 0} GB` },
        ];
      }
      case "lambda-function": {
        return [
          { label: "Runtime", value: String(f.runtime ?? "") },
          { label: "Memory", value: `${f.memorySize ?? 0} MB` },
          { label: "Timeout", value: `${f.timeout ?? 0}s` },
        ];
      }
      case "s3-bucket": {
        return [{ label: "Region", value: String(f.region ?? "") }];
      }
      case "eks-cluster": {
        const status = String(f.status ?? "unknown");
        return [
          { label: "Version", value: String(f.version ?? "") },
          {
            label: "Status",
            value: status,
            variant:
              status === "ACTIVE" || status === "active" ? "status-healthy" : "status-degraded",
          },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      default: {
        // Generic fallback — show key fields from the resource
        const stats: DashboardStat[] = [];
        const statusVal = f.status ?? f.state ?? f.phase;
        if (statusVal != null) {
          const s = String(statusVal).toLowerCase();
          stats.push({
            label: "Status",
            value: String(statusVal),
            variant: [
              "running",
              "active",
              "available",
              "ready",
              "enabled",
              "healthy",
              "succeeded",
            ].some((v) => s.includes(v))
              ? "status-healthy"
              : ["error", "failed", "terminated", "deleted", "unhealthy"].some((v) => s.includes(v))
                ? "status-error"
                : ["pending", "creating", "updating", "stopping", "degraded", "warning"].some((v) =>
                      s.includes(v),
                    )
                  ? "status-degraded"
                  : "default",
          });
        }
        const typeVal =
          f.type ??
          f.kind ??
          f.engine ??
          f.instanceType ??
          f.tier ??
          f.machineType ??
          f.size ??
          f.flavor;
        if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
        const regionVal = f.region ?? f.location ?? f.zone ?? f.availabilityZone;
        if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
        return stats;
      }
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const start = timeRange?.startMs ?? now - 3600_000;
    const end = timeRange?.endMs ?? now;
    const period = Math.max(60, Math.floor((end - start) / 60));

    const resource = await this.getResource(resourceTypeId, resourceId, accountId);

    const fetchCw = async (
      namespace: string,
      metricName: string,
      dimensions: Array<{ Name: string; Value: string }>,
      stat = "Average",
    ): Promise<MetricSeries> => {
      const data = await this.json<Record<string, unknown>>(
        "monitoring",
        "GraniteServiceVersion20100801.GetMetricStatistics",
        {
          Namespace: namespace,
          MetricName: metricName,
          Dimensions: dimensions,
          StartTime: new Date(start).toISOString(),
          EndTime: new Date(end).toISOString(),
          Period: period,
          Statistics: [stat],
        },
      );
      const datapoints = (data["Datapoints"] as Array<Record<string, unknown>>) ?? [];
      return {
        label: metricName,
        unit: String(data["Label"] ?? ""),
        points: datapoints
          .map((dp) => ({
            timestamp: new Date(String(dp["Timestamp"])).getTime(),
            value: Number(dp[stat] ?? 0),
          }))
          .sort((a, b) => a.timestamp - b.timestamp),
      };
    };

    switch (resourceTypeId) {
      case "ec2-instance": {
        const instanceId = resource.externalId ?? "";
        const dims = [{ Name: "InstanceId", Value: instanceId }];
        const [cpu, netIn, netOut] = await Promise.all([
          fetchCw("AWS/EC2", "CPUUtilization", dims).catch(() => null),
          fetchCw("AWS/EC2", "NetworkIn", dims).catch(() => null),
          fetchCw("AWS/EC2", "NetworkOut", dims).catch(() => null),
        ]);
        const results: MetricSeries[] = [];
        if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
        if (netIn && netIn.points.length > 0)
          results.push({ ...netIn, label: "Network In", unit: " bytes" });
        if (netOut && netOut.points.length > 0)
          results.push({ ...netOut, label: "Network Out", unit: " bytes" });
        return results;
      }
      case "rds-instance": {
        const dbId = resource.externalId ?? "";
        const dims = [{ Name: "DBInstanceIdentifier", Value: dbId }];
        const [cpu, conns, freeStorage] = await Promise.all([
          fetchCw("AWS/RDS", "CPUUtilization", dims).catch(() => null),
          fetchCw("AWS/RDS", "DatabaseConnections", dims, "Sum").catch(() => null),
          fetchCw("AWS/RDS", "FreeStorageSpace", dims).catch(() => null),
        ]);
        const results: MetricSeries[] = [];
        if (cpu && cpu.points.length > 0) results.push({ ...cpu, unit: "%" });
        if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
        if (freeStorage && freeStorage.points.length > 0)
          results.push({ ...freeStorage, label: "Free Storage", unit: " bytes" });
        return results;
      }
      case "lambda-function": {
        const fnName = resource.externalId ?? "";
        const dims = [{ Name: "FunctionName", Value: fnName }];
        const [invocations, duration, errors] = await Promise.all([
          fetchCw("AWS/Lambda", "Invocations", dims, "Sum").catch(() => null),
          fetchCw("AWS/Lambda", "Duration", dims).catch(() => null),
          fetchCw("AWS/Lambda", "Errors", dims, "Sum").catch(() => null),
        ]);
        const results: MetricSeries[] = [];
        if (invocations && invocations.points.length > 0)
          results.push({ ...invocations, label: "Invocations" });
        if (duration && duration.points.length > 0)
          results.push({ ...duration, label: "Duration", unit: "ms" });
        if (errors && errors.points.length > 0) results.push({ ...errors, label: "Errors" });
        return results;
      }
      default:
        return [];
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Use shared DNS helpers for Route 53 records
    if (resource.resourceTypeId === "route53-record-set") {
      return renderDnsRecordDetail(resource, {});
    }

    const fields = resource.fields;
    // SNS topics and SQS queues have no lifecycle state — if they exist, they
    // are active. Treat a missing state as "active" so the dot renders healthy.
    const alwaysHealthyTypes = new Set(["sns-topic", "sqs-queue"]);
    const state = String(
      fields["state"] ??
        fields["status"] ??
        (alwaysHealthyTypes.has(resource.resourceTypeId) ? "active" : ""),
    );

    const statusMap: Record<string, ResourceStatus> = {
      // Generic
      running: "healthy",
      active: "healthy",
      "in-use": "healthy",
      available: "healthy",
      issued: "healthy",
      ok: "healthy",
      enabled: "healthy",
      // Degraded / stopped
      stopped: "degraded",
      stopping: "degraded",
      paused: "degraded",
      disabled: "degraded",
      inactive: "degraded",
      insufficient_data: "degraded",
      // Provisioning / in-progress
      pending: "provisioning",
      creating: "provisioning",
      updating: "provisioning",
      provisioning: "provisioning",
      create_in_progress: "provisioning",
      update_in_progress: "provisioning",
      operation_in_progress: "provisioning",
      pending_validation: "provisioning",
      // Error
      "shutting-down": "error",
      terminated: "error",
      deleting: "error",
      deleted: "error",
      failed: "error",
      create_failed: "error",
      delete_failed: "error",
      rollback_complete: "error",
      rollback_failed: "error",
      alarm: "error",
      revoked: "error",
      expired: "error",
    };
    const dotStatus = statusMap[state.toLowerCase()] ?? "info";

    return {
      title: resource.displayName,
      subtitle: `${resourceTypeDisplayName(this.resourceTypes, resource.resourceTypeId)} \u00B7 ${this.creds.region}`,
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
              items: labeledFieldItems(fields, this.resourceTypes, resource.resourceTypeId),
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
                    items: labeledOutputItems(
                      resource.resolvedOutputs,
                      this.resourceTypes,
                      resource.resourceTypeId,
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      ...(resource.resourceTypeId === "ecr-repository"
        ? {
            artifactRegistry: {
              format: "docker" as const,
              supportsTags: true,
            },
          }
        : {}),
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    // Use shared DNS helpers for Route 53 records
    if (resource.resourceTypeId === "route53-record-set") {
      return renderDnsRecordSidebar(resource);
    }
    // Route 53 hosted zones use the shared dnsZoneStatus helper
    if (resource.resourceTypeId === "route53-hosted-zone") {
      const isPrivate = resource.fields["isPrivate"];
      const label = isPrivate ? "Private" : "Active";
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: dnsZoneStatus("active"), label },
      };
    }

    const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
    const statusMap: Record<string, ResourceStatus> = {
      running: "healthy",
      active: "healthy",
      available: "healthy",
      "in-use": "healthy",
      issued: "healthy",
      ok: "healthy",
      enabled: "healthy",
      stopped: "degraded",
      paused: "degraded",
      disabled: "degraded",
      terminated: "error",
      failed: "error",
      deleted: "error",
      alarm: "error",
    };
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: statusMap[state.toLowerCase()] ?? "info" },
    };
  }

  /** S3-specific XML GET for ListObjectsV2 */
  private async s3Xml<T>(bucket: string, params: Record<string, string>): Promise<T> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const searchParams = new URLSearchParams(params);
    const url = `https://${host}/?${searchParams}`;
    const headers = await signRequest({
      method: "GET",
      url,
      headers: { Host: host },
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`S3 ListObjectsV2 failed: ${res.status}`);
    const xml = await res.text();
    return parseXml(xml) as T;
  }

  /** S3 PUT object */
  private async s3Put(bucket: string, key: string, body: string | ArrayBuffer): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const bodyStr = typeof body === "string" ? body : "";
    const headers = await signRequest({
      method: "PUT",
      url,
      headers: { Host: host, "Content-Type": "application/octet-stream" },
      body: bodyStr,
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
  }

  /** S3 DELETE object */
  private async s3Delete(bucket: string, key: string): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const headers = await signRequest({
      method: "DELETE",
      url,
      headers: { Host: host },
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }

  async uploadStorageObject(bucket: string, key: string, file: File): Promise<void> {
    const host = `${bucket}.s3.${this.creds.region}.amazonaws.com`;
    const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
    const body = await file.arrayBuffer();
    const bodyStr = new TextDecoder().decode(body);
    const headers = await signRequest({
      method: "PUT",
      url,
      headers: {
        Host: host,
        "Content-Type": file.type || "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
      body: bodyStr,
      service: "s3",
      credentials: this.creds,
    });
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw new Error(`S3 upload ${key} failed: ${res.status}`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const results: StorageObject[] = [];
    let continuationToken: string | undefined;

    do {
      const params: Record<string, string> = {
        "list-type": "2",
        delimiter: "/",
        "max-keys": "1000",
      };
      if (prefix) params["prefix"] = prefix;
      if (continuationToken) params["continuation-token"] = continuationToken;

      const data = await this.s3Xml<Record<string, unknown>>(bucket, params);

      // Common prefixes (directories)
      const prefixes = ensureArray(data["CommonPrefixes"]) as Record<string, unknown>[];
      for (const p of prefixes) {
        const key = String(p["Prefix"] ?? "");
        const name = key.slice(prefix.length).replace(/\/$/, "");
        results.push({ key, name, size: 0, lastModified: "", isDirectory: true });
      }

      // Objects
      const contents = ensureArray(data["Contents"]) as Record<string, unknown>[];
      for (const obj of contents) {
        const key = String(obj["Key"] ?? "");
        if (key === prefix) continue; // skip folder placeholder
        const name = key.slice(prefix.length);
        results.push({
          key,
          name,
          size: Number(obj["Size"] ?? 0),
          lastModified: String(obj["LastModified"] ?? ""),
          isDirectory: false,
        });
      }

      continuationToken =
        data["IsTruncated"] === "true" ? String(data["NextContinuationToken"] ?? "") : undefined;
    } while (continuationToken);

    return results;
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    await this.s3Put(bucket, folderKey, "");
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    if (key.endsWith("/")) {
      // Delete all objects under this prefix
      const objects = await this.listStorageObjects(bucket, key);
      for (const obj of objects) {
        if (obj.isDirectory) {
          await this.deleteStorageObject(bucket, obj.key);
        } else {
          await this.s3Delete(bucket, obj.key);
        }
      }
      // Delete the folder placeholder itself
      await this.s3Delete(bucket, key);
    } else {
      await this.s3Delete(bucket, key);
    }
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    if (typeId !== "ecr-repository") {
      throw new Error(`listArtifacts not supported for type ${typeId}`);
    }
    const repositoryName = resourceId.split(":").pop() ?? resourceId;
    const body: Record<string, unknown> = {
      repositoryName,
      maxResults: 50,
    };
    if (params?.pageToken) body["nextToken"] = params.pageToken;
    const data = await this.json<{
      imageDetails?: Array<Record<string, unknown>>;
      nextToken?: string;
    }>("ecr", "AmazonEC2ContainerRegistry_V20150921.DescribeImages", body);
    const items: ArtifactEntry[] = (data.imageDetails ?? []).map((img) => {
      const tags = Array.isArray(img["imageTags"]) ? (img["imageTags"] as string[]) : undefined;
      const entry: ArtifactEntry = {
        name: repositoryName,
      };
      const firstTag = tags?.[0];
      if (tags && tags.length > 0) {
        entry.tags = tags;
        if (firstTag) entry.version = firstTag;
      }
      if (img["imageDigest"]) entry.digest = String(img["imageDigest"]);
      if (img["imageSizeInBytes"] != null) entry.sizeBytes = Number(img["imageSizeInBytes"]);
      if (img["imagePushedAt"]) entry.updatedAt = String(img["imagePushedAt"]);
      if (img["artifactMediaType"]) entry.mediaType = String(img["artifactMediaType"]);
      return entry;
    });
    const prefix = params?.prefix?.trim();
    const filtered = prefix
      ? items.filter(
          (i) =>
            i.name.includes(prefix) ||
            (i.tags ?? []).some((t) => t.includes(prefix)) ||
            (i.digest ?? "").includes(prefix),
        )
      : items;
    const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
    if (data.nextToken) result.nextPageToken = data.nextToken;
    return result;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return awsGetCreateConfig(this.createCtx, typeId, parentResourceId);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return awsCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
  }

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    // Approximate monthly on-demand pricing (us-east-1, Linux)
    const ec2Pricing: Record<string, number> = {
      "t3.nano": 3.8,
      "t3.micro": 7.59,
      "t3.small": 15.18,
      "t3.medium": 30.37,
      "t3.large": 60.74,
      "t3.xlarge": 121.47,
      "t3.2xlarge": 242.94,
      "m6i.large": 69.35,
      "m6i.xlarge": 138.7,
      "m6i.2xlarge": 277.4,
      "m6i.4xlarge": 554.8,
      "m6i.8xlarge": 1109.6,
      "c6i.large": 61.32,
      "c6i.xlarge": 122.64,
      "c6i.2xlarge": 245.28,
      "c6i.4xlarge": 490.56,
      "r6i.large": 91.98,
      "r6i.xlarge": 183.96,
      "r6i.2xlarge": 367.92,
      "r6i.4xlarge": 735.84,
    };
    // EBS per-GB-month pricing (us-east-1). Covers every volumeType offered
    // in the ebs-volume create form.
    const ebsPerGbMonth: Record<string, number> = {
      gp3: 0.08,
      gp2: 0.1,
      io2: 0.125,
      st1: 0.045,
      sc1: 0.015,
      standard: 0.05,
    };
    const ebsRate = (volumeType: string): number =>
      ebsPerGbMonth[volumeType] ?? ebsPerGbMonth["gp3"]!;

    if (typeId === "ec2-instance") {
      const instanceType = fields["instanceType"] ?? "";
      const basePrice = ec2Pricing[instanceType];
      if (basePrice == null) return null;
      // EC2 create provisions a gp3 root volume (see createResource).
      const diskGb = Number(fields["diskSizeGb"] ?? "20");
      const diskCost = (Number.isFinite(diskGb) ? diskGb : 0) * ebsRate("gp3");
      return Number((basePrice + diskCost).toFixed(2));
    }
    if (typeId === "ebs-volume") {
      const sizeGb = Number(fields["sizeGb"] ?? "20");
      if (!Number.isFinite(sizeGb) || sizeGb <= 0) return null;
      const volumeType = fields["volumeType"] ?? "gp3";
      return Number((sizeGb * ebsRate(volumeType)).toFixed(2));
    }
    if (typeId === "rds-instance") {
      // Approximate on-demand pricing (us-east-1, PostgreSQL, single-AZ, 730h/month)
      const rdsPricing: Record<string, number> = {
        "db.t3.micro": 12.41,
        "db.t3.small": 24.82,
        "db.t3.medium": 49.64,
        "db.t3.large": 99.28,
        "db.r6g.large": 175.2,
        "db.r6g.xlarge": 350.4,
      };
      const instanceClass = fields["instanceClass"] ?? "";
      const basePrice = rdsPricing[instanceClass];
      if (basePrice == null) return null;
      // RDS defaults allocated storage to gp2 ($0.115/GB-month in us-east-1).
      const storageGb = Number(fields["allocatedStorage"] ?? "20");
      const storageCost = (Number.isFinite(storageGb) ? storageGb : 0) * 0.115;
      return Number((basePrice + storageCost).toFixed(2));
    }
    return null;
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const externalId = resource.externalId ?? "";

    switch (typeId) {
      case "ec2-instance":
        await this.ec2("TerminateInstances", { "InstanceId.1": externalId });
        break;
      case "ebs-volume":
        await this.ec2("DeleteVolume", { VolumeId: externalId });
        break;
      case "vpc":
        await this.ec2("DeleteVpc", { VpcId: externalId });
        break;
      case "subnet":
        await this.ec2("DeleteSubnet", { SubnetId: externalId });
        break;
      case "security-group":
        await this.ec2("DeleteSecurityGroup", { GroupId: externalId });
        break;
      case "nat-gateway":
        await this.ec2("DeleteNatGateway", { NatGatewayId: externalId });
        break;
      case "elastic-ip":
        await this.ec2("ReleaseAddress", { AllocationId: externalId });
        break;
      case "s3-bucket":
        await this.json("s3", "AmazonS3.DeleteBucket", { Bucket: externalId });
        break;
      case "lambda-function":
        await this.jsonGet("lambda", `/2015-03-31/functions/${encodeURIComponent(externalId)}`);
        // Lambda uses DELETE method — need a separate helper
        {
          const host = this.hostForService("lambda");
          const url = `https://${host}/2015-03-31/functions/${encodeURIComponent(externalId)}`;
          const headers = await signRequest({
            method: "DELETE",
            url,
            headers: { Host: host },
            service: "lambda",
            credentials: this.creds,
          });
          const res = await fetch(url, { method: "DELETE", headers });
          if (!res.ok) throw new Error(`Lambda delete ${externalId} failed: ${res.status}`);
        }
        break;
      case "sqs-queue": {
        const queueUrl = String(resource.fields["queueUrl"] ?? "");
        await this.json("sqs", "AmazonSQS.DeleteQueue", { QueueUrl: queueUrl });
        break;
      }
      case "sns-topic": {
        const topicArn = String(resource.fields["topicArn"] ?? "");
        await this.json("sns", "SNS.DeleteTopic", { TopicArn: topicArn });
        break;
      }
      case "dynamodb-table":
        await this.json("dynamodb", "DynamoDB_20120810.DeleteTable", { TableName: externalId });
        break;
      case "secrets-manager-secret":
        await this.json("secretsmanager", "secretsmanager.DeleteSecret", {
          SecretId: externalId,
          ForceDeleteWithoutRecovery: true,
        });
        break;
      case "ecr-repository":
        await this.json("ecr", "AmazonEC2ContainerRegistry_V20150921.DeleteRepository", {
          repositoryName: externalId,
          force: true,
        });
        break;
      case "cloudformation-stack":
        await this.json("cloudformation", "CloudFormation.DeleteStack", { StackName: externalId });
        break;
      case "ssm-parameter":
        await this.json("ssm", "AmazonSSM.DeleteParameter", { Name: externalId });
        break;
      case "cloudwatch-alarm":
        await this.json("monitoring", "GraniteServiceVersion20100801.DeleteAlarms", {
          AlarmNames: [externalId],
        });
        break;
      case "cloudwatch-log-group":
        await this.json("logs", "Logs_20140328.DeleteLogGroup", {
          logGroupName: externalId,
        });
        break;
      case "internet-gateway":
        await this.ec2("DeleteInternetGateway", { InternetGatewayId: externalId });
        break;
      case "cloudtrail-trail":
        await this.json(
          "cloudtrail",
          "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.DeleteTrail",
          {
            Name: externalId,
          },
        );
        break;
      case "sagemaker-endpoint": {
        const host = this.hostForService("sagemaker");
        const url = `https://${host}`;
        const headers = await signRequest({
          method: "POST",
          url,
          headers: {
            Host: host,
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "SageMaker.DeleteEndpoint",
          },
          body: JSON.stringify({ EndpointName: externalId }),
          service: "sagemaker",
          credentials: this.creds,
        });
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ EndpointName: externalId }),
        });
        if (!res.ok)
          throw new Error(`SageMaker delete endpoint ${externalId} failed: ${res.status}`);
        break;
      }
      case "ecs-service": {
        // externalId is "clusterName/serviceName"
        const [cluster, service] = externalId.split("/");
        // Force delete the service (stops tasks automatically)
        await this.json("ecs", "AmazonEC2ContainerServiceV20141113.DeleteService", {
          cluster: cluster ?? "",
          service: service ?? "",
          force: true,
        });
        break;
      }
      case "elasticache-cluster":
        await this.queryPost("elasticache", "DeleteCacheCluster", "2015-02-02", {
          CacheClusterId: externalId,
        });
        break;
      case "rds-instance":
        await this.queryPost("rds", "DeleteDBInstance", "2014-10-31", {
          DBInstanceIdentifier: externalId,
          SkipFinalSnapshot: "true",
          DeleteAutomatedBackups: "true",
        });
        break;
      case "rds-cluster":
        await this.queryPost("rds", "DeleteDBCluster", "2014-10-31", {
          DBClusterIdentifier: externalId,
          SkipFinalSnapshot: "true",
        });
        break;
      case "redshift-cluster":
        await this.ec2Query("redshift", "DeleteCluster", "2012-12-01", {
          ClusterIdentifier: externalId,
          SkipFinalClusterSnapshot: "true",
        });
        break;
      case "opensearch-domain": {
        const host = this.hostForService("es");
        const path = `/2021-01-01/opensearch/domain/${encodeURIComponent(externalId)}`;
        const url = `https://${host}${path}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "es",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`OpenSearch delete ${externalId} failed: ${res.status}`);
        break;
      }
      case "route53-hosted-zone": {
        const host = this.hostForService("route53");
        const url = `https://${host}/2013-04-01/hostedzone/${externalId}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "route53",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok)
          throw new Error(`Route53 delete hosted zone ${externalId} failed: ${res.status}`);
        break;
      }
      case "route53-record-set": {
        // externalId is "zoneId:name:type"
        const [zoneId, recordName, recordType] = externalId.split(":");
        const ttl = Number(resource.fields["ttl"] ?? 300);
        const values = String(resource.fields["values"] ?? "");
        const resourceRecords = values
          .split(", ")
          .filter(Boolean)
          .map((v) => `<ResourceRecord><Value>${v}</Value></ResourceRecord>`)
          .join("");
        const xmlBody = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">',
          "<ChangeBatch><Changes><Change>",
          "<Action>DELETE</Action>",
          "<ResourceRecordSet>",
          `<Name>${recordName}</Name>`,
          `<Type>${recordType}</Type>`,
          `<TTL>${ttl}</TTL>`,
          `<ResourceRecords>${resourceRecords}</ResourceRecords>`,
          "</ResourceRecordSet>",
          "</Change></Changes></ChangeBatch>",
          "</ChangeResourceRecordSetsRequest>",
        ].join("");
        const host = this.hostForService("route53");
        const url = `https://${host}/2013-04-01/hostedzone/${zoneId}/rrset`;
        const headers = await signRequest({
          method: "POST",
          url,
          headers: { Host: host, "Content-Type": "application/xml" },
          body: xmlBody,
          service: "route53",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "POST", headers, body: xmlBody });
        if (!res.ok)
          throw new Error(`Route53 delete record set ${externalId} failed: ${res.status}`);
        break;
      }
      case "alb": {
        const albArn = String(resource.resolvedOutputs["loadBalancerArn"] ?? "");
        await this.ec2Query("elasticloadbalancing", "DeleteLoadBalancer", "2015-12-01", {
          LoadBalancerArn: albArn,
        });
        break;
      }
      case "target-group": {
        const tgArn = String(resource.resolvedOutputs["targetGroupArn"] ?? "");
        await this.ec2Query("elasticloadbalancing", "DeleteTargetGroup", "2015-12-01", {
          TargetGroupArn: tgArn,
        });
        break;
      }
      case "auto-scaling-group":
        await this.ec2Query("autoscaling", "DeleteAutoScalingGroup", "2011-01-01", {
          AutoScalingGroupName: externalId,
          ForceDelete: "true",
        });
        break;
      case "step-function": {
        const smArn = String(resource.resolvedOutputs["stateMachineArn"] ?? "");
        await this.json("states", "AWSStepFunctions.DeleteStateMachine", {
          stateMachineArn: smArn,
        });
        break;
      }
      case "eventbridge-rule":
        await this.json("events", "AWSEvents.DeleteRule", {
          Name: externalId,
          Force: true,
        });
        break;
      case "kinesis-stream":
        await this.json("kinesis", "Kinesis_20131202.DeleteStream", {
          StreamName: externalId,
          EnforceConsumerDeletion: true,
        });
        break;
      case "efs-file-system": {
        const host = this.hostForService("elasticfilesystem");
        const url = `https://${host}/2015-02-01/file-systems/${encodeURIComponent(externalId)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "elasticfilesystem",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`EFS delete ${externalId} failed: ${res.status}`);
        break;
      }
      case "api-gateway": {
        const host = this.hostForService("apigateway");
        const url = `https://${host}/v2/apis/${encodeURIComponent(externalId)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "apigateway",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`API Gateway delete ${externalId} failed: ${res.status}`);
        break;
      }
      case "apprunner-service": {
        const serviceArn = String(resource.resolvedOutputs["serviceArn"] ?? "");
        await this.json("apprunner", "AppRunner.DeleteService", {
          ServiceArn: serviceArn,
        });
        break;
      }
      case "codebuild-project":
        await this.json("codebuild", "CodeBuild_20161006.DeleteProject", {
          name: externalId,
        });
        break;
      case "codepipeline-pipeline":
        await this.json("codepipeline", "CodePipeline_20150709.DeletePipeline", {
          name: externalId,
        });
        break;
      case "batch-job-queue":
        // Disable the job queue first, then delete
        await this.json("batch", "AWSBatch.UpdateJobQueue", {
          jobQueue: externalId,
          state: "DISABLED",
        });
        await this.json("batch", "AWSBatch.DeleteJobQueue", {
          jobQueue: externalId,
        });
        break;
      case "msk-cluster": {
        const clusterArn = String(resource.resolvedOutputs["clusterArn"] ?? "");
        const host = this.hostForService("kafka");
        const url = `https://${host}/v1/clusters/${encodeURIComponent(clusterArn)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "kafka",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`MSK delete cluster ${externalId} failed: ${res.status}`);
        break;
      }
      case "neptune-cluster":
        await this.queryPost("rds", "DeleteDBCluster", "2014-10-31", {
          DBClusterIdentifier: externalId,
          SkipFinalSnapshot: "true",
        });
        break;
      case "documentdb-cluster":
        await this.queryPost("rds", "DeleteDBCluster", "2014-10-31", {
          DBClusterIdentifier: externalId,
          SkipFinalSnapshot: "true",
        });
        break;
      case "mq-broker": {
        const host = this.hostForService("mq");
        const url = `https://${host}/v1/brokers/${encodeURIComponent(externalId)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "mq",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`MQ delete broker ${externalId} failed: ${res.status}`);
        break;
      }
      case "glue-database":
        await this.json("glue", "AWSGlue.DeleteDatabase", {
          Name: externalId,
        });
        break;
      case "iam-user":
        await this.queryPost("iam", "DeleteUser", "2010-05-08", {
          UserName: externalId,
        });
        break;
      case "iam-role":
        await this.queryPost("iam", "DeleteRole", "2010-05-08", {
          RoleName: externalId,
        });
        break;
      case "acm-certificate":
        await this.json("acm", "CertificateManager.DeleteCertificate", {
          CertificateArn: externalId,
        });
        break;
      case "waf-web-acl": {
        const webAclId = String(resource.resolvedOutputs["webAclId"] ?? "");
        // First get the WebACL to retrieve the LockToken
        const wafDetail = await this.json<{
          WebACL: Record<string, unknown>;
          LockToken: string;
        }>("wafv2", "AWSWAF_20190729.GetWebACL", {
          Name: externalId,
          Scope: "REGIONAL",
          Id: webAclId,
        });
        await this.json("wafv2", "AWSWAF_20190729.DeleteWebACL", {
          Name: externalId,
          Scope: "REGIONAL",
          Id: webAclId,
          LockToken: wafDetail.LockToken,
        });
        break;
      }
      case "eks-cluster": {
        const host = this.hostForService("eks");
        const url = `https://${host}/clusters/${encodeURIComponent(externalId)}`;
        const headers = await signRequest({
          method: "DELETE",
          url,
          headers: { Host: host },
          service: "eks",
          credentials: this.creds,
        });
        const res = await fetch(url, { method: "DELETE", headers });
        if (!res.ok) throw new Error(`EKS delete cluster ${externalId} failed: ${res.status}`);
        break;
      }
      default:
        throw new Error(`AWS plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "iam-user" && formatId === "access-key") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const userName = String(resource.externalId ?? resource.fields["userName"] ?? "");
      if (!userName) throw new Error("Cannot determine IAM user name");
      const data = await this.queryPost<Record<string, unknown>>(
        "iam",
        "CreateAccessKey",
        "2010-05-08",
        { UserName: userName },
      );
      const result = data["CreateAccessKeyResult"] as Record<string, unknown> | undefined;
      const accessKey = (result?.["AccessKey"] as Record<string, unknown>) ?? {};
      const id = String(accessKey["AccessKeyId"] ?? "");
      const secret = String(accessKey["SecretAccessKey"] ?? "");
      if (!id || !secret) throw new Error("AWS returned an empty access key");
      const ini = `[default]\naws_access_key_id=${id}\naws_secret_access_key=${secret}\n`;
      return {
        content: ini,
        filename: `${userName}.credentials`,
        mimeType: "text/plain",
        fields: [
          { label: "Access Key ID", value: id },
          { label: "Secret Access Key", value: secret, sensitive: true, hint: "Only shown once" },
        ],
        warning:
          "Save this secret access key now. AWS will not show it again — if lost, delete this key and create a new one.",
      };
    }
    throw new Error(
      `AWS plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
  }

  async getManifest(resourceId: string, accountId: string): Promise<string> {
    // Determine the type from the resourceId pattern (accountId:typeId:externalId)
    const parts = resourceId.split(":");
    const typeId = parts[1] ?? "";

    const resource = await this.getResource(typeId, resourceId, accountId);
    return JSON.stringify(
      {
        resourceTypeId: resource.resourceTypeId,
        externalId: resource.externalId,
        displayName: resource.displayName,
        fields: resource.fields,
        resolvedOutputs: resource.resolvedOutputs,
      },
      null,
      2,
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}
