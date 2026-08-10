/**
 * Credential preflight + least-privilege policy template for AWS.
 *
 * Probe strategy (all read-only):
 *   1. `sts:GetCallerIdentity` — resolves the caller ARN; needs no permission
 *      at all (verified: even an explicit deny doesn't block it), so a failure
 *      here means the keys themselves are bad.
 *   2. `iam:SimulatePrincipalPolicy` with the caller ARN and every declared
 *      action — gives an exact allowed / denied verdict per permission.
 *   3. When the credential can't call the simulator (it's an IAM action many
 *      minimal policies omit), fall back to one cheap dry-run probe per
 *      capability and report at probe granularity instead.
 *
 * API facts verified against the AWS API references (2026):
 *   - SimulatePrincipalPolicy: IAM Query API, Version 2010-05-08, params
 *     `PolicySourceArn` + `ActionNames.member.N`; response
 *     `EvaluationResults` members with `EvalActionName` and `EvalDecision`
 *     in {allowed, explicitDeny, implicitDeny}.
 *   - GetCallerIdentity: sts.amazonaws.com, Version 2011-06-15, returns
 *     `Arn` / `Account` in `GetCallerIdentityResult`.
 */
import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightPermission,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { fetchSigned } from "./signed-request.js";
import { queryPostCall } from "./client-transport.js";
import { parseXml, ensureArray } from "./xml.js";

const RESOURCES_PERMISSIONS: PreflightPermission[] = [
  { id: "ec2:DescribeInstances", label: "List EC2 instances" },
  { id: "s3:ListAllMyBuckets", label: "List S3 buckets" },
  { id: "rds:DescribeDBInstances", label: "List RDS instances" },
  { id: "lambda:ListFunctions", label: "List Lambda functions" },
  { id: "dynamodb:ListTables", label: "List DynamoDB tables" },
];

const METRICS_PERMISSIONS: PreflightPermission[] = [
  { id: "cloudwatch:GetMetricStatistics", label: "Read CloudWatch metric datapoints" },
  { id: "cloudwatch:GetMetricData", label: "Read CloudWatch metric series" },
  { id: "cloudwatch:ListMetrics", label: "Enumerate CloudWatch metrics" },
];

const COSTS_PERMISSIONS: PreflightPermission[] = [
  { id: "ce:GetCostAndUsage", label: "Read Cost Explorer cost and usage data" },
];

export const awsPreflight: PreflightDeclaration = {
  capabilities: [
    {
      id: "resources",
      label: "Resource inventory",
      description:
        "Read-only Describe/List access across EC2, S3, RDS, Lambda and the other services the plugin lists. Checked via a representative sample.",
      requiredPermissions: RESOURCES_PERMISSIONS,
      essential: true,
    },
    {
      id: "metrics",
      label: "Metrics & dashboards",
      description: "CloudWatch metric series for resource dashboards and rightsizing.",
      requiredPermissions: METRICS_PERMISSIONS,
    },
    {
      id: "costs",
      label: "Cost reporting",
      description: "Daily spend via Cost Explorer — not part of typical read-only infra policies.",
      requiredPermissions: COSTS_PERMISSIONS,
    },
  ],
  templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
};

const IAM_HELP_LINK = {
  label: "Open the IAM console",
  url: "https://console.aws.amazon.com/iam/home#/users",
};

/**
 * Read actions granted per capability in the generated policy. Deliberately
 * broader than the probed sample for `resources`: the template must cover
 * every lister the plugin ships, and per-service read wildcards stay
 * auditable while surviving new resource types within a service.
 */
const TEMPLATE_ACTIONS: Record<string, string[]> = {
  resources: [
    "acm:DescribeCertificate",
    "acm:ListCertificates",
    "apigateway:GET",
    "apprunner:DescribeService",
    "apprunner:ListServices",
    "autoscaling:Describe*",
    "backup:ListBackupVaults",
    "batch:DescribeJobQueues",
    "cloudformation:DescribeStacks",
    "cloudformation:ListStacks",
    "cloudfront:ListDistributions",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "cloudwatch:DescribeAlarms",
    "codebuild:BatchGetProjects",
    "codebuild:ListProjects",
    "codepipeline:GetPipeline",
    "codepipeline:ListPipelines",
    "cognito-idp:DescribeUserPool",
    "cognito-idp:ListUserPools",
    "dynamodb:Describe*",
    "dynamodb:ListTables",
    "ec2:Describe*",
    "ecr:DescribeRepositories",
    "ecs:Describe*",
    "ecs:List*",
    "eks:Describe*",
    "eks:List*",
    "elasticache:Describe*",
    "elasticfilesystem:DescribeFileSystems",
    "elasticloadbalancing:Describe*",
    "es:DescribeDomains",
    "es:ListDomainNames",
    "events:ListRules",
    "glue:GetDatabases",
    "iam:GetRole",
    "iam:GetUser",
    "iam:ListRoles",
    "iam:ListUsers",
    "kafka:ListClustersV2",
    "kinesis:DescribeStreamSummary",
    "kinesis:ListStreams",
    "lambda:GetFunction",
    "lambda:ListFunctions",
    "logs:DescribeLogGroups",
    "mq:ListBrokers",
    "rds:Describe*",
    "redshift:DescribeClusters",
    "route53:Get*",
    "route53:List*",
    "s3:GetBucketLocation",
    "s3:ListAllMyBuckets",
    "s3:ListBucket",
    "sagemaker:DescribeEndpoint",
    "sagemaker:ListEndpoints",
    "secretsmanager:DescribeSecret",
    "secretsmanager:ListSecrets",
    "sns:GetTopicAttributes",
    "sns:ListTopics",
    "sqs:GetQueueAttributes",
    "sqs:ListQueues",
    "ssm:DescribeParameters",
    "states:DescribeStateMachine",
    "states:ListStateMachines",
    "wafv2:ListWebACLs",
  ],
  metrics: METRICS_PERMISSIONS.map((p) => p.id),
  costs: COSTS_PERMISSIONS.map((p) => p.id),
};

