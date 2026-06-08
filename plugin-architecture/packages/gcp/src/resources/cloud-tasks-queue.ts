import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudTasksQueueResourceType = rt({
  name: "Cloud Tasks Queue",
  id: "cloud-tasks-queue",
  description: "A Google Cloud Tasks queue for distributed task execution",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("state", "State", { required: false }),
    f("maxDispatchesPerSecond", "Max Dispatches/s", { kind: "number", required: false }),
    f("maxConcurrentDispatches", "Max Concurrent", { kind: "number", required: false }),
    f("maxBurstSize", "Max Burst Size", { kind: "number", required: false }),
    f("maxAttempts", "Max Attempts", { kind: "number", required: false }),
    f("minBackoff", "Min Backoff", { required: false }),
    f("maxBackoff", "Max Backoff", { required: false }),
    f("maxDoublings", "Max Doublings", { kind: "number", required: false }),
    f("maxRetryDuration", "Max Retry Duration", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsMetrics: true,
});
