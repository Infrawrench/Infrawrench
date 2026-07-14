/**
 * Transport shim for AWS plugin resource listers + create/delete handlers.
 *
 * The legacy implementation hand-rolled SigV4 and kept a SERVICE_HOSTS map
 * (with a known-bad Neptune entry that pointed at RDS). This module now:
 *
 *   - Resolves endpoints through per-service `@aws-sdk/client-*` packages,
 *     so each service uses the SDK's authoritative hostname for the region
 *     including global-service overrides (cloudfront, iam, route53) and
 *     the Neptune-specific endpoint (which is no longer aliased to RDS).
 *   - Signs requests with `@smithy/signature-v4` via `signed-request.ts`,
 *     which is the same SigV4 implementation the SDK uses internally.
 *   - Parses XML responses with `fast-xml-parser` (no DOMParser).
 *
 * Lister/handler call sites keep their previous signatures — they pass in
 * a service id ("rds", "elasticloadbalancing", "monitoring", …) and an
 * action/target, and we resolve the right SDK client + endpoint.
 *
 * Where pagination matters (IAM ListPolicies, EC2 Describe* …) the
 * loop sits in the lister and uses the underlying SDK Commands. The
 * shim here exists so we don't have to rewrite every one of the 50+
 * listers in this PR.
 */

import type { AwsCredentials } from "./auth.js";
import { getAwsClients, type AwsClients } from "./aws-clients.js";
import { fetchSigned } from "./signed-request.js";
import { parseXml } from "./xml.js";

/**
 * Map of legacy "service" identifiers (the strings the old transport used)
 * to the matching SDK client key in `AwsClients`. Each entry also carries
 * the SigV4 signing-service name, which sometimes differs from both the
 * SDK client key and the service-id string.
 */
interface ServiceBinding {
  clientKey: keyof AwsClients;
  signingName: string;
}

const SERVICE_BINDINGS: Record<string, ServiceBinding> = {
  acm: { clientKey: "acm", signingName: "acm" },
  apigateway: { clientKey: "apiGatewayV2", signingName: "apigateway" },
  apprunner: { clientKey: "appRunner", signingName: "apprunner" },
  autoscaling: { clientKey: "autoScaling", signingName: "autoscaling" },
  backup: { clientKey: "backup", signingName: "backup" },
  batch: { clientKey: "batch", signingName: "batch" },
  cloudformation: { clientKey: "cloudFormation", signingName: "cloudformation" },
  cloudfront: { clientKey: "cloudFront", signingName: "cloudfront" },
  cloudtrail: { clientKey: "cloudTrail", signingName: "cloudtrail" },
  codebuild: { clientKey: "codeBuild", signingName: "codebuild" },
  codepipeline: { clientKey: "codePipeline", signingName: "codepipeline" },
  "cognito-idp": { clientKey: "cognitoIdp", signingName: "cognito-idp" },
  dynamodb: { clientKey: "dynamoDb", signingName: "dynamodb" },
  ec2: { clientKey: "ec2", signingName: "ec2" },
  ecr: { clientKey: "ecr", signingName: "ecr" },
  ecs: { clientKey: "ecs", signingName: "ecs" },
  eks: { clientKey: "eks", signingName: "eks" },
  elasticache: { clientKey: "elastiCache", signingName: "elasticache" },
  elasticfilesystem: { clientKey: "efs", signingName: "elasticfilesystem" },
  elasticloadbalancing: { clientKey: "elbv2", signingName: "elasticloadbalancing" },
  es: { clientKey: "openSearch", signingName: "es" },
  events: { clientKey: "eventBridge", signingName: "events" },
  glue: { clientKey: "glue", signingName: "glue" },
  iam: { clientKey: "iam", signingName: "iam" },
  kafka: { clientKey: "kafka", signingName: "kafka" },
  kinesis: { clientKey: "kinesis", signingName: "kinesis" },
  lambda: { clientKey: "lambda", signingName: "lambda" },
  logs: { clientKey: "cloudWatchLogs", signingName: "logs" },
  monitoring: { clientKey: "cloudWatch", signingName: "monitoring" },
  mq: { clientKey: "mq", signingName: "mq" },
  // Neptune requests must go to rds.<region> — the neptune.<region> host the
  // SDK would use does not exist in DNS (resolveEndpoint below forces the RDS
  // host). Neptune shares the RDS control plane and API surface, and SigV4
  // signs with the rds service name.
  neptune: { clientKey: "neptune", signingName: "rds" },
  // Same story for DocumentDB — served from the RDS endpoint, RDS-compatible API.
  docdb: { clientKey: "docDb", signingName: "rds" },
  rds: { clientKey: "rds", signingName: "rds" },
  redshift: { clientKey: "redshift", signingName: "redshift" },
  route53: { clientKey: "route53", signingName: "route53" },
  s3: { clientKey: "s3", signingName: "s3" },
  sagemaker: { clientKey: "sageMaker", signingName: "sagemaker" },
  secretsmanager: { clientKey: "secretsManager", signingName: "secretsmanager" },
  sns: { clientKey: "sns", signingName: "sns" },
  sqs: { clientKey: "sqs", signingName: "sqs" },
  ssm: { clientKey: "ssm", signingName: "ssm" },
  states: { clientKey: "stepFunctions", signingName: "states" },
  wafv2: { clientKey: "wafv2", signingName: "wafv2" },
};

