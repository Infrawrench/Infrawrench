import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyNotificationHookResourceType = rt({
  name: "Deploy Notification",
  pinnable: false,
  id: "netlify-notification-hook",
  description: "A deploy notification that emails, posts to Slack, or calls a URL on deploy events",
  parentTypeId: "netlify-site",
  fields: [
    f("type", "Type", { editable: false }),
    f("event", "Event"),
    f("target", "Destination", {
      description: "Email address for email notifications, otherwise the URL to call",
    }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("siteId", "Site", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("hookId", "Notification ID")],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "notifies for" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "hook",
});
