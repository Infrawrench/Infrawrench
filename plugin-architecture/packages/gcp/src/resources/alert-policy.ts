import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AlertPolicyResourceType: ResourceTypeDefinition = {
  id: "alert-policy",
  displayName: "Alert Policy",
  pluralDisplayName: "Alert Policies",
  description: "A Google Cloud Monitoring alert policy",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: false },
    { key: "conditionCount", label: "Conditions", kind: "number", required: false },
    {
      key: "notificationChannelCount",
      label: "Notification Channels",
      kind: "number",
      required: false,
    },
    { key: "combiner", label: "Combiner", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