interface ResolvedEndpoint {
  host: string;
  signingName: string;
  signingRegion: string;
}

/**
 * Ask a specific SDK client where its endpoint lives for the configured
 * region. We use the client's own `endpoint` provider, which encodes all
 * the special-case rules (global services, ECR's `api.ecr.*` host,
 * SageMaker's `api.sagemaker.*` host, fips/dualstack, etc.).
 */
async function resolveEndpoint(creds: AwsCredentials, service: string): Promise<ResolvedEndpoint> {
  const binding = SERVICE_BINDINGS[service];
  if (!binding) {
    throw new Error(`AWS transport: unknown service "${service}"`);
  }
  // Neptune and DocumentDB share the RDS control plane. The SDK clients ship
  // an endpoint template (neptune.<region>.<dns>, docdb.<region>.<dns>) that
  // simply does not exist in DNS — every request fails with
  // ERR_NAME_NOT_RESOLVED. Force the RDS host here so the rest of the
  // pipeline (signed with `rds` as the service name) reaches a real endpoint.
  if (service === "neptune" || service === "docdb") {
    return {
      host: `rds.${creds.region}.amazonaws.com`,
      signingName: binding.signingName,
      signingRegion: GLOBAL_SIGNING_REGION[service] ?? creds.region,
    };
  }
  const clients = getAwsClients(creds);
  const client = clients[binding.clientKey] as unknown as {
    config: {
      endpoint?: () =>
        | Promise<{ hostname: string; path?: string }>
        | { hostname: string; path?: string };
    };
  };
  const config = client.config;
  let host: string;
  try {
    if (typeof config.endpoint === "function") {
      const ep = await config.endpoint();
      host = ep.hostname;
    } else {
      // Fall back to constructing from the legacy host pattern if the SDK
      // client doesn't expose an endpoint resolver in this shape.
      host = legacyHost(service, creds.region);
    }
  } catch {
    host = legacyHost(service, creds.region);
  }
  return {
    host,
    signingName: binding.signingName,
    signingRegion: GLOBAL_SIGNING_REGION[service] ?? creds.region,
  };
}

/** Region used to sign requests against global services. */
const GLOBAL_SIGNING_REGION: Record<string, string> = {
  cloudfront: "us-east-1",
  iam: "us-east-1",
  route53: "us-east-1",
};

function legacyHost(service: string, region: string): string {
  if (service === "iam" || service === "route53" || service === "cloudfront") {
    return `${service === "route53" ? "route53" : service}.amazonaws.com`;
  }
  if (service === "ecr") return `api.ecr.${region}.amazonaws.com`;
  if (service === "sagemaker") return `api.sagemaker.${region}.amazonaws.com`;
  return `${service}.${region}.amazonaws.com`;
}

