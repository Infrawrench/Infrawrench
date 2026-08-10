import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { AWSClient } from "./client.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { awsPreflight, buildAwsPolicyTemplate } from "./preflight.js";
import { awsTerraformExport } from "./terraform.js";
import { AWS_REGIONS } from "./constants.js";
import { EC2InstanceResourceType } from "./resources/ec2-instance.js";
import { EBSVolumeResourceType } from "./resources/ebs-volume.js";
import { VPCResourceType } from "./resources/vpc.js";
import { EKSClusterResourceType } from "./resources/eks-cluster.js";
import { RDSInstanceResourceType } from "./resources/rds-instance.js";
import { S3BucketResourceType } from "./resources/s3-bucket.js";
import { LambdaFunctionResourceType } from "./resources/lambda-function.js";
import { ECSServiceResourceType } from "./resources/ecs-service.js";
import { DynamoDBTableResourceType } from "./resources/dynamodb-table.js";
import { ElastiCacheClusterResourceType } from "./resources/elasticache-cluster.js";
import { SQSQueueResourceType } from "./resources/sqs-queue.js";
import { SNSTopicResourceType } from "./resources/sns-topic.js";
import { ECRRepositoryResourceType } from "./resources/ecr-repository.js";
import { SecretsManagerSecretResourceType } from "./resources/secrets-manager-secret.js";
import { CloudFrontDistributionResourceType } from "./resources/cloudfront-distribution.js";
import { IAMUserResourceType } from "./resources/iam-user.js";
import { Route53HostedZoneResourceType } from "./resources/route53-hosted-zone.js";
import { Route53RecordSetResourceType } from "./resources/route53-record-set.js";
import { ALBResourceType } from "./resources/alb.js";
import { TargetGroupResourceType } from "./resources/target-group.js";
import { AutoScalingGroupResourceType } from "./resources/auto-scaling-group.js";
import { IAMRoleResourceType } from "./resources/iam-role.js";
import { SecurityGroupResourceType } from "./resources/security-group.js";
import { SubnetResourceType } from "./resources/subnet.js";
import { RouteTableResourceType } from "./resources/route-table.js";
import { NATGatewayResourceType } from "./resources/nat-gateway.js";
import { ElasticIPResourceType } from "./resources/elastic-ip.js";
import { StepFunctionResourceType } from "./resources/step-function.js";
import { EventBridgeRuleResourceType } from "./resources/eventbridge-rule.js";
import { KinesisStreamResourceType } from "./resources/kinesis-stream.js";
import { RedshiftClusterResourceType } from "./resources/redshift-cluster.js";
import { RDSClusterResourceType } from "./resources/rds-cluster.js";
import { OpenSearchDomainResourceType } from "./resources/opensearch-domain.js";
import { ACMCertificateResourceType } from "./resources/acm-certificate.js";
import { WAFWebACLResourceType } from "./resources/waf-web-acl.js";
import { CodeBuildProjectResourceType } from "./resources/codebuild-project.js";
import { CodePipelinePipelineResourceType } from "./resources/codepipeline-pipeline.js";
import { CloudFormationStackResourceType } from "./resources/cloudformation-stack.js";
import { SSMParameterResourceType } from "./resources/ssm-parameter.js";
import { EFSFileSystemResourceType } from "./resources/efs-file-system.js";
import { APIGatewayResourceType } from "./resources/api-gateway.js";
import { CloudWatchAlarmResourceType } from "./resources/cloudwatch-alarm.js";
import { CloudWatchLogGroupResourceType } from "./resources/cloudwatch-log-group.js";
import { AppRunnerServiceResourceType } from "./resources/apprunner-service.js";
import { GlueDatabaseResourceType } from "./resources/glue-database.js";
import { InternetGatewayResourceType } from "./resources/internet-gateway.js";
import { CloudTrailTrailResourceType } from "./resources/cloudtrail-trail.js";
import { MSKClusterResourceType } from "./resources/msk-cluster.js";
import { NeptuneClusterResourceType } from "./resources/neptune-cluster.js";
import { DocumentDBClusterResourceType } from "./resources/documentdb-cluster.js";
import { DBSubnetGroupResourceType } from "./resources/db-subnet-group.js";
import { MQBrokerResourceType } from "./resources/mq-broker.js";
import { BatchJobQueueResourceType } from "./resources/batch-job-queue.js";
import { SageMakerEndpointResourceType } from "./resources/sagemaker-endpoint.js";
import { BedrockModelResourceType } from "./resources/bedrock-model.js";
import { Route53HealthCheckResourceType } from "./resources/route53-health-check.js";
import { CognitoUserPoolResourceType } from "./resources/cognito-user-pool.js";
import { BackupVaultResourceType } from "./resources/backup-vault.js";

