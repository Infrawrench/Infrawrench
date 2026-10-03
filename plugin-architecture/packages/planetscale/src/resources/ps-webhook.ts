import { f, o, rt } from "@infrawrench/plugin-base";

export const PsWebhookResourceType = rt({
  name: "Webhook",
  pinnable: false,
  id: "ps-webhook",
  description: "A PlanetScale database webhook delivering branch, deploy, and backup events",
  fields: [
    f("url", "URL"),
    f("databaseName", "Database", { editable: false }),
    f("events", "Events", {
      required: false,
      description: "Comma-separated event names, e.g. deploy_request.opened, branch.ready.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("authorizationHeader", "Authorization Header", {
      kind: "password",
      required: false,
      description:
        "Sent verbatim as the Authorization header. Leave blank to keep the current one.",
    }),
    f("authorizationHeaderConfigured", "Authorization Header Set", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("lastSentAt", "Last Delivery", { required: false, editable: false }),
    f("lastSentSuccess", "Last Delivery Succeeded", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("url", "URL")],
  dependsOn: [{ fieldKey: "databaseName", targetTypeId: "ps-database", label: "for database" }],
  parentTypeId: "ps-database",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "planetscale",
});
