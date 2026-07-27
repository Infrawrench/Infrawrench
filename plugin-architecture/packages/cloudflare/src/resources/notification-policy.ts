import { f, rt } from "@infrawrench/plugin-base";

export const NotificationPolicyResourceType = rt({
  name: "Notification Policy",
  plural: "Notification Policies",
  pinnable: false,
  id: "notification-policy",
  description: "A Cloudflare account notification (alerting) policy",
  fields: [
    f("name", "Name"),
    f("alertType", "Alert Type", { editable: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("description", "Description", { required: false }),
    f("mechanisms", "Delivers To", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "logs",
});
