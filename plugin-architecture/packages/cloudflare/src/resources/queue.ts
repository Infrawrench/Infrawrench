import { f, o, rt } from "@infrawrench/plugin-base";

export const QueueResourceType = rt({
  name: "Queue",
  id: "queue",
  description: "A Cloudflare Queue for message passing between Workers",
  fields: [
    f("name", "Name"),
    f("producersTotal", "Producers", { kind: "number", required: false }),
    f("consumersTotal", "Consumers", { kind: "number", required: false }),
    f("deliveryDelay", "Delivery Delay (s)", { kind: "number", required: false }),
    f("deliveryPaused", "Delivery Paused", { kind: "boolean", required: false }),
    f("messageRetentionPeriod", "Retention (s)", { kind: "number", required: false }),
    f("createdOn", "Created", { showcase: true, required: false }),
    f("modifiedOn", "Modified", { required: false }),
  ],
  outputs: [o("queueId", "Queue ID"), o("queueName", "Queue Name")],
  supportsCreate: true,
  supportsMetrics: true,
  // The "Backlog Bytes" series from `queueBacklogAdaptiveGroups`
  // (metric-series.ts). A queue whose backlog reaches 25 GB is refused new
  // messages with `Storage Limit Exceeded`
  // (https://developers.cloudflare.com/queues/platform/limits/, read 2026-11-23).
  capacityMetrics: [
    {
      seriesLabel: "Backlog Bytes",
      limit: { constant: 25 * 1000 ** 3 },
      unit: "bytes",
      label: "Backlog",
    },
  ],
  iconKey: "queue",
  secretExportTemplates: [
    {
      id: "queue-binding",
      displayName: "Queue Binding",
      description: "Queue ID and name for wrangler `[[queues.producers]]` bindings.",
      entries: [
        { envKey: "QUEUE_ID", outputKey: "queueId" },
        { envKey: "QUEUE_NAME", outputKey: "queueName" },
      ],
    },
  ],
});
