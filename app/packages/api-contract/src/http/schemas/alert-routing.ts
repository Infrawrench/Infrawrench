/**
 * The alert routing vocabulary: triggers, severities and destinations, plus
 * the picker lists a destination is chosen from. Shared because alert rules,
 * the delivery queue, push preferences and report anomaly alerts all name
 * them, and a component is defined once.
 */
import { Schema } from "effect";
import { ALERT_SEVERITIES, ALERT_TRIGGERS } from "@infrawrench/client-core";

/** Sourced from the shared registry, the same list the server routes on. */
export const AlertTrigger = Schema.Literals(ALERT_TRIGGERS.map((t) => t.id)).annotate({
  identifier: "AlertTrigger",
  description: "A kind of alert that can be routed.",
});

export const AlertSeverity = Schema.Literals(ALERT_SEVERITIES).annotate({
  identifier: "AlertSeverity",
  description: "Alert severity, ordered info < warning < critical.",
});

export const AlertDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("push") }),
  Schema.Struct({
    kind: Schema.Literal("slack"),
    channelId: Schema.String.annotate({
      description: "A slack_channels row id from /slack/status",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("msteams"),
    webhookId: Schema.String.annotate({
      description: "An msteams webhook id from /msteams/status",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("on-call"),
    scheduleId: Schema.String.annotate({
      description: "An on-call rotation id from /on-call/schedules",
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("github-issues") }),
  Schema.Struct({
    kind: Schema.Literal("email-member"),
    userId: Schema.String.annotate({
      description:
        "An organization member's user id (from `members` in this response, or GET /alert-email). Their current login address is read at send time.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("paging-provider"),
    accountId: Schema.String.annotate({
      description: "A connected account whose plugin can page (GET /paging-providers)",
    }),
    targetId: Schema.String.annotate({
      description:
        "The provider's id for the target (a PagerDuty service, an incident.io alert source), from GET /paging-providers/destinations",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("provider-on-call"),
    accountId: Schema.String.annotate({
      description: "A connected account whose plugin can say who is on call",
    }),
    sourceId: Schema.String.annotate({
      description:
        "A provider schedule or escalation policy id, from GET /paging-providers/destinations",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("email-address"),
    address: Schema.String.annotate({
      description:
        "An extra address. Must pass the organization's external-address policy (GET /alert-email/settings).",
      examples: ["finance@example.com"],
    }),
  }),
]).annotate({
  identifier: "AlertDestination",
  description:
    "One place a matched alert goes. `push` reaches the organization's phones, still filtered by each member's own mutes; an organization rule decides whether the org is told, a member decides whether their phone rings.\n\n" +
    '`on-call` resolves to one person at delivery time, so a rule reading "database alerts → whoever is on call" needs no edit at handover. A rotation that resolves to nobody (disabled, empty, not yet started) contributes nobody and the rule\'s **other** destinations still deliver: an alert lost to a misconfigured rotation would be the worst outcome the feature could have.\n\n' +
    "`github-issues` files the alert's finding as a GitHub issue in the repository the organization's GitHub issue settings route it to (`/github-issues`), commenting on the open issue instead when one already exists for that finding. Only alerts that carry a finding (savings findings, cost anomalies, idle commitments) can be filed; for other triggers this destination is skipped." +
    "\n\n`email-member` and `email-address` send an HTML and plain-text email with a link back into the app and a one-click unsubscribe link. Email carries no acknowledge button, so a rule routed only to email always escalates." +
    "\n\n`paging-provider` opens an alert on a provider target under a stable dedup key. The alert's own recovery (a probe coming back, a declared incident resolving, a page being cleared) resolves it upstream, an Infrawrench acknowledgement acknowledges it, and an acknowledgement upstream settles the Infrawrench escalation. `provider-on-call` asks the provider who is on call and pushes to the members whose email matches.",
});

export const AlertEmailExternalPolicy = Schema.Literals(["member-domains", "any"]);

/**
 * The destination picker lists (`loadDestinationCatalog` in server-core), as
 * fields: the alert rules response and a report anomaly alert's targets both
 * carry them.
 */
export const alertDestinationCatalogFields = {
  slackChannels: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, isPrivate: Schema.Boolean }),
  ),
  msTeamsWebhooks: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  onCallSchedules: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })).annotate(
    {
      description:
        "Live on-call rotations, so the editor can offer 'whoever is on call' as a destination. " +
        "Disabled rotations are omitted for the same reason a disconnected Slack install is: " +
        "offering one would let the editor build a rule that routes nowhere.",
    },
  ),
  members: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.NullOr(Schema.String),
      email: Schema.String,
    }),
  ).annotate({ description: "Current members, for the email destination picker." }),
  emailAvailable: Schema.Boolean.annotate({
    description: "Whether this deployment has a mail provider configured.",
  }),
  emailSettings: Schema.Struct({
    externalPolicy: AlertEmailExternalPolicy,
    allowedDomains: Schema.Array(Schema.String),
  }).annotate({
    description: "The external-address policy an `email-address` destination must pass.",
  }),
  memberDomains: Schema.Array(Schema.String).annotate({
    description: "Domains the organization's members sign in with: the implicit allowlist.",
  }),
};
