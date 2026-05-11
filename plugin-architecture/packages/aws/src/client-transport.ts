import type { AwsCredentials } from "./auth.js";
import { signRequest, parseXml } from "./auth.js";

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
export const GLOBAL_SERVICES = new Set(["cloudfront", "iam", "route53"]);

export function hostForService(creds: AwsCredentials, service: string): string {
  const template = SERVICE_HOSTS[service] ?? `${service}.${creds.region}.amazonaws.com`;
  return template.replace("{region}", creds.region);
}

/** Make an EC2-style XML query API call */
export async function ec2Call<T>(
  creds: AwsCredentials,
  action: string,
  params?: Record<string, string>,
): Promise<T> {
  const host = hostForService(creds, "ec2");
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
    credentials: creds,
  });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`EC2 ${action} failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** Make a JSON API call (DynamoDB, ECS, etc.) */
export async function jsonCall<T>(
  creds: AwsCredentials,
  service: string,
  target: string,
  body: Record<string, unknown>,
): Promise<T> {
  const host = hostForService(creds, service);
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
    credentials: creds,
  });
  const res = await fetch(url, { method: "POST", headers, body: bodyStr });
  if (!res.ok) throw new Error(`${service} ${target} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Make an XML Query API call for non-EC2 services */
export async function ec2QueryCall<T>(
  creds: AwsCredentials,
  service: string,
  action: string,
  version: string,
  params?: Record<string, string>,
): Promise<T> {
  const host = hostForService(creds, service);
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
    credentials: creds,
  });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${service} ${action} failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** Make a Query API POST call for mutations (Create/Delete on RDS, IAM, etc.) */
export async function queryPostCall<T>(
  creds: AwsCredentials,
  service: string,
  action: string,
  version: string,
  params?: Record<string, string>,
): Promise<T> {
  const host = hostForService(creds, service);
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
    credentials: creds,
  });
  const res = await fetch(url, { method: "POST", headers, body: bodyStr });
  if (!res.ok) throw new Error(`${service} ${action} failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** Make a signed XML GET request to a service path (e.g. S3 ListBuckets) */
export async function xmlGetCall<T>(
  creds: AwsCredentials,
  service: string,
  path: string = "/",
): Promise<T> {
  const host = hostForService(creds, service);
  const url = `https://${host}${path}`;
  const headers = await signRequest({
    method: "GET",
    url,
    headers: { Host: host },
    service,
    credentials: creds,
  });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${service} GET ${path} failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** Make a JSON REST GET call (Lambda, EKS, CloudFront) */
export async function jsonGetCall<T>(
  creds: AwsCredentials,
  service: string,
  path: string,
): Promise<T> {
  const host = hostForService(creds, service);
  const url = `https://${host}${path}`;
  const headers = await signRequest({
    method: "GET",
    url,
    headers: { Host: host },
    service,
    credentials: creds,
  });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${service} GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}
