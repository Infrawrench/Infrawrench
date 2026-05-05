import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";

export async function listLogSinks(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ sinks?: Record<string, unknown>[] }>(
    `https://logging.googleapis.com/v2/projects/${p}/sinks`,
  );
  const items = data.sinks ?? [];
  return items.map((sink) => {
    const name = String(sink["name"]);
    return {
      id: ctx.id(accountId, "log-sink", name),
      pluginId: "gcp",
      resourceTypeId: "log-sink",
      accountId,
      displayName: name,
      fields: {
        name,
        destination: String(sink["destination"] ?? ""),
        filter: String(sink["filter"] ?? ""),
        disabled: sink["disabled"] === true,
        writerIdentity: String(sink["writerIdentity"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(sink["createTime"] ?? ctx.now()),
      updatedAt: String(sink["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listAlertPolicies(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://monitoring.googleapis.com/v3/projects/${p}/alertPolicies`,
    "alertPolicies",
  );
  return items.map((policy) => {
    const fullName = String(policy["name"]);
    const displayName = String(policy["displayName"] ?? "");
    const conditions = policy["conditions"] as unknown[] | undefined;
    const channels = policy["notificationChannels"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "alert-policy", fullName),
      pluginId: "gcp",
      resourceTypeId: "alert-policy",
      accountId,
      displayName: displayName || (fullName.split("/").pop() ?? ""),
      fields: {
        name: fullName,
        displayName,
        enabled: policy["enabled"] !== false,
        conditionCount: Array.isArray(conditions) ? conditions.length : 0,
        notificationChannelCount: Array.isArray(channels) ? channels.length : 0,
        combiner: String(policy["combiner"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
