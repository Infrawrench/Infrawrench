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
    // `destination` is a service-qualified URI — the target's own id is the tail
    // of it, and matching is exact, so parse each supported form into the shape
    // the destination resource is actually keyed by. Log buckets
    // (`logging.googleapis.com/…`) are deliberately unparsed: Infrawrench does
    // not sync them, so there is nothing to point at.
    const destination = String(sink["destination"] ?? "");
    const gcsPrefix = "storage.googleapis.com/";
    const destinationBucket = destination.startsWith(gcsPrefix)
      ? destination.slice(gcsPrefix.length)
      : "";
    const dataset = /^bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)$/.exec(
      destination,
    );
    const destinationDataset = dataset ? `${dataset[1]}:${dataset[2]}` : "";
    const topic = /^pubsub\.googleapis\.com\/(projects\/[^/]+\/topics\/[^/]+)$/.exec(destination);
    const destinationTopic = topic ? (topic[1] ?? "") : "";
    return {
      id: ctx.id(accountId, "log-sink", name),
      pluginId: "gcp",
      resourceTypeId: "log-sink",
      accountId,
      displayName: name,
      fields: {
        name,
        destination,
        destinationBucket,
        destinationDataset,
        destinationTopic,
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
    const conditions = policy["conditions"];
    const channels = policy["notificationChannels"];
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
