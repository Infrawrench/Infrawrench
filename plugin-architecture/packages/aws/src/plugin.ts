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
  EC2InstanceResourceType,
  EBSVolumeResourceType,
  VPCResourceType,
  EKSClusterResourceType,
  RDSInstanceResourceType,
  S3BucketResourceType,
  LambdaFunctionResourceType,
  ECSServiceResourceType,
  DynamoDBTableResourceType,
  ElastiCacheClusterResourceType,
  SQSQueueResourceType,
  SNSTopicResourceType,
  ECRRepositoryResourceType,
  SecretsManagerSecretResourceType,
  CloudFrontDistributionResourceType,
  IAMUserResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new AWSClient(credentials),
};
