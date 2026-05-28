import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ensureArray } from "../auth.js";
import type { ListerContext } from "../resource-listers.js";
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
  // AWS Batch is REST-JSON over /v1/* — JSON-RPC at `/` returns 404.
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
 * List Bedrock foundation models via the control-plane
 * `GET /foundation-models` endpoint (signed under service `bedrock`). We sign
 * directly with `fetchSigned` rather than going through the SDK-backed
 * `client-transport` helpers because the Bedrock endpoint follows the plain
 * `bedrock.<region>.amazonaws.com` host pattern and pulling in
 * `@aws-sdk/client-bedrock` just for an endpoint resolver isn't worth it.
 *
 * Filtered to models the Converse API can drive directly by `modelId`:
 *   - `outputModalities` includes "TEXT" (skip image/embedding-only models)
 *   - `inferenceTypesSupported` includes "ON_DEMAND" (models that require an
 *     inference profile or provisioned throughput can't be Converse'd by bare
 *     modelId, so listing them would only produce failing chat sessions).
 */

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
  const summaries = data.modelSummaries ?? [];

  return summaries
    .filter((m) => {
      const outputModalities = Array.isArray(m["outputModalities"])
        ? (m["outputModalities"] as string[])
        : [];
      const inferenceTypes = Array.isArray(m["inferenceTypesSupported"])
        ? (m["inferenceTypesSupported"] as string[])
        : [];
      return outputModalities.includes("TEXT") && inferenceTypes.includes("ON_DEMAND");
    })
    .map((m) => {
      const modelId = String(m["modelId"] ?? "");
      const modelName = String(m["modelName"] ?? modelId);
      return {
        id: ctx.id(accountId, "bedrock-model", modelId),
        pluginId: "aws",
        resourceTypeId: "bedrock-model",
        accountId,
        displayName: modelName,
        fields: {
          modelId,
          modelName,
          region: ctx.region,
          providerName: String(m["providerName"] ?? ""),
          streamingSupported: Boolean(m["responseStreamingSupported"]),
          // Static "active" — foundation models are catalog entries with no
          // lifecycle, so the host renders a healthy dot via the status map.
          status: "active",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: modelId,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      };
    });
}
