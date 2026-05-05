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
};
