import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../xml.js";
import { joinIds, type ListerContext } from "../resource-listers.js";
import { fetchSigned } from "../signed-request.js";

export async function listAutoScalingGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.ec2Query<Record<string, unknown>>(
    "autoscaling",
    "DescribeAutoScalingGroups",
    "2011-01-01",
  );
  const groups = ensureArray(
    (data["AutoScalingGroups"] as Record<string, unknown> | undefined)?.["member"],
  ) as Record<string, unknown>[];

  return groups.map((asg) => {
    const name = String(asg["AutoScalingGroupName"] ?? "");
    const azs = ensureArray(
      (asg["AvailabilityZones"] as Record<string, unknown> | undefined)?.["member"],
    ) as string[];
    const instances = ensureArray(
      (asg["Instances"] as Record<string, unknown> | undefined)?.["member"],
    ) as unknown[];
    const launchTemplate = asg["LaunchTemplate"] as Record<string, unknown> | undefined;
    // VPCZoneIdentifier is AWS's own comma-joined subnet list; re-joining it
    // normalises the separator the graph splits on.
    const subnetIds = joinIds(String(asg["VPCZoneIdentifier"] ?? "").split(","));
    const targetGroupArns = joinIds(
      ensureArray((asg["TargetGroupARNs"] as Record<string, unknown> | undefined)?.["member"]),
    );

    return {
      id: ctx.id(accountId, "auto-scaling-group", name),
      pluginId: "aws",
      resourceTypeId: "auto-scaling-group",
      accountId,
      displayName: name,
      fields: {
        name,
        region: ctx.region,
        minSize: Number(asg["MinSize"] ?? 0),
        maxSize: Number(asg["MaxSize"] ?? 0),
        desiredCapacity: Number(asg["DesiredCapacity"] ?? 0),
        status: String(asg["Status"] ?? ""),
        healthCheckType: String(asg["HealthCheckType"] ?? ""),
        availabilityZones: azs.join(", "),
        launchTemplate: launchTemplate
          ? `${launchTemplate["LaunchTemplateName"]}@${launchTemplate["Version"]}`
          : "",
        instanceCount: instances.length,
        subnetIds,
        targetGroupArns,
      },
      resolvedOutputs: {
        autoScalingGroupArn: String(asg["AutoScalingGroupARN"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(asg["CreatedTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppRunnerServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{
    ServiceSummaryList?: Record<string, unknown>[];
  }>("apprunner", "AppRunner.ListServices", {});
  const services = data.ServiceSummaryList ?? [];

  return services.map((svc) => {
    const serviceName = String(svc["ServiceName"] ?? "");
    return {
      id: ctx.id(accountId, "apprunner-service", serviceName),
      pluginId: "aws",
      resourceTypeId: "apprunner-service",
      accountId,
      displayName: serviceName,
      fields: {
        serviceName,
        region: ctx.region,
        status: String(svc["Status"] ?? ""),
        serviceId: String(svc["ServiceId"] ?? ""),
        sourceType: "",
        cpu: "",
        memory: "",
      },
      resolvedOutputs: {
        serviceUrl: String(svc["ServiceUrl"] ?? ""),
        serviceArn: String(svc["ServiceArn"] ?? ""),
      },
      secretStates: [],
      externalId: serviceName,
      createdAt: String(svc["CreatedAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listBatchJobQueues(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // AWS Batch is REST-JSON over /v1/*: JSON-RPC at `/` returns 404.
  const data = await ctx.restJson<{ jobQueues?: Record<string, unknown>[] }>(
    "batch",
    "/v1/describejobqueues",
    {},
  );
  const queues = data.jobQueues ?? [];

  return queues.map((q) => {
    const name = String(q["jobQueueName"] ?? "");
    return {
      id: ctx.id(accountId, "batch-job-queue", name),
      pluginId: "aws",
      resourceTypeId: "batch-job-queue",
      accountId,
      displayName: name,
      fields: {
        jobQueueName: name,
        region: ctx.region,
        state: String(q["state"] ?? ""),
        status: String(q["status"] ?? ""),
        priority: Number(q["priority"] ?? 0),
        schedulingPolicyArn: String(q["schedulingPolicyArn"] ?? ""),
      },
      resolvedOutputs: {
        jobQueueArn: String(q["jobQueueArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSageMakerEndpoints(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.json<{ Endpoints?: Record<string, unknown>[] }>(
    "sagemaker",
    "SageMaker.ListEndpoints",
    {},
  );
  const endpoints = data.Endpoints ?? [];

  return endpoints.map((ep) => {
    const name = String(ep["EndpointName"] ?? "");
    return {
      id: ctx.id(accountId, "sagemaker-endpoint", name),
      pluginId: "aws",
      resourceTypeId: "sagemaker-endpoint",
      accountId,
      displayName: name,
      fields: {
        endpointName: name,
        region: ctx.region,
        status: String(ep["EndpointStatus"] ?? ""),
        endpointConfigName: String(ep["EndpointConfigName"] ?? ""),
        creationTime: String(ep["CreationTime"] ?? ""),
        lastModifiedTime: String(ep["LastModifiedTime"] ?? ""),
      },
      resolvedOutputs: {
        endpointArn: String(ep["EndpointArn"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: String(ep["CreationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

/**
 * List Bedrock models the Converse playground can drive, from two
 * control-plane calls signed under service `bedrock` (we sign directly with
 * `fetchSigned` because the endpoint follows the plain
 * `bedrock.<region>.amazonaws.com` pattern and pulling in
 * `@aws-sdk/client-bedrock` just for an endpoint resolver isn't worth it):
 *
 *   - `GET /foundation-models`, filtered to models whose `outputModalities`
 *     include TEXT and whose `inferenceTypesSupported` include ON_DEMAND, the
 *     only ones Converse accepts by bare model id.
 *   - `GET /inference-profiles` (system-defined cross-region profiles and the
 *     account's own application profiles). Most models released since late
 *     2024 are INFERENCE_PROFILE-only, so without these the list would miss
 *     every current Anthropic, Meta and Amazon Nova model. A profile is kept
 *     when it is ACTIVE and routes to at least one TEXT-output foundation
 *     model; Converse takes the profile id in place of a model id.
 *     https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html
 *
 * The profile call is best-effort: a key without
 * `bedrock:ListInferenceProfiles` still gets the on-demand models.
 */

interface BedrockFoundationModel {
  modelId: string;
  modelName: string;
  providerName: string;
  arn: string;
  text: boolean;
  onDemand: boolean;
  streaming: boolean;
  lifecycle: string;
}

function parseFoundationModel(m: Record<string, unknown>): BedrockFoundationModel {
  const outputModalities = Array.isArray(m["outputModalities"])
    ? (m["outputModalities"] as string[])
    : [];
  const inferenceTypes = Array.isArray(m["inferenceTypesSupported"])
    ? (m["inferenceTypesSupported"] as string[])
    : [];
  const modelId = String(m["modelId"] ?? "");
  const lifecycle = m["modelLifecycle"] as Record<string, unknown> | undefined;
  return {
    modelId,
    modelName: String(m["modelName"] ?? modelId),
    providerName: String(m["providerName"] ?? ""),
    arn: String(m["modelArn"] ?? ""),
    text: outputModalities.includes("TEXT"),
    onDemand: inferenceTypes.includes("ON_DEMAND"),
    streaming: Boolean(m["responseStreamingSupported"]),
    lifecycle: String(lifecycle?.["status"] ?? "ACTIVE"),
  };
}

/** `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-…` → model id. */
export function foundationModelIdFromArn(arn: string): string {
  const marker = "foundation-model/";
  const i = arn.indexOf(marker);
  return i >= 0 ? arn.slice(i + marker.length) : "";
}

async function fetchInferenceProfiles(
  ctx: ListerContext,
  host: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ maxResults: "1000" });
    if (nextToken) query.set("nextToken", nextToken);
    const res = await fetchSigned({
      method: "GET",
      url: `https://${host}/inference-profiles?${query}`,
      headers: { Host: host },
      service: "bedrock",
      credentials: ctx.creds,
    });
    const data = (await res.json()) as {
      inferenceProfileSummaries?: Array<Record<string, unknown>>;
      nextToken?: string;
    };
    out.push(...(data.inferenceProfileSummaries ?? []));
    nextToken = data.nextToken || undefined;
    if (!nextToken) break;
  }
  return out;
}

export async function listBedrockModels(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const host = `bedrock.${ctx.region}.amazonaws.com`;
  const res = await fetchSigned({
    method: "GET",
    url: `https://${host}/foundation-models`,
    headers: { Host: host },
    service: "bedrock",
    credentials: ctx.creds,
  });
  const data = (await res.json()) as {
    modelSummaries?: Array<Record<string, unknown>>;
  };
  const models = (data.modelSummaries ?? []).map(parseFoundationModel);
  const byId = new Map(models.map((m) => [m.modelId, m]));

  const make = (
    modelId: string,
    displayName: string,
    fields: Record<string, unknown>,
    arn: string,
  ): ResourceInstance => ({
    id: ctx.id(accountId, "bedrock-model", modelId),
    pluginId: "aws",
    resourceTypeId: "bedrock-model",
    accountId,
    displayName,
    fields: {
      modelId,
      region: ctx.region,
      ...fields,
      // Static "active": catalog entries have no lifecycle of their own, so
      // the host renders a healthy dot via the status map.
      status: "active",
    },
    resolvedOutputs: { arn },
    secretStates: [],
    externalId: modelId,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
  });

  const results: ResourceInstance[] = models
    .filter((m) => m.text && m.onDemand)
    .map((m) =>
      make(
        m.modelId,
        m.modelName,
        {
          modelName: m.modelName,
          providerName: m.providerName,
          kind: "foundation-model",
          lifecycleStatus: m.lifecycle,
          sourceModels: "",
          streamingSupported: m.streaming,
        },
        m.arn,
      ),
    );

  let profiles: Array<Record<string, unknown>> = [];
  try {
    profiles = await fetchInferenceProfiles(ctx, host);
  } catch {
    // Missing bedrock:ListInferenceProfiles: keep the on-demand models.
  }
  for (const p of profiles) {
    if (String(p["status"] ?? "ACTIVE") !== "ACTIVE") continue;
    const isApplication = String(p["type"] ?? "") === "APPLICATION";
    const profileArn = String(p["inferenceProfileArn"] ?? "");
    // Application profiles are addressed by ARN (their bare id is a random
    // token the console never shows); system profiles by their readable id.
    const profileId = isApplication ? profileArn : String(p["inferenceProfileId"] ?? "");
    if (!profileId) continue;
    const sourceIds = [
      ...new Set(
        (Array.isArray(p["models"]) ? (p["models"] as Array<Record<string, unknown>>) : [])
          .map((m) => foundationModelIdFromArn(String(m["modelArn"] ?? "")))
          .filter(Boolean),
      ),
    ];
    const sources = sourceIds
      .map((id) => byId.get(id))
      .filter((m): m is BedrockFoundationModel => m !== undefined);
    if (!sources.some((m) => m.text)) continue;
    const first = sources[0]!;
    const name = String(p["inferenceProfileName"] ?? profileId);
    results.push(
      make(
        profileId,
        name,
        {
          modelName: name,
          providerName: first.providerName,
          kind: isApplication ? "application-inference-profile" : "inference-profile",
          lifecycleStatus: sources.some((m) => m.lifecycle === "LEGACY") ? "LEGACY" : "ACTIVE",
          sourceModels: sourceIds.join(", "),
          streamingSupported: sources.every((m) => m.streaming),
        },
        profileArn,
      ),
    );
  }
  return results;
}
