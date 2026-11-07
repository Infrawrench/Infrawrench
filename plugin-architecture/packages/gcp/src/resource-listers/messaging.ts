import type { ResourceInstance } from "@infrawrench/plugin-base";
import { readEachRegion, type ListerContext } from "./shared.js";

export async function listPubSubTopics(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
    "topics",
  );
  return items.map((t) => {
    const fullName = String(t["name"]);
    const name = fullName.split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "pubsub-topic", fullName),
      pluginId: "gcp",
      resourceTypeId: "pubsub-topic",
      accountId,
      displayName: name,
      fields: {
        name,
        kmsKeyName: String(t["kmsKeyName"] ?? ""),
        messageRetentionDuration: String(t["messageRetentionDuration"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPubSubSubscriptions(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`,
    "subscriptions",
  );
  return items.map((s) => {
    const fullName = String(s["name"]);
    const name = fullName.split("/").pop() ?? "";
    const topicFull = String(s["topic"] ?? "");
    const topic = topicFull.split("/").pop() ?? topicFull;
    // Subscriptions can reference topics in other projects; only link as a child
    // when the topic lives in the same project we're listing from.
    const topicInSameProject = topicFull.startsWith(`projects/${p}/topics/`);
    return {
      id: ctx.id(accountId, "pubsub-subscription", fullName),
      pluginId: "gcp",
      resourceTypeId: "pubsub-subscription",
      accountId,
      displayName: name,
      fields: {
        name,
        topic,
        ackDeadlineSeconds: Number(s["ackDeadlineSeconds"] ?? 10),
        messageRetentionDuration: String(s["messageRetentionDuration"] ?? ""),
        filter: String(s["filter"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      ...(topicInSameProject
        ? { parentResourceId: ctx.id(accountId, "pubsub-topic", topicFull) }
        : {}),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudTasksQueues(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
    `https://cloudtasks.googleapis.com/v2/projects/${p}/locations`,
  );
  const locations = locData.locations ?? [];
  return readEachRegion(
    locations,
    async (loc) => {
      const items = await ctx.paginate<Record<string, unknown>>(
        `https://cloudtasks.googleapis.com/v2/${loc.name}/queues`,
        "queues",
      );
      return items.map((queue) => {
        const fullName = String(queue["name"]);
        const name = fullName.split("/").pop() ?? "";
        const rateLimits = queue["rateLimits"] as Record<string, unknown> | undefined;
        const retryConfig = queue["retryConfig"] as Record<string, unknown> | undefined;
        return {
          id: ctx.id(accountId, "cloud-tasks-queue", fullName),
          pluginId: "gcp",
          resourceTypeId: "cloud-tasks-queue",
          accountId,
          displayName: name,
          fields: {
            name,
            region: loc.locationId,
            state: String(queue["state"] ?? ""),
            maxDispatchesPerSecond: Number(rateLimits?.["maxDispatchesPerSecond"] ?? 0),
            maxConcurrentDispatches: Number(rateLimits?.["maxConcurrentDispatches"] ?? 0),
            maxBurstSize: Number(rateLimits?.["maxBurstSize"] ?? 0),
            maxAttempts: Number(retryConfig?.["maxAttempts"] ?? 0),
            minBackoff: String(retryConfig?.["minBackoff"] ?? ""),
            maxBackoff: String(retryConfig?.["maxBackoff"] ?? ""),
            maxDoublings: Number(retryConfig?.["maxDoublings"] ?? 0),
            maxRetryDuration: String(retryConfig?.["maxRetryDuration"] ?? ""),
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: fullName,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        };
      });
    },
    {
      unread: (loc) => ({
        idPrefixes: [ctx.id(accountId, "cloud-tasks-queue", `${loc.name}/`)],
      }),
    },
  );
}

export async function listCloudSchedulerJobs(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const locData = await ctx.get<{ locations?: Array<{ name: string; locationId: string }> }>(
    `https://cloudscheduler.googleapis.com/v1/projects/${p}/locations`,
  );
  const locations = locData.locations ?? [];
  return readEachRegion(
    locations,
    async (loc) => {
      const items = await ctx.paginate<Record<string, unknown>>(
        `https://cloudscheduler.googleapis.com/v1/${loc.name}/jobs`,
        "jobs",
      );
      return items.map((job) => {
        const fullName = String(job["name"]);
        const name = fullName.split("/").pop() ?? "";
        const httpTarget = job["httpTarget"] as Record<string, unknown> | undefined;
        const pubsubTarget = job["pubsubTarget"] as Record<string, unknown> | undefined;
        const appEngineTarget = job["appEngineHttpTarget"] as Record<string, unknown> | undefined;
        let targetType = "unknown";
        let targetUri = "";
        if (httpTarget) {
          targetType = "HTTP";
          targetUri = String(httpTarget["uri"] ?? "");
        } else if (pubsubTarget) {
          targetType = "Pub/Sub";
          targetUri =
            String(pubsubTarget["topicName"] ?? "")
              .split("/")
              .pop() ?? "";
        } else if (appEngineTarget) {
          targetType = "App Engine";
          targetUri = String(appEngineTarget["relativeUri"] ?? "");
        }
        return {
          id: ctx.id(accountId, "cloud-scheduler-job", fullName),
          pluginId: "gcp",
          resourceTypeId: "cloud-scheduler-job",
          accountId,
          displayName: name,
          fields: {
            name,
            region: loc.locationId,
            schedule: String(job["schedule"] ?? ""),
            timeZone: String(job["timeZone"] ?? ""),
            state: String(job["state"] ?? ""),
            targetType,
            targetUri,
            lastAttemptTime: String(job["lastAttemptTime"] ?? ""),
            scheduleTime: String(job["scheduleTime"] ?? ""),
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: fullName,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        };
      });
    },
    {
      unread: (loc) => ({
        idPrefixes: [ctx.id(accountId, "cloud-scheduler-job", `${loc.name}/`)],
      }),
    },
  );
}
