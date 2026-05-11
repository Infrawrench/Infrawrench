/**
 * Lazy per-service AWS SDK v3 client registry.
 *
 * Memoizes one client per (accessKeyId, region) tuple so listers don't
 * reconstruct on every call. Clients are constructed on first access
 * for the service they're needed for.
 *
 * Each `@aws-sdk/client-*` is imported and exposed here. The endpoint
 * resolution, retry policy, and SigV4 region/service-name selection are
 * handled by the SDK (no more hand-rolled SERVICE_HOSTS map).
 */

import { ACMClient } from "@aws-sdk/client-acm";
import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { AppRunnerClient } from "@aws-sdk/client-apprunner";
import { AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { BatchClient } from "@aws-sdk/client-batch";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CodePipelineClient } from "@aws-sdk/client-codepipeline";
import { DocDBClient } from "@aws-sdk/client-docdb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECRClient } from "@aws-sdk/client-ecr";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EFSClient } from "@aws-sdk/client-efs";
import { EKSClient } from "@aws-sdk/client-eks";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GlueClient } from "@aws-sdk/client-glue";
import { IAMClient } from "@aws-sdk/client-iam";
import { KafkaClient } from "@aws-sdk/client-kafka";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { MqClient } from "@aws-sdk/client-mq";
import { NeptuneClient } from "@aws-sdk/client-neptune";
import { OpenSearchClient } from "@aws-sdk/client-opensearch";
import { RDSClient } from "@aws-sdk/client-rds";
import { RedshiftClient } from "@aws-sdk/client-redshift";
import { Route53Client } from "@aws-sdk/client-route-53";
import { S3Client } from "@aws-sdk/client-s3";
import { SageMakerClient } from "@aws-sdk/client-sagemaker";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient } from "@aws-sdk/client-sfn";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { WAFV2Client } from "@aws-sdk/client-wafv2";

import type { AwsCredentials } from "./auth.js";

export interface AwsClients {
  readonly acm: ACMClient;
  readonly apiGateway: APIGatewayClient;
  readonly apiGatewayV2: ApiGatewayV2Client;
  readonly appRunner: AppRunnerClient;
  readonly autoScaling: AutoScalingClient;
  readonly batch: BatchClient;
  readonly cloudFormation: CloudFormationClient;
  readonly cloudFront: CloudFrontClient;
  readonly cloudTrail: CloudTrailClient;
  readonly cloudWatch: CloudWatchClient;
  readonly cloudWatchLogs: CloudWatchLogsClient;
  readonly codeBuild: CodeBuildClient;
  readonly codePipeline: CodePipelineClient;
  readonly docDb: DocDBClient;
  readonly dynamoDb: DynamoDBClient;
  readonly ec2: EC2Client;
  readonly ecr: ECRClient;
  readonly ecs: ECSClient;
  readonly efs: EFSClient;
  readonly eks: EKSClient;
  readonly elbv2: ElasticLoadBalancingV2Client;
  readonly elastiCache: ElastiCacheClient;
  readonly eventBridge: EventBridgeClient;
  readonly glue: GlueClient;
  readonly iam: IAMClient;
  readonly kafka: KafkaClient;
  readonly kinesis: KinesisClient;
  readonly lambda: LambdaClient;
  readonly mq: MqClient;
  readonly neptune: NeptuneClient;
  readonly openSearch: OpenSearchClient;
  readonly rds: RDSClient;
  readonly redshift: RedshiftClient;
  readonly route53: Route53Client;
  readonly s3: S3Client;
  readonly sageMaker: SageMakerClient;
  readonly secretsManager: SecretsManagerClient;
  readonly stepFunctions: SFNClient;
  readonly sns: SNSClient;
  readonly sqs: SQSClient;
  readonly ssm: SSMClient;
  readonly wafv2: WAFV2Client;
}

const cache = new Map<string, AwsClients>();

function cacheKey(creds: AwsCredentials): string {
  return `${creds.accessKeyId}:${creds.region}:${creds.sessionToken ?? ""}`;
}

