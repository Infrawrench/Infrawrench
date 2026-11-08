/**
 * Alert routing rules: `/api/org/:orgId/alert-rules` and the delivery queue
 * beside it, the endpoint definitions.
 *
 * These replaced a matrix of boolean flags spread across the Slack channel,
 * Teams webhook and push preference resources. A channel could only answer
 * "all alerts of this kind, yes or no"; a rule can answer "anomalies over $500
 * on the prod account, to #incidents, unless it is the middle of the night,
 * and page the secondary channel if nobody acknowledges". Gated on
 * `org:settings:write` throughout: who hears about an incident is an admin
 * decision. (Personal mutes live on `/push/preferences`.)
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { optionalRequestBody } from "../http/schemas/documented";
import { OrgParams } from "../http/schemas/common";
import { numericQuery } from "../http/schemas/query";
import {
  AlertDestination,
  AlertSeverity,
  AlertTrigger,
  alertDestinationCatalogFields,
} from "../http/schemas/alert-routing";

const InOrNotIn = Schema.Literals(["in", "notIn"]);

const AlertCondition = Schema.Union([
  Schema.Struct({
    field: Schema.Literal("trigger"),
    op: InOrNotIn,
    values: Schema.Array(AlertTrigger),
  }),
  Schema.Struct({
    field: Schema.Literal("severity"),
    op: Schema.Literals(["gte", "eq"]),
    severity: AlertSeverity,
  }),
  Schema.Struct({
    field: Schema.Literal("accountId"),
    op: InOrNotIn,
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    field: Schema.Literal("pluginId"),
    op: InOrNotIn,
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    field: Schema.Literal("resourceTypeId"),
    op: InOrNotIn,
    values: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    field: Schema.Literal("amountCents"),
    op: Schema.Literals(["gte", "lt"]),
    cents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    field: Schema.Literal("key"),
    op: Schema.Literals(["contains", "notContains", "eq"]),
    value: Schema.String,
  }),
  Schema.Struct({
    field: Schema.Literal("text"),
    op: Schema.Literals(["contains", "notContains"]),
    value: Schema.String,
  }),
]).annotate({
  identifier: "AlertCondition",
  description:
    "One clause of a rule. A rule matches when every condition matches; 'or' is expressed by writing a second rule. A condition on a fact the alert does not carry never matches; in either direction, so `accountId notIn [x]` does not match an alert with no account.",
});

const MinuteOfDay = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 }));

const QuietHours = Schema.Struct({
  timezone: Schema.String.annotate({ description: "IANA zone, e.g. Europe/Berlin" }),
  startMinute: MinuteOfDay,
  endMinute: MinuteOfDay.annotate({
    description: "May be less than startMinute for an overnight window. Equal means empty.",
  }),
  days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))).annotate({
    description:
      "ISO weekdays the window applies on, matched against the day the window opened. Empty means every day.",
  }),
  urgentOverride: Schema.NullOr(AlertSeverity).annotate({
    description: "Severity at or above which quiet hours do not apply. Null holds everything.",
  }),
}).annotate({
  identifier: "QuietHours",
  description:
    "A recurring local-time window during which the rule holds its alerts. Held, not dropped; a held alert is queued and delivered when the window closes.",
});

const EscalationPolicy = Schema.Struct({
  afterMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_080 })),
  destinations: Schema.Array(AlertDestination),
}).annotate({
  identifier: "EscalationPolicy",
  description:
    "Notify these destinations too if nobody acknowledges within afterMinutes. Acknowledgement comes from the button on the Slack message, so an alert routed only to Teams or push will always escalate.",
});

const RuleName = Schema.String.check(maxLength(80));

export const AlertRule = Schema.Struct({
  id: Schema.String,
  name: RuleName,
  enabled: Schema.Boolean,
  position: Schema.Int.annotate({ description: "Ascending evaluation order" }),
  conditions: Schema.Array(AlertCondition),
  destinations: Schema.Array(AlertDestination).annotate({
    description:
      "Empty is legal and meaningful: an enabled rule with no destinations swallows matching alerts and shadows the rules below it.",
  }),
  continueOnMatch: Schema.Boolean.annotate({
    description:
      "False (the default) makes the list first-match-wins, which is what lets a narrow rule sit above a broad one. True makes the rule a tee that copies without shadowing.",
  }),
  quietHours: Schema.NullOr(QuietHours),
  escalation: Schema.NullOr(EscalationPolicy),
}).annotate({ identifier: "AlertRule" });

const AlertRuleInput = Schema.Struct({
  id: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Send the existing id to preserve it, which keeps in-flight held and escalating deliveries pointing at their rule.",
    }),
  ),
  name: RuleName,
  enabled: Schema.optionalKey(Schema.Boolean),
  conditions: Schema.optionalKey(Schema.Array(AlertCondition)),
  destinations: Schema.optionalKey(Schema.Array(AlertDestination)),
  continueOnMatch: Schema.optionalKey(Schema.Boolean),
  quietHours: Schema.optionalKey(Schema.NullOr(QuietHours)),
  escalation: Schema.optionalKey(Schema.NullOr(EscalationPolicy)),
}).annotate({ identifier: "AlertRuleInput" });

export const AlertRulesResponse = Schema.Struct({
  rules: Schema.Array(AlertRule),
  usingDefaults: Schema.Boolean.annotate({
    description:
      "True when the organization has saved no rules and `rules` is the synthesized default; everything except drift, to every connected channel and to mobile push.",
  }),
  slackChannels: alertDestinationCatalogFields.slackChannels,
  msTeamsWebhooks: alertDestinationCatalogFields.msTeamsWebhooks,
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, displayName: Schema.String, pluginId: Schema.String }),
  ),
  onCallSchedules: alertDestinationCatalogFields.onCallSchedules,
  members: alertDestinationCatalogFields.members,
  emailAvailable: alertDestinationCatalogFields.emailAvailable,
  emailSettings: alertDestinationCatalogFields.emailSettings,
  memberDomains: alertDestinationCatalogFields.memberDomains,
}).annotate({ identifier: "AlertRulesResponse" });

export const AlertRuleList = Schema.Struct({ rules: Schema.Array(AlertRule) });

export const AdoptDefaultsResult = Schema.Struct({
  rules: Schema.Array(AlertRule),
  adopted: Schema.Boolean,
});

const AlertDelivery = Schema.Struct({
  id: Schema.String,
  trigger: AlertTrigger,
  severity: AlertSeverity,
  title: Schema.String,
  body: Schema.String,
  ruleName: Schema.NullOr(Schema.String),
  state: Schema.Literals(["held", "awaiting_ack", "sent", "acknowledged", "escalated", "expired"]),
  createdAt: Schema.String,
  deliverAfter: Schema.NullOr(Schema.String).annotate({
    description: "When a quiet-hours hold is released.",
  }),
  escalateAt: Schema.NullOr(Schema.String).annotate({
    description: "When an unacknowledged alert escalates.",
  }),
  acknowledgedAt: Schema.NullOr(Schema.String),
  acknowledgedByUserId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AlertDelivery" });

export const AlertDeliveries = Schema.Array(AlertDelivery);

export const AcknowledgeResult = Schema.Struct({
  acknowledged: Schema.Boolean,
  alreadyAcknowledgedBy: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // `not_found` is absent on purpose: the handler maps it to 404, so it can
  // never reach a client through this response.
  reason: Schema.optionalKey(
    Schema.Literals(["not_pending", "already_escalated", "already_acknowledged"]).annotate({
      description:
        "Why the acknowledgement did not take. `not_pending` means the delivery exists but was never awaiting one; still held, already sent, or expired.",
    }),
  ),
  title: Schema.optionalKey(Schema.String),
});

export const CancelResult = Schema.Struct({ cancelled: Schema.Int });

export class AlertRulesGroup extends HttpApiGroup.make("alertRules")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: AlertRulesResponse,
      error: Forbidden,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's alert routing rules")
      .annotate(
        OpenApi.Description,
        "Returns the rules in evaluation order, plus the channels and accounts a rule can name so a client can render destinations by name. An organization that has saved no rules gets the synthesized default with `usingDefaults: true`.",
      )
      .annotate(SuccessDescription, "Rules and the destinations they can reference"),
    // Checked by hand, each refusal naming the rule and field at fault.
    HttpApiEndpoint.put("replace", "/", {
      params: OrgParams,
      payload: Schema.Struct({ rules: Schema.Array(AlertRuleInput) }),
      success: AlertRuleList,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace the organization's alert routing rules")
      .annotate(
        OpenApi.Description,
        "Whole-list replacement in one transaction. Order is part of the meaning (a rule is only correct relative to the ones above it) so a reorder applied as several requests would leave a window in which alerts route somewhere nobody asked for. Positions are re-derived from array order.",
      )
      .annotate(SuccessDescription, "The saved rules")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("adoptDefaults", "/adopt-defaults", {
      params: OrgParams,
      success: AdoptDefaultsResult,
      error: Forbidden,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Persist the default rule so it can be edited")
      .annotate(OpenApi.Description, "A no-op when the organization already has rules.")
      .annotate(SuccessDescription, "The saved rules"),
    // Any `limit` is accepted (an unreadable one means the default 50); the
    // store clamps it to 1..200, which is the range documented.
    HttpApiEndpoint.get("deliveries", "/deliveries", {
      params: OrgParams,
      query: {
        // NaN is wanted: an unreadable limit means the default, never a 400.
        // @effect-diagnostics-next-line schemaNumber:off
        limit: Schema.optionalKey(Schema.NumberFromString),
      },
      success: AlertDeliveries,
      error: Forbidden,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List recent held and escalating alerts")
      .annotate(
        OpenApi.Description,
        "Only alerts a rule created follow-up work for appear here: one held by quiet hours, or one waiting on an acknowledgement. An alert that went straight out leaves no row.",
      )
      .annotate(SuccessDescription, "Deliveries, newest first")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      ),
    HttpApiEndpoint.post("acknowledge", "/deliveries/:id/ack", {
      params: { ...OrgParams, id: Schema.String },
      success: AcknowledgeResult,
      error: [Unauthorized, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Acknowledge an alert, cancelling its escalation")
      .annotate(
        OpenApi.Description,
        "A conditional update: only a delivery still in `awaiting_ack` can move, so two people pressing at once produce one acknowledgement and an alert that already escalated cannot be retroactively silenced.",
      )
      .annotate(SuccessDescription, "Outcome"),
    HttpApiEndpoint.post("cancel", "/deliveries/cancel", {
      params: OrgParams,
      payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      success: CancelResult,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Drop held or awaiting-acknowledgement deliveries")
      .annotate(SuccessDescription, "How many rows were cancelled")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/alert-rules")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Alerts") {}

export class AlertRulesApi extends withApiDefaults(
  HttpApi.make("alert-rules").add(AlertRulesGroup),
) {}
