import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudTasksQueueResourceType: ResourceTypeDefinition = {
  id: "cloud-tasks-queue",
  displayName: "Cloud Tasks Queue",
  pluralDisplayName: "Cloud Tasks Queues",
  description: "A Google Cloud Tasks queue for distributed task execution",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "maxDispatchesPerSecond", label: "Max Dispatches/s", kind: "number", required: false },
    { key: "maxConcurrentDispatches", label: "Max Concurrent", kind: "number", required: false },
    { key: "maxBurstSize", label: "Max Burst Size", kind: "number", required: false },
    { key: "maxAttempts", label: "Max Attempts", kind: "number", required: false },
    { key: "minBackoff", label: "Min Backoff", kind: "string", required: false },
    { key: "maxBackoff", label: "Max Backoff", kind: "string", required: false },
    { key: "maxDoublings", label: "Max Doublings", kind: "number", required: false },
    { key: "maxRetryDuration", label: "Max Retry Duration", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
};