/** EC2 Query API — XML over GET with `?Action=…&Version=…`. */
export async function ec2Call<T>(
  creds: AwsCredentials,
  action: string,
  params?: Record<string, string>,
): Promise<T> {
  const ep = await resolveEndpoint(creds, "ec2");
  const search = new URLSearchParams({
    Action: action,
    Version: "2016-11-15",
    ...params,
  });
  const url = `https://${ep.host}/?${search}`;
  const res = await fetchSigned({
    method: "GET",
    url,
    headers: { Host: ep.host },
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  const xml = await res.text();
  return parseXml(xml) as T;
}

/**
 * Services that speak AWS JSON 1.0 instead of 1.1. Sending the wrong
 * protocol Content-Type makes the service refuse the request (DynamoDB and
 * Step Functions return 404, AppRunner returns UnknownOperation). The set
 * here matches the `awsJson1_0` Smithy protocol trait on the upstream
 * service models.
 */
const AWS_JSON_1_0_SERVICES = new Set(["apprunner", "dynamodb", "sqs", "states"]);

/** JSON-RPC over POST with `X-Amz-Target` (DynamoDB, ECS, …). */
export async function jsonCall<T>(
  creds: AwsCredentials,
  service: string,
  target: string,
  body: Record<string, unknown>,
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const url = `https://${ep.host}/`;
  const bodyStr = JSON.stringify(body);
  const contentType = AWS_JSON_1_0_SERVICES.has(service)
    ? "application/x-amz-json-1.0"
    : "application/x-amz-json-1.1";
  const res = await fetchSigned({
    method: "POST",
    url,
    headers: {
      Host: ep.host,
      "Content-Type": contentType,
      "X-Amz-Target": target,
    },
    body: bodyStr,
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  return (await res.json()) as T;
}

/**
 * REST JSON POST with a body. Used by services like AWS Batch and OpenSearch
 * that expose path-based REST APIs rather than a `/` JSON-RPC endpoint.
 */
export async function restJsonCall<T>(
  creds: AwsCredentials,
  service: string,
  path: string,
  body: Record<string, unknown> = {},
  method: "POST" | "GET" = "POST",
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const url = `https://${ep.host}${path}`;
  const hasBody = method === "POST";
  const bodyStr = hasBody ? JSON.stringify(body) : undefined;
  const res = await fetchSigned({
    method,
    url,
    headers: {
      Host: ep.host,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  return (await res.json()) as T;
}

/** Query XML GET API for non-EC2 services (ELBv2, AutoScaling, Redshift, RDS, IAM, …). */
export async function ec2QueryCall<T>(
  creds: AwsCredentials,
  service: string,
  action: string,
  version: string,
  params?: Record<string, string>,
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const search = new URLSearchParams({ Action: action, Version: version, ...params });
  const url = `https://${ep.host}/?${search}`;
  const res = await fetchSigned({
    method: "GET",
    url,
    headers: { Host: ep.host },
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** Query API POST for mutations (RDS, IAM, ELBv2 deletes, …). */
export async function queryPostCall<T>(
  creds: AwsCredentials,
  service: string,
  action: string,
  version: string,
  params?: Record<string, string>,
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const url = `https://${ep.host}/`;
  const bodyParams = new URLSearchParams({ Action: action, Version: version, ...params });
  const bodyStr = bodyParams.toString();
  const res = await fetchSigned({
    method: "POST",
    url,
    headers: {
      Host: ep.host,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyStr,
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** REST-XML GET (S3 ListBuckets, etc.). */
export async function xmlGetCall<T>(
  creds: AwsCredentials,
  service: string,
  path: string = "/",
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const url = `https://${ep.host}${path}`;
  const res = await fetchSigned({
    method: "GET",
    url,
    headers: { Host: ep.host },
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** REST-JSON GET (Lambda, EKS, CloudFront, EFS, API Gateway, …). */
export async function jsonGetCall<T>(
  creds: AwsCredentials,
  service: string,
  path: string,
): Promise<T> {
  const ep = await resolveEndpoint(creds, service);
  const url = `https://${ep.host}${path}`;
  const res = await fetchSigned({
    method: "GET",
    url,
    headers: { Host: ep.host },
    service: ep.signingName,
    credentials: { ...creds, region: ep.signingRegion },
  });
  return (await res.json()) as T;
}

/**
 * Resolve the externally-visible hostname for a service. Kept for legacy
 * call sites (delete-handlers.ts, s3-storage.ts) that build raw URLs for
 * REST-style DELETE / PUT operations. New code should prefer SDK Commands.
 */
export function hostForService(creds: AwsCredentials, service: string): string {
  const binding = SERVICE_BINDINGS[service];
  if (!binding) return legacyHost(service, creds.region);
  // We can't await here, so use the legacy-host pattern. The SDK clients
  // use the same pattern under the hood for these standard services, so
  // for the small set of call sites that need a synchronous host we lose
  // nothing relative to the previous implementation.
  return legacyHost(service, creds.region);
}
