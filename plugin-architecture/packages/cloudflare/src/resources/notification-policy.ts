import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NotificationPolicyResourceType: ResourceTypeDefinition = {
  id: "notification-policy",
  displayName: "Notification Policy",
  pluralDisplayName: "Notification Policies",
  description: "A Cloudflare account notification (alerting) policy",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "alertType", label: "Alert Type", kind: "string", required: true, editable: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "mechanisms", label: "Delivers To", kind: "string", required: false, editable: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "logs",
};