/**
 * Lazily build (and memoize) the AWS SDK client bundle for these credentials.
 * Each client is constructed only when first accessed via the getter, so
 * cold paths don't pay the cost of every service's middleware stack.
 */
export function getAwsClients(creds: AwsCredentials): AwsClients {
  const key = cacheKey(creds);
  const existing = cache.get(key);
  if (existing) return existing;

  const credentials = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
  const baseConfig = { region: creds.region, credentials };

  // We use a Proxy-style lazy-getter object so individual clients are only
  // instantiated when first accessed. This matters because every SDK client
  // pulls in its own middleware stack.
  const factories: { [K in keyof AwsClients]: () => AwsClients[K] } = {
    acm: () => new ACMClient(baseConfig),
    apiGateway: () => new APIGatewayClient(baseConfig),
    apiGatewayV2: () => new ApiGatewayV2Client(baseConfig),
    appRunner: () => new AppRunnerClient(baseConfig),
    autoScaling: () => new AutoScalingClient(baseConfig),
    batch: () => new BatchClient(baseConfig),
    cloudFormation: () => new CloudFormationClient(baseConfig),
    // CloudFront, IAM, and Route 53 are global services. Their SDK clients
    // know to talk to us-east-1 even though our credentials region differs.
    cloudFront: () => new CloudFrontClient(baseConfig),
    cloudTrail: () => new CloudTrailClient(baseConfig),
    cloudWatch: () => new CloudWatchClient(baseConfig),
    cloudWatchLogs: () => new CloudWatchLogsClient(baseConfig),
    codeBuild: () => new CodeBuildClient(baseConfig),
    codePipeline: () => new CodePipelineClient(baseConfig),
    docDb: () => new DocDBClient(baseConfig),
    dynamoDb: () => new DynamoDBClient(baseConfig),
    ec2: () => new EC2Client(baseConfig),
    ecr: () => new ECRClient(baseConfig),
    ecs: () => new ECSClient(baseConfig),
    efs: () => new EFSClient(baseConfig),
    eks: () => new EKSClient(baseConfig),
    elbv2: () => new ElasticLoadBalancingV2Client(baseConfig),
    elastiCache: () => new ElastiCacheClient(baseConfig),
    eventBridge: () => new EventBridgeClient(baseConfig),
    glue: () => new GlueClient(baseConfig),
    iam: () => new IAMClient(baseConfig),
    kafka: () => new KafkaClient(baseConfig),
    kinesis: () => new KinesisClient(baseConfig),
    lambda: () => new LambdaClient(baseConfig),
    mq: () => new MqClient(baseConfig),
    // Neptune correctly resolves to neptune.<region>.amazonaws.com — the
    // previous SERVICE_HOSTS map incorrectly pointed Neptune at rds.<region>
    neptune: () => new NeptuneClient(baseConfig),
    openSearch: () => new OpenSearchClient(baseConfig),
    rds: () => new RDSClient(baseConfig),
    redshift: () => new RedshiftClient(baseConfig),
    route53: () => new Route53Client(baseConfig),
    s3: () => new S3Client(baseConfig),
    sageMaker: () => new SageMakerClient(baseConfig),
    secretsManager: () => new SecretsManagerClient(baseConfig),
    stepFunctions: () => new SFNClient(baseConfig),
    sns: () => new SNSClient(baseConfig),
    sqs: () => new SQSClient(baseConfig),
    ssm: () => new SSMClient(baseConfig),
    wafv2: () => new WAFV2Client(baseConfig),
  };

  const memo: Partial<Record<keyof AwsClients, unknown>> = {};
  const bundle = {} as AwsClients;
  for (const k of Object.keys(factories) as Array<keyof AwsClients>) {
    Object.defineProperty(bundle, k, {
      enumerable: true,
      get() {
        if (memo[k] === undefined) memo[k] = factories[k]();
        return memo[k];
      },
    });
  }

  cache.set(key, bundle);
  return bundle;
}
