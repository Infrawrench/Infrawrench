import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const QueueResourceType: ResourceTypeDefinition = {
  id: "queue",
  displayName: "Queue",
  pluralDisplayName: "Queues",
  description: "A Cloudflare Queue for message passing between Workers",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "producersTotal", label: "Producers", kind: "number", required: false },
    { key: "consumersTotal", label: "Consumers", kind: "number", required: false },
    { key: "deliveryDelay", label: "Delivery Delay (s)", kind: "number", required: false },
    { key: "deliveryPaused", label: "Delivery Paused", kind: "boolean", required: false },
    {
      key: "messageRetentionPeriod",
      label: "Retention (s)",
      kind: "number",
      required: false,
    },
    { key: "createdOn", label: "Created", kind: "string", required: false },
    { key: "modifiedOn", label: "Modified", kind: "string", required: false },
  ],
  outputs: [
    { key: "queueId", label: "Queue ID", sensitive: false },
    { key: "queueName", label: "Queue Name", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
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
};
