/**
 * Lazy per-service AWS SDK v3 client registry.
 *
 * Memoizes one client per (accessKeyId, region) tuple so listers don't
 * reconstruct on every call. Clients are constructed on first access
 * for the service they're needed for. When the host supplies an HTTP service
 * every client sends through it; with none, the SDK's own handler is untouched.
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
import { BackupClient } from "@aws-sdk/client-backup";
import { BatchClient } from "@aws-sdk/client-batch";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CodePipelineClient } from "@aws-sdk/client-codepipeline";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
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

import { hostFetch, type HttpHostServices } from "@infrawrench/plugin-base";
import { HttpResponse, type HttpHandler, type HttpRequest } from "@smithy/protocol-http";

import type { AwsCredentials } from "./auth.js";

export interface AwsClients {
  readonly acm: ACMClient;
  readonly apiGateway: APIGatewayClient;
  readonly apiGatewayV2: ApiGatewayV2Client;
  readonly appRunner: AppRunnerClient;
  readonly autoScaling: AutoScalingClient;
  readonly backup: BackupClient;
  readonly batch: BatchClient;
  readonly cloudFormation: CloudFormationClient;
  readonly cloudFront: CloudFrontClient;
  readonly cloudTrail: CloudTrailClient;
  readonly cloudWatch: CloudWatchClient;
  readonly cloudWatchLogs: CloudWatchLogsClient;
  readonly codeBuild: CodeBuildClient;
  readonly codePipeline: CodePipelineClient;
  readonly cognitoIdp: CognitoIdentityProviderClient;
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
/**
 * Clients with a host's handler belong to that host service, which is per account: a
 * bastion-bound account and an unbound one can hold the same key.
 */
const hostCaches = new WeakMap<HttpHostServices, Map<string, AwsClients>>();

function cacheFor(http: HttpHostServices | undefined): Map<string, AwsClients> {
  if (!http) return cache;
  let hostCache = hostCaches.get(http);
  if (!hostCache) {
    hostCache = new Map();
    hostCaches.set(http, hostCache);
  }
  return hostCache;
}

/** Hop-by-hop headers for a connection the host owns. SigV4 never signs them, and `fetch` refuses them. */
const CONNECTION_HEADERS = new Set(["connection", "expect", "transfer-encoding"]);

function escapeQueryPart(part: string): string {
  return encodeURIComponent(part).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The URL the SDK signed, built the way its own fetch handler builds it. */
function requestUrl(request: HttpRequest): string {
  const query = Object.keys(request.query ?? {})
    .sort()
    .flatMap((key) => {
      const value = request.query[key];
      const name = escapeQueryPart(key);
      if (value === null || value === undefined) return [name];
      return (Array.isArray(value) ? value : [value]).map((v) => `${name}=${escapeQueryPart(v)}`);
    })
    .join("&");
  const port = request.port ? `:${request.port}` : "";
  return `${request.protocol}//${request.hostname}${port}${request.path}${query ? `?${query}` : ""}`;
}

/** A request body as the host takes one. The SDK's can be a stream, which the host cannot carry. */
async function requestBody(body: unknown): Promise<string | Uint8Array<ArrayBuffer> | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new Error("AWS SDK handed the host a request body it cannot send");
}

/**
 * Hands each SDK request to the host, which is the only path with bastion routing.
 * The host buffers, so a stream the SDK sends is read whole first, and the answer goes
 * back as a stream because that is what every SDK deserializer accepts, S3's `Body`
 * included. Signing has already happened, so the headers go through as they are.
 */
function hostRequestHandler(http: HttpHostServices): HttpHandler {
  return {
    metadata: { handlerProtocol: "http/1.1" },
    updateHttpClientConfig: () => {},
    httpHandlerConfigs: () => ({}),
    handle: async (request, options) => {
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await requestBody(request.body);
      const res = await hostFetch({ http }, requestUrl(request), {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(
            ([name]) => !CONNECTION_HEADERS.has(name.toLowerCase()),
          ),
        ),
        ...(body !== undefined ? { body } : {}),
        ...(options?.abortSignal instanceof AbortSignal ? { signal: options.abortSignal } : {}),
      });
      return {
        response: new HttpResponse({
          statusCode: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: res.body ?? new Blob().stream(),
        }),
      };
    },
  };
}

function cacheKey(creds: AwsCredentials): string {
  return `${creds.accessKeyId}:${creds.region}:${creds.sessionToken ?? ""}`;
}

/**
 * Lazily build (and memoize) the AWS SDK client bundle for these credentials.
 * Each client is constructed only when first accessed via the getter, so
 * cold paths don't pay the cost of every service's middleware stack.
 */
export function getAwsClients(creds: AwsCredentials): AwsClients {
  const clientCache = cacheFor(creds.http);
  const key = cacheKey(creds);
  const existing = clientCache.get(key);
  if (existing) return existing;

  const credentials = {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
  const baseConfig = {
    region: creds.region,
    credentials,
    ...(creds.http ? { requestHandler: hostRequestHandler(creds.http) } : {}),
  };

  // We use a Proxy-style lazy-getter object so individual clients are only
  // instantiated when first accessed. This matters because every SDK client
  // pulls in its own middleware stack.
  const factories: { [K in keyof AwsClients]: () => AwsClients[K] } = {
    acm: () => new ACMClient(baseConfig),
    apiGateway: () => new APIGatewayClient(baseConfig),
    apiGatewayV2: () => new ApiGatewayV2Client(baseConfig),
    appRunner: () => new AppRunnerClient(baseConfig),
    autoScaling: () => new AutoScalingClient(baseConfig),
    backup: () => new BackupClient(baseConfig),
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
    cognitoIdp: () => new CognitoIdentityProviderClient(baseConfig),
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
    // NeptuneClient's built-in endpoint template (neptune.<region>) is
    // NXDOMAIN: requests only work against rds.<region>, which hosts the
    // shared RDS/Neptune control plane. client-transport.ts overrides the
    // resolved host accordingly; this client is kept for signing/config only.
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

  clientCache.set(key, bundle);
  return bundle;
}
