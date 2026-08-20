/**
 * `routeAlert` — the one call every detector makes to tell an org something.
 *
 * Before this module each raise site did the same three things in a row: build a
 * push message, build a Slack alert, build a Teams alert, `await` each of the
 * three `sendXToOrg(orgId, trigger, …)` helpers, then OR their success counts
 * together to decide whether the alert "reached anyone". Fourteen call sites,
 * three transports, and a trigger name repeated three times in each. Adding a
 * transport meant touching all fourteen; adding a trigger meant a column in
 * three tables and an entry in three maps.
 *
 * Now: one call, one trigger name, one result. Which destinations hear about it
 * is decided by the org's `alert_rules` (evaluated by the pure
 * `routeAlertRules` in client-core), and the transports are addressed by id.
 *
 * ## The contract callers depend on
 *
 * Several detectors gate on whether an alert was delivered, because that is
 * what they stamp their cooldown or claim with — `cost_anomalies.notified_at`,
 * the drift `releaseUnlessDelivered` guard, `PageCooldownStore.release`. Those
 * protocols are unchanged and must stay unchanged; this module only had to keep
 * giving them an honest answer.
 *
 * The subtlety quiet hours introduce is that "held" is neither delivered nor
 * lost. A held alert has `succeeded === 0` but *will* go out when the window
 * closes, so treating it as undelivered would roll back the very claim that
 * stops the next pass from raising it again — and the alert would then be
 * raised twice, or (worse, for drift) the released window would be re-scanned
 * and the held copy would arrive alongside a duplicate. So the result carries
 * `held` separately and {@link alertReached} is what call sites gate on:
 * delivered *or* safely queued.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type AlertDestination,
  type AlertFacts,
  type AlertSeverity,
  type AlertTrigger,
  type RoutedLeg,
  alertTriggerDef,
  destinationKey,
  routeAlertRules,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { alertDeliveries } from "../db/schema";
import { sendPushToOrg, sendPushToOrgUser } from "../push/dispatch";
import type { PushData } from "../push/types";
import {
  type SlackMessageButton,
  type SlackPostedMessage,
  sendSlackToChannels,
  sendSlackToChannelsTracked,
} from "../slack";
import { sendMsTeamsToWebhooks } from "../msteams";
import { resolveRoutingRules } from "./rules";
import { resolveOnCallNow } from "../on-call/store";

/**
 * Everything a detector knows about the thing it is reporting.
 *
 * `title`/`body`/`context`/`url` are what a human reads; `facts` are what rules
 * match on. Keeping them apart is what lets a rule say "over $500" without
 * parsing the sentence that happens to contain a dollar sign.
 */
export interface AlertEvent {
  organizationId: string;
  trigger: AlertTrigger;
  /** Defaults to the trigger's `defaultSeverity` when omitted. */
  severity?: AlertSeverity;
  title: string;
  /** The full text. Used by Slack, and by Teams unless `teamsBody` overrides. */
  body: string;
  /**
   * A shorter body for the lock screen. Defaults to `body`. Several detectors
   * already made this distinction (an anomaly's hint list is a paragraph in
   * Slack and one clause in a push); it is now a field rather than two
   * separately constructed messages.
   */
  pushBody?: string;
  /**
   * A Teams-specific rendering, when the two chat transports genuinely differ.
   * Only the drift digest needs it today — Slack mrkdwn and Adaptive Card
   * markdown disagree about lists — so it defaults to `body` rather than
   * forcing every caller to supply the same string twice.
   */
  teamsBody?: string;
  /** Slack/Teams trailing context line. */
  context?: string;
  /** Deep link behind the "View in Infrawrench" button. */
  url?: string | null;
  /**
   * The mobile deep-link contract. Optional only because a `channelOnly`
   * trigger (the weekly digest) never reaches a phone and so has no route to
   * describe; a rule naming `push` for such a trigger is dropped before this is
   * read. Any trigger a phone can receive must supply it.
   */
  pushData?: PushData;
  facts?: AlertFacts;
}

/**
 * Deliveries per transport. Several callers report this back to the user — the
 * weekly digest's last-attempt status, `infra.page()`'s return value, the drift
 * notifier's outcome — so the aggregate `succeeded` is not enough on its own.
 * `push` counts *devices*, matching what `sendPushToOrg` has always returned;
 * the other two count channels.
 */
