import { z } from "../zod";
import { AlertSeverityEnum, AlertTriggerEnum, strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

/**
 * Alert routing rules.
 *
 * These endpoints replaced a matrix of boolean flags spread across the Slack
 * channel, Teams webhook and push preference resources. A channel could only
 * answer "all alerts of this kind, yes or no"; a rule can answer "anomalies
 * over $500 on the prod account, to #incidents, unless it is the middle of the
 * night, and page the secondary channel if nobody acknowledges".
 */

const AlertDestination = z
  .discriminatedUnion("kind", [
    strict({ kind: z.literal("push") }),
    strict({
      kind: z.literal("slack"),
      channelId: z.string().openapi({ description: "A slack_channels row id from /slack/status" }),
    }),
    strict({
      kind: z.literal("msteams"),
      webhookId: z.string().openapi({ description: "An msteams webhook id from /msteams/status" }),
    }),
    strict({
      kind: z.literal("on-call"),
      scheduleId: z
        .string()
        .openapi({ description: "An on-call rotation id from /on-call/schedules" }),
    }),
  ])
  .openapi("AlertDestination", {
    description:
      "One place a matched alert goes. `push` reaches the organization's phones, still filtered by each member's own mutes — an organization rule decides whether the org is told, a member decides whether their phone rings.\n\n" +
      '`on-call` resolves to one person at delivery time, so a rule reading "database alerts → whoever is on call" needs no edit at handover. A rotation that resolves to nobody — disabled, empty, not yet started — contributes nobody and the rule\'s **other** destinations still deliver: an alert lost to a misconfigured rotation would be the worst outcome the feature could have.',
  });

const AlertCondition = z
  .discriminatedUnion("field", [
    strict({
      field: z.literal("trigger"),
      op: z.enum(["in", "notIn"]),
      values: z.array(AlertTriggerEnum),
    }),
    strict({
      field: z.literal("severity"),
      op: z.enum(["gte", "eq"]),
      severity: AlertSeverityEnum,
    }),
    strict({
      field: z.literal("accountId"),
      op: z.enum(["in", "notIn"]),
      values: z.array(z.string()),
    }),
    strict({
      field: z.literal("pluginId"),
      op: z.enum(["in", "notIn"]),
      values: z.array(z.string()),
    }),
    strict({
      field: z.literal("resourceTypeId"),
      op: z.enum(["in", "notIn"]),
      values: z.array(z.string()),
    }),
    strict({
      field: z.literal("amountCents"),
      op: z.enum(["gte", "lt"]),
      cents: z.number().int().nonnegative(),
    }),
    strict({
      field: z.literal("key"),
      op: z.enum(["contains", "notContains", "eq"]),
      value: z.string(),
    }),
    strict({
      field: z.literal("text"),
      op: z.enum(["contains", "notContains"]),
      value: z.string(),
    }),
  ])
  .openapi("AlertCondition", {
    description:
      "One clause of a rule. A rule matches when every condition matches; 'or' is expressed by writing a second rule. A condition on a fact the alert does not carry never matches — in either direction, so `accountId notIn [x]` does not match an alert with no account.",
  });

const QuietHours = strict({
  timezone: z.string().openapi({ description: "IANA zone, e.g. Europe/Berlin" }),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439).openapi({
    description: "May be less than startMinute for an overnight window. Equal means empty.",
  }),
  days: z.array(z.number().int().min(1).max(7)).openapi({
    description:
      "ISO weekdays the window applies on, matched against the day the window opened. Empty means every day.",
  }),
  urgentOverride: AlertSeverityEnum.nullable().openapi({
    description: "Severity at or above which quiet hours do not apply. Null holds everything.",
  }),
}).openapi("QuietHours", {
  description:
    "A recurring local-time window during which the rule holds its alerts. Held, not dropped — a held alert is queued and delivered when the window closes.",
});

const EscalationPolicy = strict({
  afterMinutes: z.number().int().min(1).max(10_080),
  destinations: z.array(AlertDestination),
}).openapi("EscalationPolicy", {
  description:
    "Notify these destinations too if nobody acknowledges within afterMinutes. Acknowledgement comes from the button on the Slack message, so an alert routed only to Teams or push will always escalate.",
});

const AlertRule = strict({
  id: z.string(),
  name: z.string().max(80),
  enabled: z.boolean(),
  position: z.number().int().openapi({ description: "Ascending evaluation order" }),
  conditions: z.array(AlertCondition),
  destinations: z.array(AlertDestination).openapi({
    description:
      "Empty is legal and meaningful: an enabled rule with no destinations swallows matching alerts and shadows the rules below it.",
  }),
  continueOnMatch: z.boolean().openapi({
    description:
      "False (the default) makes the list first-match-wins, which is what lets a narrow rule sit above a broad one. True makes the rule a tee that copies without shadowing.",
  }),
  quietHours: QuietHours.nullable(),
  escalation: EscalationPolicy.nullable(),
}).openapi("AlertRule");