/** Build the paste-ready IAM policy scoped to the selected capabilities. */
export function buildAwsPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = awsPreflight.capabilities.filter((c) => capabilityIds.includes(c.id));
  const statements = selected.map((c) => ({
    Sid: `Infrawrench${c.id.charAt(0).toUpperCase()}${c.id.slice(1)}`,
    Effect: "Allow",
    Action: TEMPLATE_ACTIONS[c.id] ?? c.requiredPermissions.map((p) => p.id),
    Resource: "*",
  }));
  // Lets future preflights return exact per-action results instead of the
  // dry-run fallback. Harmless read-only introspection.
  statements.push({
    Sid: "InfrawrenchPreflight",
    Effect: "Allow",
    Action: ["iam:SimulatePrincipalPolicy"],
    Resource: "*",
  });
  return {
    formatLabel: "AWS IAM policy (JSON)",
    language: "json",
    document: JSON.stringify({ Version: "2012-10-17", Statement: statements }, null, 2),
    instructions:
      "Attach as an inline policy on the IAM user (or role) whose keys you entered: IAM console → Users → your user → Add permissions → Create inline policy → JSON.",
    helpLink: IAM_HELP_LINK,
  };
}

interface CallerIdentity {
  arn: string;
  account: string;
}

async function getCallerIdentity(creds: AwsCredentials): Promise<CallerIdentity> {
  const body = new URLSearchParams({
    Action: "GetCallerIdentity",
    Version: "2011-06-15",
  }).toString();
  const res = await fetchSigned({
    method: "POST",
    url: "https://sts.amazonaws.com/",
    headers: { Host: "sts.amazonaws.com", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    service: "sts",
    // STS's global endpoint signs as us-east-1 regardless of home region.
    credentials: { ...creds, region: "us-east-1" },
  });
  // parseXml unwraps the single response root, so the result element sits at
  // the top level; keep the wrapped fallback for safety.
  const xml = parseXml(await res.text());
  const result = (xml["GetCallerIdentityResult"] ??
    (xml["GetCallerIdentityResponse"] as Record<string, unknown> | undefined)?.[
      "GetCallerIdentityResult"
    ] ??
    {}) as Record<string, unknown>;
  return { arn: String(result["Arn"] ?? ""), account: String(result["Account"] ?? "") };
}

/**
 * Turn the STS caller ARN into the IAM principal ARN the simulator accepts.
 * Assumed-role sessions (`arn:aws:sts::acct:assumed-role/name/session`) map
 * back to the role (`arn:aws:iam::acct:role/name`). Returns null for the
 * account root, which has every permission and can't be simulated.
 */
export function principalArnForSimulation(callerArn: string): string | null {
  if (/^arn:aws:iam::\d+:root$/.test(callerArn)) return null;
  const assumed = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(callerArn);
  if (assumed) return `arn:aws:iam::${assumed[1]}:role/${assumed[2]}`;
  return callerArn;
}

/** Map of action → allowed, from one SimulatePrincipalPolicy call. */
export function parseSimulationResults(xml: Record<string, unknown>): Map<string, boolean> {
  // parseXml unwraps the single response root, so the result element sits at
  // the top level; keep the wrapped fallback for safety.
  const result = (xml["SimulatePrincipalPolicyResult"] ??
    (xml["SimulatePrincipalPolicyResponse"] as Record<string, unknown> | undefined)?.[
      "SimulatePrincipalPolicyResult"
    ] ??
    {}) as Record<string, unknown>;
  const container = result["EvaluationResults"] as Record<string, unknown> | undefined;
  const members = ensureArray(container?.["member"]) as Array<Record<string, unknown>>;
  const verdicts = new Map<string, boolean>();
  for (const m of members) {
    const action = String(m["EvalActionName"] ?? "");
    if (!action) continue;
    verdicts.set(action, String(m["EvalDecision"] ?? "") === "allowed");
  }
  return verdicts;
}

async function simulateActions(
  creds: AwsCredentials,
  principalArn: string,
  actions: string[],
): Promise<Map<string, boolean>> {
  const params: Record<string, string> = { PolicySourceArn: principalArn };
  actions.forEach((a, i) => {
    params[`ActionNames.member.${i + 1}`] = a;
  });
  const raw = await queryPostCall<Record<string, unknown>>(
    creds,
    "iam",
    "SimulatePrincipalPolicy",
    "2010-05-08",
    params,
  );
  return parseSimulationResults(raw);
}

function isAccessDenied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /AccessDenied|UnauthorizedOperation|not authorized|status: 403|failed: 403/i.test(msg);
}

function shortMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
}

/** One cheap read-only probe per capability, used when the simulator is off-limits. */
async function probeCapability(creds: AwsCredentials, capabilityId: string): Promise<void> {
  if (capabilityId === "resources") {
    await queryPostCall(creds, "ec2", "DescribeInstances", "2016-11-15", { MaxResults: "5" });
    return;
  }
  if (capabilityId === "metrics") {
    await queryPostCall(creds, "monitoring", "ListMetrics", "2010-08-01", {
      Namespace: "AWS/EC2",
    });
    return;
  }
  // costs — the smallest possible GetCostAndUsage (CE bills ~$0.01/request,
  // only paid on this fallback path).
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const start = startDate.toISOString().slice(0, 10);
  const res = await fetchSigned({
    method: "POST",
    url: "https://ce.us-east-1.amazonaws.com/",
    headers: {
      Host: "ce.us-east-1.amazonaws.com",
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage",
    },
    body: JSON.stringify({
      TimePeriod: { Start: start, End: end },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
    }),
    service: "ce",
    credentials: { ...creds, region: "us-east-1" },
  });
  await res.text();
}

/** The single probed permission a fallback probe vouches for, per capability. */
const PROBE_PERMISSION: Record<string, PreflightPermission> = {
  resources: RESOURCES_PERMISSIONS[0]!,
  metrics: METRICS_PERMISSIONS[2]!,
  costs: COSTS_PERMISSIONS[0]!,
};

function missingCheck(
  capability: PreflightCapability,
  missing: PreflightPermission[],
  message?: string,
): PreflightCapabilityCheck {
  return {
    capabilityId: capability.id,
    status: "missing",
    missingPermissions: missing,
    ...(message ? { message } : {}),
    helpLink: IAM_HELP_LINK,
  };
}

export async function runAwsPreflight(creds: AwsCredentials): Promise<PreflightResult> {
  const capabilities = awsPreflight.capabilities;

  let identity: CallerIdentity;
  try {
    identity = await getCallerIdentity(creds);
  } catch (e) {
    // GetCallerIdentity needs no permissions, so failure means the keys are
    // wrong (or AWS is unreachable) — nothing else can be verified.
    const invalid =
      isAccessDenied(e) || /InvalidClientTokenId|SignatureDoesNotMatch/i.test(String(e));
    return {
      checks: capabilities.map((c) =>
        invalid
          ? missingCheck(c, [], "The access keys were rejected by AWS — check both values.")
          : { capabilityId: c.id, status: "unknown", message: shortMessage(e) },
      ),
    };
  }

  const principalArn = principalArnForSimulation(identity.arn);
  if (principalArn === null) {
    // Root credentials hold every permission by definition.
    return {
      identity: identity.arn,
      checks: capabilities.map((c) => ({ capabilityId: c.id, status: "ok" as const })),
    };
  }

  // Exact path: one simulator call covering every declared action.
  try {
    const allActions = capabilities.flatMap((c) => c.requiredPermissions.map((p) => p.id));
    const verdicts = await simulateActions(creds, principalArn, allActions);
    return {
      identity: identity.arn,
      checks: capabilities.map((c) => {
        const missing = c.requiredPermissions.filter((p) => verdicts.get(p.id) !== true);
        if (missing.length === 0) return { capabilityId: c.id, status: "ok" as const };
        return missingCheck(c, missing);
      }),
    };
  } catch (e) {
    if (!isAccessDenied(e)) {
      return {
        identity: identity.arn,
        checks: capabilities.map((c) => ({
          capabilityId: c.id,
          status: "unknown" as const,
          message: shortMessage(e),
        })),
      };
    }
  }

  // Fallback path: the credential can't call the simulator — dry-run one
  // representative read per capability instead.
  const checks: PreflightCapabilityCheck[] = [];
  for (const c of capabilities) {
    try {
      await probeCapability(creds, c.id);
      checks.push({ capabilityId: c.id, status: "ok" });
    } catch (e) {
      if (isAccessDenied(e)) {
        checks.push(
          missingCheck(
            c,
            [PROBE_PERMISSION[c.id]!],
            "Detected by a sample request — grant iam:SimulatePrincipalPolicy for an exact per-permission report.",
          ),
        );
      } else {
        checks.push({ capabilityId: c.id, status: "unknown", message: shortMessage(e) });
      }
    }
  }
  return { identity: identity.arn, checks };
}