export interface AlertTransportCounts {
  push: number;
  slack: number;
  msTeams: number;
}

export interface AlertRouteResult {
  /** Destinations tried across every matching rule. */
  attempted: number;
  /** Destinations that took the message. */
  succeeded: number;
  /** The same successes, split by transport. */
  byTransport: AlertTransportCounts;
  /** Destinations tried, split by transport. Distinguishes "no channel is
   * routed here" from "every channel failed", which the weekly digest's
   * last-attempt status shows the user. */
  attemptedByTransport: AlertTransportCounts;
  /** Legs quiet hours parked for later. Counts as reached — see the note above. */
  held: number;
  /** True when no rule matched, so nothing was even attempted. */
  unrouted: boolean;
  /** Rules that matched, for the log line and the "why did I get this" UI. */
  matchedRuleIds: string[];
  /** Posted Slack messages, when the caller asked for them (`track`). */
  slackMessages: SlackPostedMessage[];
  /** Delivery rows created for acknowledgement, if the rule escalates. */
  deliveryIds: string[];
}

/**
 * An empty result.
 *
 * A factory rather than a shared constant: the result carries two count objects
 * and three arrays, and this module already mutates count objects in place
 * through `addCounts`. A single shared instance would hand every caller of every
 * empty result the same `byTransport` and `deliveryIds`, so one caller that
 * pushed onto or added into a field it was handed would corrupt every later
 * empty result in the process.
 */
function nothing(): AlertRouteResult {
  return {
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    held: 0,
    unrouted: true,
    matchedRuleIds: [],
    slackMessages: [],
    deliveryIds: [],
  };
}

/**
 * Whether an alert reached its audience or is guaranteed to.
 *
 * This is the predicate every cooldown and claim should gate on. `succeeded > 0`
 * alone would treat a quiet-hours hold as a total failure and roll back a claim
 * that is doing its job.
 */
export function alertReached(result: AlertRouteResult): boolean {
  return result.succeeded > 0 || result.held > 0;
}

export interface RouteAlertOptions {
  /**
   * Return the posted Slack messages so the caller can update them in place.
   * Approval requests need this; ordinary alerts do not, and asking for it
   * costs nothing but is noise in the result.
   */
  track?: boolean;
  /** Extra Slack buttons, rendered before the "View in Infrawrench" link. */
  slackButtons?: SlackMessageButton[];
  /**
   * Ignore quiet hours entirely. The weekly digest sets this: it is already
   * scheduled to a time the org chose, so holding it until a *different* time
   * the org chose is two schedules arguing.
   */
  bypassQuietHours?: boolean;
  /**
   * Skip rule evaluation and send to exactly these legs.
   *
   * Only the follow-up pass (`alerts/pass.ts`) uses this, and only to replay a
   * decision that was already made: a held alert goes to the destinations its
   * rule named *when the alert happened*, not to whatever the table says hours
   * later. Routing it again would make the message depend on when somebody
   * happened to save the form. Sending it through this function anyway — rather
   * than a separate send path — is what keeps de-duplication, the channel-only
   * push rule and escalation arming identical for held and immediate copies.
   */
  pinnedLegs?: RoutedLeg[];
  /**
   * Attach the Acknowledge button for an `alert_deliveries` row that already
   * exists, instead of creating one.
   *
   * The follow-up pass needs this when it flushes a held alert that also
   * escalates: the row was written when the alert was raised, and letting the
   * replay arm a *second* row would mean two escalation clocks for one alert
   * and a button that acknowledges only one of them.
   */
  ackDeliveryId?: string;
  /** Test seam. Defaults to the wall clock. */
  now?: Date;
}

interface DestinationOutcome {
  attempted: number;
  succeeded: number;
  counts: AlertTransportCounts;
  attemptedCounts: AlertTransportCounts;
  slackMessages: SlackPostedMessage[];
}

/**
 * Fan one leg's destinations out, grouped by transport so each transport is
 * called once with a list rather than once per destination.
 */
