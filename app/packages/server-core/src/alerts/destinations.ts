/**
 * Validating alert destinations against an org: the checks every writer that
 * stores an `AlertDestination[]` must run, shared by alert routing rules
 * (`PUT /alert-rules`) and report anomaly alerts
 * (`PUT /cost-reports/{id}/anomaly-alert`).
 *
 * Two halves, deliberately separate:
 *
 * - {@link destinationShapeError} is structural. Request bodies are `unknown`
 *   JSON wearing a type, so a destination with a bogus `kind` or a Slack
 *   destination with no `channelId` must be refused here: it would otherwise
 *   save cleanly and then route nowhere.
 * - {@link foreignDestinationError} is ownership. A destination may only name
 *   this org's live Slack channels, Teams webhooks, on-call rotations, current
 *   members, paging accounts, and addresses the org's email policy allows.
 *   That check is the only thing standing between a write endpoint and using
 *   someone else's connection as a send target.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  isAlertEmailAddressAllowed,
  normalizeAlertEmailAddress,
  type AlertDestination,
  type AlertRulesResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { msteamsWebhooks, onCallSchedules, slackChannels, slackInstallations } from "../db/schema";
import { getAlertEmailOptions } from "./email";
import { listPagingProviders } from "../paging/providers";

const DESTINATION_KINDS = new Set([
  "push",
  "slack",
  "msteams",
  "on-call",
  "github-issues",
  "email-member",
  "email-address",
  "paging-provider",
  "provider-on-call",
]);

/**
 * Structural check of one destination; `what` names it in the message
 * ("destination", "escalation destination").
 */
export function destinationShapeError(
  dest: AlertDestination | null | undefined,
  what: string,
): string | null {
  if (!dest || typeof dest !== "object" || !DESTINATION_KINDS.has(dest.kind)) {
    return `Unknown ${what} "${(dest as { kind?: string } | null)?.kind ?? "?"}"`;
  }
  if (dest.kind === "slack" && (typeof dest.channelId !== "string" || !dest.channelId)) {
    return `A Slack ${what} needs a channelId`;
  }
  if (dest.kind === "msteams" && (typeof dest.webhookId !== "string" || !dest.webhookId)) {
    return `A Teams ${what} needs a webhookId`;
  }
  if (dest.kind === "on-call" && (typeof dest.scheduleId !== "string" || !dest.scheduleId)) {
    return `An on-call ${what} needs a scheduleId`;
  }
  if (dest.kind === "email-member" && (typeof dest.userId !== "string" || !dest.userId)) {
    return `A member email ${what} needs a userId`;
  }
  if (
    dest.kind === "email-address" &&
    (typeof dest.address !== "string" || !normalizeAlertEmailAddress(dest.address))
  ) {
    return `An email ${what} needs a valid address`;
  }
  if (
    dest.kind === "paging-provider" &&
    (typeof dest.accountId !== "string" ||
      !dest.accountId ||
      typeof dest.targetId !== "string" ||
      !dest.targetId)
  ) {
    return `A paging provider ${what} needs an accountId and a targetId`;
  }
  if (
    dest.kind === "provider-on-call" &&
    (typeof dest.accountId !== "string" ||
      !dest.accountId ||
      typeof dest.sourceId !== "string" ||
      !dest.sourceId)
  ) {
    return `A provider on-call ${what} needs an accountId and a sourceId`;
  }
  return null;
}

/** Lowercase an extra address so dedupe and the policy check see one spelling. */
export function canonicalDestination(d: AlertDestination): AlertDestination {
  return d.kind === "email-address"
    ? { kind: "email-address", address: normalizeAlertEmailAddress(d.address) ?? d.address }
    : d;
}

/**
 * Everything a destination picker needs to render a destination as a name
 * rather than an id: the org's live Slack channels, Teams webhooks, enabled
 * on-call rotations, members and the external-address policy. The
 * `DestinationCatalog` half of `AlertRulesResponse`.
 */
export async function loadDestinationCatalog(
  organizationId: string,
): Promise<
  Pick<
    AlertRulesResponse,
    | "slackChannels"
    | "msTeamsWebhooks"
    | "onCallSchedules"
    | "members"
    | "emailAvailable"
    | "emailSettings"
    | "memberDomains"
  >
