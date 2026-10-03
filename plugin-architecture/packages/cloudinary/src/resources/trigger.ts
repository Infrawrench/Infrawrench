import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Every `event_type` the Admin API's triggers endpoint documents.
 * https://cloudinary.com/documentation/admin_api#triggers
 */
export const TRIGGER_EVENT_TYPES = [
  "all",
  "access_control_changed",
  "bulk_refresh_auto_fetch",
  "create_folder",
  "delete",
  "delete_by_token",
  "delete_folder",
  "eager",
  "error",
  "explode",
  "generate_archive",
  "info",
  "invalidate_custom_cdn",
  "moderation",
  "moderation_summary",
  "move",
  "move_or_rename_asset_folder",
  "multi",
  "proof_status_changed",
  "publish",
  "rename",
  "report",
  "related_assets",
  "resource_context_changed",
  "resource_display_name_changed",
  "resource_metadata_changed",
  "resource_tags_changed",
  "restore_asset_version",
  "upload",
];

export const TRIGGER_AUTH_SCHEMES = ["default", "legacy_hmac", "eddsa_v2"];

export const TriggerResourceType = rt({
  name: "Webhook Notification",
  id: "trigger",
  description:
    "A product-environment webhook (Admin API trigger) that POSTs to a URL when an event such as an upload or delete happens",
  fields: [
    f("uri", "Notification URL"),
    f("eventType", "Event Type", {
      kind: "enum",
      enumValues: TRIGGER_EVENT_TYPES,
      editable: false,
    }),
    f("additive", "Additive", {
      kind: "boolean",
      required: false,
      description:
        "Also fire when an upload call or preset supplies its own notification_url for the same event",
    }),
    f("authScheme", "Signature Scheme", {
      kind: "enum",
      required: false,
      enumValues: TRIGGER_AUTH_SCHEMES,
      description: "Which webhook signature headers Cloudinary sends",
    }),
    f("filter", "Filter (JSONLogic)", {
      required: false,
      description:
        "JSONLogic expression evaluated against the notification payload; the webhook is sent only when it is true",
    }),
    f("payloadTemplate", "Payload Template", {
      required: false,
      description: "Mustache-templated JSON object that replaces the default notification body",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("triggerId", "Trigger ID"), o("uri", "Notification URL")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "webhook",
});