const AlertRuleInput = strict({
  id: z.string().optional().openapi({
    description:
      "Send the existing id to preserve it, which keeps in-flight held and escalating deliveries pointing at their rule.",
  }),
  name: z.string().max(80),
  enabled: z.boolean().optional(),
  conditions: z.array(AlertCondition).optional(),
  destinations: z.array(AlertDestination).optional(),
  continueOnMatch: z.boolean().optional(),
  quietHours: QuietHours.nullable().optional(),
  escalation: EscalationPolicy.nullable().optional(),
}).openapi("AlertRuleInput");

const AlertRulesResponse = strict({
  rules: z.array(AlertRule),
  usingDefaults: z.boolean().openapi({
    description:
      "True when the organization has saved no rules and `rules` is the synthesized default — everything except drift, to every connected channel and to mobile push.",
  }),
  slackChannels: z.array(strict({ id: z.string(), name: z.string(), isPrivate: z.boolean() })),
  msTeamsWebhooks: z.array(strict({ id: z.string(), label: z.string() })),
  accounts: z.array(strict({ id: z.string(), displayName: z.string(), pluginId: z.string() })),
  onCallSchedules: z
    .array(strict({ id: z.string(), name: z.string() }))
    .describe(
      "Live on-call rotations, so the editor can offer 'whoever is on call' as a destination. " +
        "Disabled rotations are omitted for the same reason a disconnected Slack install is: " +
        "offering one would let the editor build a rule that routes nowhere.",
    ),
}).openapi("AlertRulesResponse");

const AlertDelivery = strict({
  id: z.string(),
  trigger: AlertTriggerEnum,
  severity: AlertSeverityEnum,
  title: z.string(),
  body: z.string(),
  ruleName: z.string().nullable(),
  state: z.enum(["held", "awaiting_ack", "sent", "acknowledged", "escalated", "expired"]),
  createdAt: z.string(),
  deliverAfter: z.string().nullable().openapi({
    description: "When a quiet-hours hold is released.",
  }),
  escalateAt: z.string().nullable().openapi({
    description: "When an unacknowledged alert escalates.",
  }),
  acknowledgedAt: z.string().nullable(),
  acknowledgedByUserId: z.string().nullable(),
}).openapi("AlertDelivery");

export function registerAlertRulePaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/alert-rules",
    tags: ["Alerts"],
    summary: "Get the organization's alert routing rules",
    description:
      "Returns the rules in evaluation order, plus the channels and accounts a rule can name so a client can render destinations by name. An organization that has saved no rules gets the synthesized default with `usingDefaults: true`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Rules and the destinations they can reference",
        content: { "application/json": { schema: AlertRulesResponse } },
      },
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/alert-rules",
    tags: ["Alerts"],
    summary: "Replace the organization's alert routing rules",
    description:
      "Whole-list replacement in one transaction. Order is part of the meaning — a rule is only correct relative to the ones above it — so a reorder applied as several requests would leave a window in which alerts route somewhere nobody asked for. Positions are re-derived from array order.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ rules: z.array(AlertRuleInput) }) } },
      },
    },
    responses: {
      200: {
        description: "The saved rules",
        content: { "application/json": { schema: strict({ rules: z.array(AlertRule) }) } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/alert-rules/adopt-defaults",
    tags: ["Alerts"],
    summary: "Persist the default rule so it can be edited",
    description: "A no-op when the organization already has rules.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The saved rules",
        content: {
          "application/json": {
            schema: strict({ rules: z.array(AlertRule), adopted: z.boolean() }),
          },
        },
      },
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/alert-rules/deliveries",
    tags: ["Alerts"],
    summary: "List recent held and escalating alerts",
    description:
      "Only alerts a rule created follow-up work for appear here: one held by quiet hours, or one waiting on an acknowledgement. An alert that went straight out leaves no row.",
    request: {
      params: OrgIdParam,
      query: strict({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    },
    responses: {
      200: {
        description: "Deliveries, newest first",
        content: { "application/json": { schema: z.array(AlertDelivery) } },
      },
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/alert-rules/deliveries/{id}/ack",
    tags: ["Alerts"],
    summary: "Acknowledge an alert, cancelling its escalation",
    description:
      "A conditional update: only a delivery still in `awaiting_ack` can move, so two people pressing at once produce one acknowledgement and an alert that already escalated cannot be retroactively silenced.",
    request: { params: OrgIdParam.extend({ id: z.string() }) },
    responses: {
      200: {
        description: "Outcome",
        content: {
          "application/json": {
            schema: strict({
              acknowledged: z.boolean(),
              alreadyAcknowledgedBy: z.string().nullable().optional(),
              // `not_found` is absent on purpose: the handler maps it to 404,
              // so it can never reach a client through this response.
              reason: z
                .enum(["not_pending", "already_escalated", "already_acknowledged"])
                .optional()
                .openapi({
                  description:
                    "Why the acknowledgement did not take. `not_pending` means the delivery exists but was never awaiting one — still held, already sent, or expired.",
                }),
              title: z.string().optional(),
            }),
          },
        },
      },
      401: ErrorResponses[401],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/alert-rules/deliveries/cancel",
    tags: ["Alerts"],
    summary: "Drop held or awaiting-acknowledgement deliveries",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: strict({ ids: z.array(z.string()) }) } } },
    },
    responses: {
      200: {
        description: "How many rows were cancelled",
        content: { "application/json": { schema: strict({ cancelled: z.number().int() }) } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });
}
