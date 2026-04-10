import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { AWSClient } from "./client.js";
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
import { MQBrokerResourceType } from "./resources/mq-broker.js";
import { BatchJobQueueResourceType } from "./resources/batch-job-queue.js";
import { SageMakerEndpointResourceType } from "./resources/sagemaker-endpoint.js";

const manifest: PluginManifest = {
  id: "aws",
  version: "0.1.0",
  displayName: "Amazon Web Services",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#232F3E"/>
    <g transform="translate(15,25) scale(0.7)" fill="#FF9900">
      <path d="M28.5 55.2c-9.1-6.7-14.1-16.3-14.1-27.1 0-10.2 4.5-19.8 12.3-26.3.5-.4 1.1-.1 1.2.4.1.5-.2.9-.5 1.2C20.4 10 16.4 18.8 16.4 28.1c0 10 4.6 19.3 12.5 25.5.4.3.5.9.1 1.3-.3.3-.6.4-.5.3z"/>
      <path d="M71.5 55.2c9.1-6.7 14.1-16.3 14.1-27.1 0-10.2-4.5-19.8-12.3-26.3-.5-.4-1.1-.1-1.2.4-.1.5.2.9.5 1.2C79.6 10 83.6 18.8 83.6 28.1c0 10-4.6 19.3-12.5 25.5-.4.3-.5.9-.1 1.3.3.3.6.4.5.3z"/>
      <path d="M50 10l20 30H30z"/>
    </g>
    <text x="50" y="72" text-anchor="middle" fill="#FF9900" font-family="Arial" font-weight="bold" font-size="14">AWS</text>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
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
      label: "Region",
      description: "AWS region to query (e.g. us-east-1).",
      sensitive: false,
      placeholder: "us-east-1",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  // Compute
  EC2InstanceResourceType,
  LambdaFunctionResourceType,
  ECSServiceResourceType,
  EKSClusterResourceType,
  AppRunnerServiceResourceType,
  AutoScalingGroupResourceType,
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
  // Networking
  VPCResourceType,
  SubnetResourceType,
  SecurityGroupResourceType,
  ALBResourceType,
  TargetGroupResourceType,
  NATGatewayResourceType,
  ElasticIPResourceType,
  Route53HostedZoneResourceType,
  Route53RecordSetResourceType,
  CloudFrontDistributionResourceType,
  APIGatewayResourceType,
  // Messaging & Events
  SQSQueueResourceType,
  SNSTopicResourceType,
  EventBridgeRuleResourceType,
  KinesisStreamResourceType,
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
  // Networking (continued)
  InternetGatewayResourceType,
  // Analytics & Data
  GlueDatabaseResourceType,
  // Messaging (continued)
  MSKClusterResourceType,
  MQBrokerResourceType,
  // Database (continued)
  NeptuneClusterResourceType,
  DocumentDBClusterResourceType,
  // Audit & Compliance
  CloudTrailTrailResourceType,
  // Compute (continued)
  BatchJobQueueResourceType,
  // ML
  SageMakerEndpointResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new AWSClient(credentials),
};