const manifest: PluginManifest = {
  id: "aws",
  version: "0.1.0",
  displayName: "Amazon Web Services",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#232F3E"/>
    <g transform="translate(8,14) scale(3.5)" fill="#FF9900">
      <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessKeyId",
      label: "Access Key ID",
      description: "Your AWS IAM access key ID.",
      sensitive: false,
      placeholder: "AKIA...",
    },
    {
      key: "secretAccessKey",
      label: "Secret Access Key",
      description: "Your AWS IAM secret access key.",
      sensitive: true,
      placeholder: "wJalr...",
    },
    {
      key: "region",
      label: "Home Region",
      description:
        "Default region for create forms and global-service signing. Resource listings still cover every region enabled on the account.",
      sensitive: false,
      defaultValue: "us-east-1",
      regions: AWS_REGIONS,
    },
  ],
  rateLimit: { capacity: 120, refillPerSecond: 8 },
  // Cost Explorer GetCostAndUsage, grouped by SERVICE + REGION. Per-resource
  // granularity is intentionally omitted (CE keeps it 14 days only, and it
  // explodes cardinality). Needs the ce:GetCostAndUsage IAM action.
  costs: { dimensions: ["service", "region"], maxHistoryDays: 365, restatementDays: 3 },
  statusFeed,
  preflight: awsPreflight,
};

const resourceTypes: ResourceTypeDefinition[] = [
  // Compute
  EC2InstanceResourceType,
  LambdaFunctionResourceType,
  ECSServiceResourceType,
  EKSClusterResourceType,
  AppRunnerServiceResourceType,
  AutoScalingGroupResourceType,
  BatchJobQueueResourceType,
  // Storage
  S3BucketResourceType,
  EBSVolumeResourceType,
  EFSFileSystemResourceType,
  // Database
  RDSInstanceResourceType,
  RDSClusterResourceType,
  DynamoDBTableResourceType,
  ElastiCacheClusterResourceType,
  RedshiftClusterResourceType,
  OpenSearchDomainResourceType,
  NeptuneClusterResourceType,
  DocumentDBClusterResourceType,
  DBSubnetGroupResourceType,
  // Networking
  VPCResourceType,
  SubnetResourceType,
  RouteTableResourceType,
  SecurityGroupResourceType,
  ALBResourceType,
  TargetGroupResourceType,
  NATGatewayResourceType,
  ElasticIPResourceType,
  Route53HostedZoneResourceType,
  Route53RecordSetResourceType,
  CloudFrontDistributionResourceType,
  APIGatewayResourceType,
  InternetGatewayResourceType,
  // Messaging & Events
  SQSQueueResourceType,
  SNSTopicResourceType,
  EventBridgeRuleResourceType,
  KinesisStreamResourceType,
  MSKClusterResourceType,
  MQBrokerResourceType,
  // Containers & Registries
  ECRRepositoryResourceType,
  // Security & Identity
  IAMUserResourceType,
  IAMRoleResourceType,
  SecretsManagerSecretResourceType,
  SSMParameterResourceType,
  ACMCertificateResourceType,
  WAFWebACLResourceType,
  // Orchestration & CI/CD
  StepFunctionResourceType,
  CodeBuildProjectResourceType,
  CodePipelinePipelineResourceType,
  CloudFormationStackResourceType,
  // Monitoring
  CloudWatchAlarmResourceType,
  CloudWatchLogGroupResourceType,
  // Analytics & Data
  GlueDatabaseResourceType,
  // Audit & Compliance
  CloudTrailTrailResourceType,
  // ML
  SageMakerEndpointResourceType,
  BedrockModelResourceType,
  // DNS & Health
  Route53HealthCheckResourceType,
  // Identity
  CognitoUserPoolResourceType,
  // Backup
  BackupVaultResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new AWSClient(credentials, resourceTypes, services),
  parseStatusFeed,
  policyTemplate: buildAwsPolicyTemplate,
  terraformExport: awsTerraformExport,
};
