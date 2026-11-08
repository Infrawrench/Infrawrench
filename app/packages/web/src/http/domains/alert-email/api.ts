/**
 * Alert email: `/api/org/:orgId/alert-email`, the endpoint definitions. The
 * recipient picker's options, the org's external-address policy and the
 * suppression list.
 *
 * The options read is `costs:read`, because every cost-object editor (budgets,
 * change alerts, anomaly and efficiency settings) needs the member list and
 * the policy to tell the truth about what will send. The policy and the
 * suppressions are `org:settings:write`, the alert-routing gate. The public
 * unsubscribe link (`/api/alert-email/unsubscribe`, an HMAC token and no
 * session) is `../alert-email-unsubscribe`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { optionalRequestBody } from "../../schemas/documented";
import { IsoDateTime, OrgParams } from "../../schemas/common";
import { AlertEmailExternalPolicy } from "../../schemas/alert-routing";

const ExternalPolicy = AlertEmailExternalPolicy.annotate({
  description:
    "`member-domains` (the default): an extra address must be on a domain one of the organization's members signs in with, or one listed in `allowedDomains`. `any`: no restriction.",
});

const AlertEmailSettings = Schema.Struct({
  externalPolicy: ExternalPolicy,
  allowedDomains: Schema.Array(Schema.String)
    .check(maxLength(50))
    .annotate({
      description: "Extra domains accepted under `member-domains`, without the `@`.",
      examples: [["partner-agency.com"]],
    }),
}).annotate({ identifier: "AlertEmailSettings" });

const AlertEmailMember = Schema.Struct({
  userId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
}).annotate({ identifier: "AlertEmailMember" });

export const AlertEmailOptions = Schema.Struct({
  emailAvailable: Schema.Boolean.annotate({
    description:
      "Whether this deployment has a mail provider configured. False means alert email is never sent.",
  }),
  members: Schema.Array(AlertEmailMember),
  settings: AlertEmailSettings,
  memberDomains: Schema.Array(Schema.String).annotate({
    description: "Domains the organization's members sign in with: the implicit allowlist.",
  }),
}).annotate({ identifier: "AlertEmailOptions" });

const AlertEmailSuppression = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  createdAt: IsoDateTime,
}).annotate({ identifier: "AlertEmailSuppression" });

export const AlertEmailSettingsView = Schema.Struct({
  externalPolicy: ExternalPolicy,
  allowedDomains: Schema.Array(Schema.String),
  emailAvailable: Schema.Boolean,
  memberDomains: Schema.Array(Schema.String),
  suppressions: Schema.Array(AlertEmailSuppression).annotate({
    description:
      "Addresses that used the unsubscribe link in an alert email. They receive no alert email from this organization until an admin removes the entry.",
  }),
}).annotate({ identifier: "AlertEmailSettingsView" });

export const AlertEmailRemoved = Schema.Struct({ ok: Schema.Boolean });

export class AlertEmailGroup extends HttpApiGroup.make("alertEmail")
  .add(
    HttpApiEndpoint.get("options", "/", {
      params: OrgParams,
      success: AlertEmailOptions,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Recipient picker options for alert email")
      .annotate(
        OpenApi.Description,
        "Current members (with their login address), the external-address policy and whether email is available on this deployment: everything a client needs to edit the `emailRecipients` on a budget, cost change alert, anomaly settings or efficiency alert settings, or an email destination on an alert routing rule. Requires `costs:read`.",
      )
      .annotate(SuccessDescription, "Picker options"),
    HttpApiEndpoint.get("settings", "/settings", {
      params: OrgParams,
      success: AlertEmailSettingsView,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the alert email policy and suppression list")
      .annotate(SuccessDescription, "Policy, availability and suppressions"),
    // Checked by `alertEmailSettingsError` (client-core), the form's own check.
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: AlertEmailSettings,
      success: AlertEmailSettingsView,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Set the alert email external-address policy")
      .annotate(
        OpenApi.Description,
        "Whole object. Tightening the policy does not edit any stored recipient list: an address that no longer passes is skipped at send time, and loosening the policy again brings it back.",
      )
      .annotate(SuccessDescription, "The saved policy")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("removeSuppression", "/suppressions/:id", {
      params: { ...OrgParams, id: Schema.String },
      success: AlertEmailRemoved,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Resume alert email to an unsubscribed address")
      .annotate(SuccessDescription, "Removed"),
  )
  .prefix("/api/org/:orgId/alert-email")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Alerts") {}

export class AlertEmailApi extends withApiDefaults(
  HttpApi.make("alert-email").add(AlertEmailGroup),
) {}
