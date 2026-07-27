import { f, rt } from "@infrawrench/plugin-base";

export const AlertPolicyResourceType = rt({
  name: "Alert Policy",
  plural: "Alert Policies",
  id: "alert-policy",
  description: "A Google Cloud Monitoring alert policy",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("conditionCount", "Conditions", { kind: "number", required: false }),
    f("notificationChannelCount", "Notification Channels", { kind: "number", required: false }),
    f("combiner", "Combiner", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