async function deliverDestinations(
  event: AlertEvent,
  destinations: AlertDestination[],
  options: RouteAlertOptions,
  extraButtons: SlackMessageButton[],
): Promise<DestinationOutcome> {
  const def = alertTriggerDef(event.trigger);
  const slackIds: string[] = [];
  const teamsIds: string[] = [];
  const onCallScheduleIds: string[] = [];
  let wantsPush = false;

  for (const d of destinations) {
    switch (d.kind) {
      case "on-call":
        // Resolved below, after the loop, because it needs a database read and
        // several rules may name the same rotation.
        if (!def.channelOnly && event.pushData) onCallScheduleIds.push(d.scheduleId);
        break;
      case "push":
        // A channel-only trigger silently drops its push destination rather
        // than erroring: a rule that says "weekly digest → phones" is a
        // mistake, but the right response is to deliver the rest of it. Same
        // for an event that carries no deep-link payload — there would be
        // nothing for a tap to open.
        if (!def.channelOnly && event.pushData) wantsPush = true;
        break;
      case "slack":
        slackIds.push(d.channelId);
        break;
      case "msteams":
        teamsIds.push(d.webhookId);
        break;
    }
  }

  const alert = {
    title: event.title,
    body: event.body,
    ...(event.context ? { context: event.context } : {}),
    ...(event.url ? { url: event.url } : {}),
  };
  const teamsAlert = event.teamsBody ? { ...alert, body: event.teamsBody } : alert;

  const buttons = [...(options.slackButtons ?? []), ...extraButtons];
  const slackAlert = buttons.length > 0 ? { ...alert, buttons } : alert;

  // Resolve the rotations to people before sending. Deduplicated by *user*
  // rather than by schedule: two rules naming two rotations that happen to have
  // the same person on call this week must not ring their phone twice.
  const onCallUserIds = new Set<string>();
  if (onCallScheduleIds.length > 0) {
    const resolved = await Promise.all(
      [...new Set(onCallScheduleIds)].map((scheduleId) =>
        resolveOnCallNow(event.organizationId, scheduleId),
      ),
    );
    for (const entry of resolved) {
      if (entry.shift) onCallUserIds.add(entry.shift.userId);
    }
  }

  const [push, slack, teams, onCall] = await Promise.all([
    wantsPush
      ? sendPushToOrg(event.organizationId, event.trigger, {
          title: event.title,
          body: event.pushBody ?? event.body,
          data: event.pushData as PushData,
        })
      : Promise.resolve({ attempted: 0, succeeded: 0 }),
    slackIds.length > 0
      ? options.track || buttons.length > 0
        ? sendSlackToChannelsTracked(event.organizationId, slackIds, slackAlert)
        : sendSlackToChannels(event.organizationId, slackIds, slackAlert).then((r) => ({
            ...r,
            messages: [] as SlackPostedMessage[],
          }))
      : Promise.resolve({ attempted: 0, succeeded: 0, failed: 0, messages: [] }),
    teamsIds.length > 0
      ? sendMsTeamsToWebhooks(event.organizationId, teamsIds, teamsAlert)
      : Promise.resolve({ attempted: 0, succeeded: 0, failed: 0 }),
    // One personal push per on-call person. `sendPushToOrgUser` applies the
    // same per-member trigger mutes as the org fan-out: an organization rule
    // decides whether the org is told, a member decides whether their phone
    // rings — and being on call does not override that, because a rotation is
    // not a licence to bypass somebody's own settings.
    onCallUserIds.size > 0
      ? Promise.all(
          [...onCallUserIds].map((userId) =>
            sendPushToOrgUser(event.organizationId, userId, event.trigger, {
              title: event.title,
              body: event.pushBody ?? event.body,
              data: event.pushData as PushData,
            }),
          ),
        ).then((results) => ({
          // Counted per *person*, not per device: a rule names "whoever is on
          // call" once, and counting devices would make one person with three
          // phones look like three destinations.
          attempted: results.length,
          succeeded: results.filter((r) => r.succeeded > 0).length,
        }))
      : Promise.resolve({ attempted: 0, succeeded: 0 }),
  ]);

  return {
    // Push counts as one destination however many devices it reached: a rule
    // lists "the org's phones" once, and counting devices here would make a
    // 40-person org look like it delivered 40 times to one destination. The
    // device count is still reported, under `counts.push`, because that is the
    // number the callers who show one to the user have always shown.
    attempted: (wantsPush ? 1 : 0) + slack.attempted + teams.attempted + onCall.attempted,
    succeeded: (push.succeeded > 0 ? 1 : 0) + slack.succeeded + teams.succeeded + onCall.succeeded,
    counts: { push: push.succeeded, slack: slack.succeeded, msTeams: teams.succeeded },
    attemptedCounts: {
      push: push.attempted,
      slack: slack.attempted,
      msTeams: teams.attempted,
    },
    slackMessages: slack.messages,
  };
}

