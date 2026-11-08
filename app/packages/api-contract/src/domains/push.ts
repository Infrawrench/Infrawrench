/**
 * Push notification preferences: `/api/org/:orgId/push`, the endpoint
 * definitions.
 *
 * The org-scoped half of mobile push: a member's mutes for this org, the
 * admin roster and the test send. Preferences and the test send are
 * membership-only self-service (no permission beyond membership); the roster
 * takes `org:settings:write`, the Twilio settings page's gate. Device
 * registration is user-scoped and lives at `/api/push` (`http/domains/push-devices/`).
 * Every path here is in the public spec's withheld list, so the operations
 * are `x-internal`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { AlertTrigger } from "../http/schemas/alert-routing";
import { OrgParams } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";

const Platform = Schema.Literals(["ios", "android"]);

const MUTED_TRIGGERS_DESCRIPTION =
  "Triggers this member has turned off for this organization. Anything not listed is delivered, so a trigger added by a later release arrives without the client changing. A member who has never saved preferences gets ['resourceDrift']. A `channelOnly` trigger (one push cannot deliver, such as `weeklyDigest`) is accepted here and simply has no effect; rejecting a preference that is already a no-op would buy nothing.";

export const PushPreferences = Schema.Struct({
  mutedTriggers: Schema.Array(AlertTrigger).annotate({ description: MUTED_TRIGGERS_DESCRIPTION }),
}).annotate({ identifier: "PushPreferences" });

// Its own component rather than `PushPreferences`, so the request body and the
// response shape can diverge without a client break: the response is what the
// server settled on, which need not stay identical to what a client may send.
const PushPreferencesUpdate = Schema.Struct({
  mutedTriggers: Schema.Array(AlertTrigger).annotate({ description: MUTED_TRIGGERS_DESCRIPTION }),
}).annotate({ identifier: "PushPreferencesUpdate" });

export const PushRecipient = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  mutedTriggers: Schema.Array(AlertTrigger),
  devices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      platform: Platform,
      deviceName: Schema.NullOr(Schema.String),
    }),
  ),
}).annotate({ identifier: "PushRecipient" });

export const PushOk = Schema.Struct({ ok: Schema.Boolean });

export const PushTestResult = Schema.Struct({
  ok: Schema.Boolean,
  attempted: Schema.Int,
  succeeded: Schema.Int,
});

export class PushGroup extends HttpApiGroup.make("push")
  .add(
    HttpApiEndpoint.get("getPreferences", "/preferences", {
      params: OrgParams,
      success: PushPreferences,
    })
      .annotate(OpenApi.Summary, "Get the caller's push preferences for this organization")
      .annotate(
        OpenApi.Description,
        "Absent preferences default to every trigger enabled except resourceDrift, which ships muted.",
      )
      .annotate(SuccessDescription, "Preferences"),
    HttpApiEndpoint.put("updatePreferences", "/preferences", {
      params: OrgParams,
      payload: PushPreferencesUpdate,
      success: PushOk,
      error: BadRequest,
    })
      .annotate(OpenApi.Summary, "Update the caller's push preferences for this organization")
      .annotate(SuccessDescription, "Updated")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("listRecipients", "/recipients", {
      params: OrgParams,
      success: Schema.Array(PushRecipient),
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List members receiving push notifications")
      .annotate(OpenApi.Description, "Admin roster of members with at least one active device.")
      .annotate(SuccessDescription, "Recipients"),
    HttpApiEndpoint.post("sendTest", "/test", {
      params: OrgParams,
      success: PushTestResult,
      error: BadRequest,
    })
      .annotate(OpenApi.Summary, "Send a test notification to the caller's devices")
      .annotate(SuccessDescription, "Delivery summary"),
  )
  .prefix("/api/org/:orgId/push")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Push") {}

export class PushApi extends withApiDefaults(HttpApi.make("push").add(PushGroup)) {}
