import { z } from "./zod";
import { strict } from "./common";

/**
 * The alert routing vocabulary the Hono-documented routes still reference
 * (report anomaly alerts). The routes that own it, `/alert-rules`, are on
 * HttpApi (`http/domains/alert-rules`), whose `AlertDestination` component
 * replaces this one in the merged document; the two must stay identical.
 */

export const AlertDestination = z
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
    strict({ kind: z.literal("github-issues") }),
    strict({
      kind: z.literal("email-member"),
      userId: z.string().openapi({
        description:
          "An organization member's user id (from `members` in this response, or GET /alert-email). Their current login address is read at send time.",
      }),
    }),
    strict({
      kind: z.literal("paging-provider"),
      accountId: z.string().openapi({
        description: "A connected account whose plugin can page (GET /paging-providers)",
      }),
      targetId: z.string().openapi({
        description:
          "The provider's id for the target (a PagerDuty service, an incident.io alert source), from GET /paging-providers/destinations",
      }),
    }),
    strict({
      kind: z.literal("provider-on-call"),
      accountId: z.string().openapi({
        description: "A connected account whose plugin can say who is on call",
      }),
      sourceId: z.string().openapi({
        description:
          "A provider schedule or escalation policy id, from GET /paging-providers/destinations",
      }),
    }),
    strict({
      kind: z.literal("email-address"),
      address: z.string().openapi({
        description:
          "An extra address. Must pass the organization's external-address policy (GET /alert-email/settings).",
        example: "finance@example.com",
      }),
    }),
  ])
  .openapi("AlertDestination", {
    description:
      "One place a matched alert goes. `push` reaches the organization's phones, still filtered by each member's own mutes; an organization rule decides whether the org is told, a member decides whether their phone rings.\n\n" +
      '`on-call` resolves to one person at delivery time, so a rule reading "database alerts → whoever is on call" needs no edit at handover. A rotation that resolves to nobody (disabled, empty, not yet started) contributes nobody and the rule\'s **other** destinations still deliver: an alert lost to a misconfigured rotation would be the worst outcome the feature could have.\n\n' +
      "`github-issues` files the alert's finding as a GitHub issue in the repository the organization's GitHub issue settings route it to (`/github-issues`), commenting on the open issue instead when one already exists for that finding. Only alerts that carry a finding (savings findings, cost anomalies, idle commitments) can be filed; for other triggers this destination is skipped." +
      "\n\n`email-member` and `email-address` send an HTML and plain-text email with a link back into the app and a one-click unsubscribe link. Email carries no acknowledge button, so a rule routed only to email always escalates." +
      "\n\n`paging-provider` opens an alert on a provider target under a stable dedup key. The alert's own recovery (a probe coming back, a declared incident resolving, a page being cleared) resolves it upstream, an Infrawrench acknowledgement acknowledges it, and an acknowledgement upstream settles the Infrawrench escalation. `provider-on-call` asks the provider who is on call and pushes to the members whose email matches.",
  });

/** The destination picker lists (`loadDestinationCatalog` in server-core). */
export const AlertDestinationCatalog = strict({
  slackChannels: z.array(strict({ id: z.string(), name: z.string(), isPrivate: z.boolean() })),
  msTeamsWebhooks: z.array(strict({ id: z.string(), label: z.string() })),
  onCallSchedules: z
    .array(strict({ id: z.string(), name: z.string() }))
    .describe(
      "Live on-call rotations, so the editor can offer 'whoever is on call' as a destination. " +
        "Disabled rotations are omitted for the same reason a disconnected Slack install is: " +
        "offering one would let the editor build a rule that routes nowhere.",
    ),
  members: z
    .array(strict({ userId: z.string(), name: z.string().nullable(), email: z.string() }))
    .describe("Current members, for the email destination picker."),
  emailAvailable: z.boolean().describe("Whether this deployment has a mail provider configured."),
  emailSettings: strict({
    externalPolicy: z.enum(["member-domains", "any"]),
    allowedDomains: z.array(z.string()),
  }).describe("The external-address policy an `email-address` destination must pass."),
  memberDomains: z
    .array(z.string())
    .describe("Domains the organization's members sign in with: the implicit allowlist."),
});