function addCounts(into: AlertTransportCounts, from: AlertTransportCounts): void {
  into.push += from.push;
  into.slack += from.slack;
  into.msTeams += from.msTeams;
}

/**
 * Record a leg that must be followed up: quiet-hours held, or awaiting an
 * acknowledgement. Returns the row id, or null when the insert failed — a
 * bookkeeping failure must never propagate into the detector.
 */
async function recordDelivery(
  event: AlertEvent,
  leg: RoutedLeg,
  state: "held" | "awaiting_ack",
  now: Date,
): Promise<string | null> {
  const id = randomUUID();
  try {
    await db.insert(alertDeliveries).values({
      id,
      organizationId: event.organizationId,
      // A synthesized default rule has no row to point at; the snapshot name
      // still explains the delivery.
      ruleId: leg.ruleId === "default" ? null : leg.ruleId,
      ruleName: leg.ruleName,
      trigger: event.trigger,
      severity: event.severity ?? alertTriggerDef(event.trigger).defaultSeverity,
      state,
      payload: event,
      destinations: leg.destinations,
      escalation: leg.escalation,
      deliverAfter: state === "held" ? leg.holdUntil : null,
      escalateAt:
        state === "awaiting_ack" && leg.escalation
          ? new Date(now.getTime() + leg.escalation.afterMinutes * 60_000)
          : null,
    });
    return id;
  } catch (err) {
    console.error("[alerts] failed to record delivery:", err);
    return null;
  }
}

/**
 * The Acknowledge button attached to a Slack message when the rule escalates.
 *
 * The value carries the org alongside the delivery id, in the same
 * `{o, …}` shape the status-disambiguation button uses. It could have carried
 * the id alone — the row knows its org — but the inbound handler has to resolve
 * the clicking Slack user to a member *of a specific org* before it trusts
 * anything, and reading the row first to find out which org to check would mean
 * touching a row on behalf of an unauthenticated click. The value is not a
 * credential either way: `acknowledgeAlert` scopes its UPDATE to the org the
 * membership check passed for, so a forged org id resolves to no membership and
 * a forged delivery id matches no row.
 */
export const ALERT_ACK_ACTION_ID = "infrawrench_alert_ack";

export interface AlertAckButtonValue {
  organizationId: string;
  deliveryId: string;
}

export function parseAlertAckButtonValue(raw: string | undefined): AlertAckButtonValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { o?: string; d?: string };
    if (!parsed.o || !parsed.d) return null;
    return { organizationId: parsed.o, deliveryId: parsed.d };
  } catch {
    return null;
  }
}

function ackButton(organizationId: string, deliveryId: string): SlackMessageButton {
  return {
    text: "Acknowledge",
    actionId: ALERT_ACK_ACTION_ID,
    value: JSON.stringify({ o: organizationId, d: deliveryId }),
    style: "primary",
  };
}

/**
 * Route one alert. Never throws: a routing or transport failure must not break
 * the poller, the budget evaluator, or the workflow that raised the alert —
 * the same contract every `sendXToOrg` had, kept because the callers rely on it.
 */
