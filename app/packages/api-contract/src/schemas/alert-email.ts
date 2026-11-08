/** Alert email recipients on a cost object, as an Effect schema. */
import { Schema } from "effect";
import { maxLength, minLength } from "./checks";
import { ALERT_EMAIL_LIMITS } from "@infrawrench/client-core";

/**
 * Structural only: whether each user id is a member and each address passes
 * the org's external-address policy needs the database, so the services run
 * `alertEmailRecipientsError` (client-core) after this decodes. Optional
 * wherever it appears, and absent means "leave the stored list alone".
 */
export const AlertEmailRecipients = Schema.Struct({
  userIds: Schema.mutable(Schema.Array(Schema.String.check(minLength(1), maxLength(200))))
    .check(maxLength(ALERT_EMAIL_LIMITS.maxMembers))
    .annotate({
      description:
        "Organization members, by user id (from GET /alert-email). The member's current login address is read when the alert is sent, so an email change follows them and a member who leaves stops receiving.",
    }),
  addresses: Schema.mutable(
    Schema.Array(Schema.String.check(minLength(3), maxLength(ALERT_EMAIL_LIMITS.maxAddressLength))),
  )
    .check(maxLength(ALERT_EMAIL_LIMITS.maxAddresses))
    .annotate({
      description:
        "Extra addresses (a `finance@` alias, someone without a login). Each must pass the organization's external-address policy (GET /alert-email/settings), checked when saved and again when sent.",
      examples: [["finance@example.com"]],
    }),
}).annotate({
  identifier: "AlertEmailRecipients",
  description:
    "Who is emailed when this object fires, **in addition to** whatever the organization's alert routing rules decide. Delivered whether or not a rule matched and not held by quiet hours. On a write, omitting the field leaves the stored list unchanged; send empty arrays to clear it.",
});
