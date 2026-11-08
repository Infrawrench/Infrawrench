/**
 * Twilio pager settings: `/api/org/:orgId/twilio`, the endpoint definitions.
 *
 * The settings page behind the SMS and voice pager. None of it has ever been
 * in the published spec, so every endpoint is `OpenApi.Exclude` and sends the
 * handler's value unchanged. Everything is `org:settings:write`: these decide
 * whose phones ring, and the stored Account SID and Auth Token are never
 * echoed back. Bodies are read raw by the handlers, which answer a malformed
 * field with their own sentence.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { Ok, OrgIdParams, OrgParams } from "../../schemas/common";

/** What an undocumented endpoint sends: the handler's value, unchanged. */
export const Undocumented = Schema.Unknown;

export class TwilioGroup extends HttpApiGroup.make("twilio")
  .add(
    HttpApiEndpoint.get("getSettings", "/", { params: OrgParams, success: Undocumented })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.put("updateSettings", "/", {
      params: OrgParams,
      payload: Undocumented,
      success: Ok,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("listRecipients", "/recipients", {
      params: OrgParams,
      success: Undocumented,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("createRecipient", "/recipients", {
      params: OrgParams,
      payload: Undocumented,
      success: Undocumented,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.delete("deleteRecipient", "/recipients/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("sendTest", "/test", {
      params: OrgParams,
      success: Undocumented,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Exclude, true),
  )
  .prefix("/api/org/:orgId/twilio")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Twilio") {}

export class TwilioApi extends withApiDefaults(HttpApi.make("twilio").add(TwilioGroup)) {}