export async function routeAlert(
  event: AlertEvent,
  options: RouteAlertOptions = {},
): Promise<AlertRouteResult> {
  const now = options.now ?? new Date();
  try {
    const severity = event.severity ?? alertTriggerDef(event.trigger).defaultSeverity;
    const decision = options.pinnedLegs
      ? {
          legs: options.pinnedLegs,
          matchedRuleIds: options.pinnedLegs.map((l) => l.ruleId),
          unrouted: false,
        }
      : routeAlertRules(
          (await resolveRoutingRules(event.organizationId)).rules,
          {
            trigger: event.trigger,
            severity,
            title: event.title,
            body: event.body,
            facts: event.facts ?? {},
          },
          now,
        );

    if (decision.legs.length === 0) {
      if (decision.unrouted) {
        // Not an error — an org can legitimately route a trigger nowhere — but
        // it is the single most likely explanation for "why didn't I get
        // paged", so it is never silent.
        console.log(
          `[alerts] ${event.trigger} for org ${event.organizationId} matched no rule with destinations`,
        );
      }
      return { ...nothing(), unrouted: decision.unrouted, matchedRuleIds: decision.matchedRuleIds };
    }

    let attempted = 0;
    let succeeded = 0;
    let held = 0;
    const byTransport: AlertTransportCounts = { push: 0, slack: 0, msTeams: 0 };
    const attemptedByTransport: AlertTransportCounts = { push: 0, slack: 0, msTeams: 0 };
    const slackMessages: SlackPostedMessage[] = [];
    const deliveryIds: string[] = [];
    const seen = new Set<string>();

    for (const leg of decision.legs) {
      // Two rules can name the same channel — a tee rule above a catch-all is
      // the ordinary way that happens — and nobody wants the message twice.
      // De-duplicating across legs rather than within one keeps the first rule
      // that claimed a destination as its owner, which is also the rule whose
      // escalation policy applies.
      const fresh = leg.destinations.filter((d) => {
        const key = destinationKey(d);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length === 0) continue;

      if (leg.holdUntil && !options.bypassQuietHours) {
        const id = await recordDelivery(event, { ...leg, destinations: fresh }, "held", now);
        if (id) {
          held += 1;
          deliveryIds.push(id);
        } else {
          // The queue insert is the only thing standing between a held alert
          // and silence, so when it fails we send now rather than lose it. A
          // 3am notification is a smaller problem than a missing one.
          const out = await deliverDestinations(event, fresh, options, []);
          attempted += out.attempted;
          succeeded += out.succeeded;
          addCounts(byTransport, out.counts);
          addCounts(attemptedByTransport, out.attemptedCounts);
          slackMessages.push(...out.slackMessages);
        }
        continue;
      }

      // Escalating legs need their row (and its id) before they send, because
      // the id is what the Acknowledge button carries. A replay supplies the
      // row it already has rather than arming a second one.
      let ackId: string | null = options.ackDeliveryId ?? null;
      const armed = ackId === null;
      if (armed && leg.escalation && leg.escalation.destinations.length > 0) {
        ackId = await recordDelivery(event, { ...leg, destinations: fresh }, "awaiting_ack", now);
        if (ackId) deliveryIds.push(ackId);
      }

      const out = await deliverDestinations(
        event,
        fresh,
        options,
        ackId ? [ackButton(event.organizationId, ackId)] : [],
      );
      attempted += out.attempted;
      succeeded += out.succeeded;
      addCounts(byTransport, out.counts);
      addCounts(attemptedByTransport, out.attemptedCounts);
      slackMessages.push(...out.slackMessages);

      // An escalation whose original delivery reached nobody has nothing to
      // escalate *from*, and leaving the row armed would fire a "nobody
      // acknowledged" message about an alert nobody ever saw. Same shape as the
      // `releaseUnlessDelivered` rule the drift notifier uses on its claim.
      // Only rows this call armed are released — a replay's row belongs to the
      // pass that owns it and deciding its fate here would race with that pass.
      //
      // A failed delete must not simply be logged: the row would stay in
      // `awaiting_ack` with `escalateAt` set, and the follow-up pass would
      // produce exactly the escalation this block exists to prevent. So there
      // is a fallback — expire the row in place, which clears both deadlines
      // and makes it invisible to both claims — and the id is only dropped from
      // `deliveryIds` once one of the two disarmed it. If both fail the caller
      // keeps the id and can still settle the row itself.
      if (armed && ackId && out.succeeded === 0) {
        let released = false;
        try {
          await db.delete(alertDeliveries).where(eq(alertDeliveries.id, ackId));
          released = true;
        } catch (err) {
          console.error("[alerts] failed to release ack row:", err);
          try {
            await db
              .update(alertDeliveries)
              .set({ state: "expired", deliverAfter: null, escalateAt: null, updatedAt: now })
              .where(eq(alertDeliveries.id, ackId));
            released = true;
          } catch (fallbackErr) {
            console.error("[alerts] failed to expire undeliverable ack row:", fallbackErr);
          }
        }
        if (released) deliveryIds.splice(deliveryIds.indexOf(ackId), 1);
      }
    }

    return {
      attempted,
      succeeded,
      byTransport,
      attemptedByTransport,
      held,
      unrouted: false,
      matchedRuleIds: decision.matchedRuleIds,
      slackMessages,
      deliveryIds,
    };
  } catch (err) {
    console.error("[alerts] routeAlert failed:", err);
    return nothing();
  }
}