> {
  const [channels, webhooks, rotations, email] = await Promise.all([
    db
      .select({
        id: slackChannels.id,
        name: slackChannels.channelName,
        isPrivate: slackChannels.isPrivate,
      })
      .from(slackChannels)
      .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
      // Disconnected installations are filtered out, exactly as
      // `resolveSlackChannels` does at delivery time. Offering a channel the
      // sender can no longer reach would let the editor build a destination
      // that silently routes nowhere.
      .where(
        and(eq(slackChannels.organizationId, organizationId), isNull(slackInstallations.deletedAt)),
      ),
    db
      .select({ id: msteamsWebhooks.id, label: msteamsWebhooks.label })
      .from(msteamsWebhooks)
      .where(eq(msteamsWebhooks.organizationId, organizationId)),
    // Live rotations only, for the same reason.
    db
      .select({ id: onCallSchedules.id, name: onCallSchedules.name })
      .from(onCallSchedules)
      .where(
        and(eq(onCallSchedules.organizationId, organizationId), eq(onCallSchedules.enabled, true)),
      )
      .orderBy(onCallSchedules.name),
    getAlertEmailOptions(organizationId),
  ]);
  return {
    slackChannels: channels,
    msTeamsWebhooks: webhooks,
    onCallSchedules: rotations,
    members: email.members,
    emailAvailable: email.emailAvailable,
    emailSettings: email.settings,
    memberDomains: email.memberDomains,
  };
}

/** What this org owns, loaded once per write. */
export interface OwnedDestinations {
  channelIds: Set<string>;
  webhookIds: Set<string>;
  scheduleIds: Set<string>;
  memberIds: Set<string>;
  emailOptions: Awaited<ReturnType<typeof getAlertEmailOptions>>;
  pagingById: Map<string, Awaited<ReturnType<typeof listPagingProviders>>[number]>;
}

export async function loadOwnedDestinations(organizationId: string): Promise<OwnedDestinations> {
  const [ownChannels, ownWebhooks, ownSchedules, emailOptions, pagingAccounts] = await Promise.all([
    // Live installations only, matching `resolveSlackChannels`: a channel whose
    // install was disconnected would be accepted by ownership alone and then
    // dropped at delivery time.
    db
      .select({ id: slackChannels.id })
      .from(slackChannels)
      .innerJoin(slackInstallations, eq(slackInstallations.id, slackChannels.installationId))
      .where(
        and(eq(slackChannels.organizationId, organizationId), isNull(slackInstallations.deletedAt)),
      ),
    db
      .select({ id: msteamsWebhooks.id })
      .from(msteamsWebhooks)
      .where(eq(msteamsWebhooks.organizationId, organizationId)),
    db
      .select({ id: onCallSchedules.id })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.organizationId, organizationId)),
    getAlertEmailOptions(organizationId),
    // The target id itself is the provider's and is not re-listed: that would
    // make saving depend on the provider being reachable.
    listPagingProviders(organizationId),
  ]);
  return {
    channelIds: new Set(ownChannels.map((r) => r.id)),
    webhookIds: new Set(ownWebhooks.map((r) => r.id)),
    scheduleIds: new Set(ownSchedules.map((r) => r.id)),
    memberIds: new Set(emailOptions.members.map((m) => m.userId)),
    emailOptions,
    pagingById: new Map(pagingAccounts.map((a) => [a.accountId, a])),
  };
}

/** The first destination this org does not own, explained; null when all are its own. */
export function foreignDestinationError(
  owned: OwnedDestinations,
  dests: readonly AlertDestination[],
): string | null {
  for (const d of dests) {
    if (d.kind === "slack" && !owned.channelIds.has(d.channelId)) {
      return "That Slack channel is not connected to this organization";
    }
    if (d.kind === "msteams" && !owned.webhookIds.has(d.webhookId)) {
      return "That Teams channel is not connected to this organization";
    }
    if (d.kind === "on-call" && !owned.scheduleIds.has(d.scheduleId)) {
      return "That on-call rotation does not belong to this organization";
    }
    if (d.kind === "email-member" && !owned.memberIds.has(d.userId)) {
      return "That person is no longer a member of this organization; remove their email destination";
    }
    if (
      d.kind === "email-address" &&
      !isAlertEmailAddressAllowed(
        d.address.toLowerCase(),
        owned.emailOptions.settings,
        owned.emailOptions.memberDomains,
      )
    ) {
      return `${d.address} is outside the domains this organization allows for alert email`;
    }
    if (d.kind === "paging-provider" && !owned.pagingById.has(d.accountId)) {
      return "That paging provider account does not belong to this organization";
    }
    if (d.kind === "provider-on-call" && !owned.pagingById.get(d.accountId)?.onCallSourceLabel) {
      return "That account cannot say who is on call";
    }
  }
  return null;
}
