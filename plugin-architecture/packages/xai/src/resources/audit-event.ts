import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One entry from the team audit log. Requires the optional management key
 * credential — without it this list is empty.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/management/audit
 * (GET /audit/teams/{teamId}/events)
 */
export const AuditEventResourceType = rt({
  name: "Audit Event",
  id: "audit-event",
  description: "An entry from the xAI team audit log (requires a management key)",
  fields: [
    f("eventId", "Event ID"),
    f("eventTime", "Time", { required: false }),
    f("description", "Description", { required: false }),
    f("userId", "User ID", { required: false }),
    f("userEmail", "User Email", { required: false }),
    f("userName", "User Name", { required: false }),
  ],
  outputs: [o("eventId", "Event ID")],
  pinnable: false,
  supportsDelete: false,
  iconKey: "list",
});
