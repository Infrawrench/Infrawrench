import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";

export async function listCloudRunServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://run.googleapis.com/v2/projects/${p}/locations/-/services`,
    "services",
  );
  return items.map((svc) => {
    const fullName = String(svc["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    // Cloud Run v2 surfaces overall readiness via `terminalCondition` (the
    // sibling `conditions[]` array is for sub-resources, not the service
    // itself). Map the condition state + the `reconciling` flag into a
    // simple UI label.
    const terminal = svc["terminalCondition"] as Record<string, unknown> | undefined;
    const reconciling = svc["reconciling"] === true;
    const condState = String(terminal?.["state"] ?? "");
    let state = "UNKNOWN";
    if (reconciling) {
      state = "PROVISIONING";
    } else if (condState === "CONDITION_SUCCEEDED") {
      state = "READY";
    } else if (condState === "CONDITION_FAILED") {
      state = "FAILED";
    } else if (condState === "CONDITION_PENDING" || condState === "CONDITION_RECONCILING") {
      state = "PROVISIONING";
    }
    const template = (svc["template"] as Record<string, unknown> | undefined) ?? {};
    const containers = (template["containers"] as Array<Record<string, unknown>> | undefined) ?? [];
    const image = String(containers[0]?.["image"] ?? "");
    const annotations = (svc["annotations"] as Record<string, unknown> | undefined) ?? {};
    const sourceLocation = String(annotations["client.knative.dev/source-location"] ?? "");
    const traffic = (svc["traffic"] as unknown[] | undefined) ?? [];
    const vpcAccess = template["vpcAccess"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "cloud-run-service", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-run-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        latestRevision:
          String(svc["latestReadyRevision"] ?? "")
            .split("/")
            .pop() ?? "",
        state,
        ingress: String(svc["ingress"] ?? ""),
        lastModifier: String(svc["lastModifier"] ?? ""),
        image,
        deployClient: String(svc["client"] ?? ""),
        deployClientVersion: String(svc["clientVersion"] ?? ""),
        sourceLocation,
        serviceAccount: String(template["serviceAccount"] ?? ""),
      },
      resolvedOutputs: {
        url: String(svc["uri"] ?? ""),
        traffic: JSON.stringify(traffic),
        ...(vpcAccess ? { vpcAccess: JSON.stringify(vpcAccess) } : {}),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: String(svc["createTime"] ?? ctx.now()),
      updatedAt: String(svc["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listCloudFunctions(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/-/functions`,
    "functions",
  );
  return items.map((fn) => {
    const fullName = String(fn["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    const serviceConfig = fn["serviceConfig"] as Record<string, unknown> | undefined;
    const buildConfig = fn["buildConfig"] as Record<string, unknown> | undefined;
    const stateMessages =
      (fn["stateMessages"] as
        Array<{ severity?: string; type?: string; message?: string }> | undefined) ?? [];
    const stateMessage = stateMessages
      .map((m) => `[${m.severity ?? "INFO"}] ${m.type ? `${m.type}: ` : ""}${m.message ?? ""}`)
      .join("\n");
    const source = (buildConfig?.["source"] as Record<string, unknown> | undefined) ?? {};
    const storageSource = (source["storageSource"] as Record<string, unknown> | undefined) ?? {};
    const bucket = String(storageSource["bucket"] ?? "");
    const object = String(storageSource["object"] ?? "");
    const sourceLocation = bucket ? `gs://${bucket}/${object}` : "";
    const cloudRunServiceName = String(serviceConfig?.["service"] ?? "");
    return {
      id: ctx.id(accountId, "cloud-function", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        runtime: String(buildConfig?.["runtime"] ?? ""),
        state: String(fn["state"] ?? ""),
        stateMessage,
        availableMemory: String(serviceConfig?.["availableMemory"] ?? ""),
        timeout: String(serviceConfig?.["timeoutSeconds"] ?? ""),
        ingress: String(serviceConfig?.["ingressSettings"] ?? ""),
        image: "",
        lastModifier: "",
        latestRevision: "",
        serviceAccount: String(serviceConfig?.["serviceAccountEmail"] ?? ""),
        entryPoint: String(buildConfig?.["entryPoint"] ?? ""),
        sourceLocation,
        // The bucket half of `sourceLocation`, on its own so it matches a
        // gcs-bucket external id (which is the bare bucket name).
        sourceBucket: bucket,
        environment: String(fn["environment"] ?? ""),
        buildId: String(buildConfig?.["build"] ?? ""),
        minInstances: String(serviceConfig?.["minInstanceCount"] ?? "0"),
        maxInstances: String(serviceConfig?.["maxInstanceCount"] ?? "100"),
        concurrency: String(serviceConfig?.["maxInstanceRequestConcurrency"] ?? "1"),
      },
      resolvedOutputs: {
        url: String(serviceConfig?.["uri"] ?? ""),
        cloudRunServiceName,
      },
      secretStates: [],
      externalId: fullName,
      createdAt: String(fn["createTime"] ?? ctx.now()),
      updatedAt: String(fn["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listAppEngineServices(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ services?: Record<string, unknown>[] }>(
    `https://appengine.googleapis.com/v1/apps/${p}/services`,
  );
  const items = data.services ?? [];
  return items.map((svc) => {
    const name = String(svc["id"] ?? svc["name"] ?? "");
    const split = svc["split"] as Record<string, unknown> | undefined;
    const allocations = split?.["allocations"] as Record<string, number> | undefined;
    const trafficSplit = allocations
      ? Object.entries(allocations)
          .map(([v, pct]) => `${v}: ${(pct * 100).toFixed(0)}%`)
          .join(", ")
      : "";
    const latestVersion = allocations ? (Object.keys(allocations)[0] ?? "") : "";
    return {
      id: ctx.id(accountId, "app-engine-service", name),
      pluginId: "gcp",
      resourceTypeId: "app-engine-service",
      accountId,
      displayName: name,
      fields: {
        name,
        servingStatus: String(svc["servingStatus"] ?? ""),
        latestVersion,
        trafficSplit,
      },
      resolvedOutputs: {
        url: `https://${name === "default" ? "" : `${name}-dot-`}${p}.appspot.com`,
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
