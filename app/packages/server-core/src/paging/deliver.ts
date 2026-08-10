/**
 * Cloud delivery for a page, shared by everything that raises one.
 *
 * Two callers page today and they must behave identically, so the cooldown
 * protocol and the transport fan-out live here rather than in either of them:
 *
 * - `workflows/paging.ts` — a workflow calling `infra.page(...)`.
 * - `paging/external-pages.ts` — a server calling `POST /pages`.
 *
 * The transports are the same ones the sync-failure pager and budget alerts
 * use: Twilio SMS (plus voice on request) sent directly, and push / Slack /
 * Teams through `routeAlert`, which picks destinations from the org's routing
 * rules. SMS stays outside the rules because its recipient list is phone
 * numbers on `twilio_recipients`, not channels an alert rule can name.
 *
 * The cooldown lives behind {@link PageCooldownStore} because its row differs
 * per caller (keyed by workflow, or by source), but the protocol does not:
 * whoever wins the conditional claim sends, everyone else is suppressed. That
 * is what stops two poller replicas running the same cron from double-paging.
 * As in twilio-pager.ts, the claim is rolled back when every transport failed,
 * so a page nobody received doesn't start a cooldown.
 */
import {
  DEFAULT_PAGE_COOLDOWN_MINUTES,
  DEFAULT_PAGE_KEY,
  type PageResult,
  type PageSpec,
} from "@infrawrench/workflow-runtime";

import type { PushData } from "../push/types";
import { alertReached, routeAlert } from "../alerts/route";
import { sendOneShotPage } from "../twilio-pager";

/** Who is paging, and where each transport should point. */
export interface PageAudience {
  organizationId: string;
  /** Notification title when the spec sets none. */
  name: string;
  /** Slack/Teams context line, e.g. `Workflow: nightly-check`. */
  context: string;
  /** Deep link behind the Slack/Teams button, or null when APP_URL is unset. */
  url: string | null;
  /** Mobile deep-link payload — the routing contract with the app. */
  pushData: PushData;
}

/** The prior state of a cooldown row, for a rollback. */
export interface PriorPage {
  lastPagedAt: Date;
}

/**
 * The cooldown row for one (pager, key) pair. `claim` must be a single
 * conditional statement — a read-then-write loses the race it exists to win.
 */
export interface PageCooldownStore {
  /** The current row, or null when this key has never paged. */
  read(): Promise<PriorPage | null>;
  /**
   * Take the cooldown slot, returning false when the key is still cooling
   * down. Inserts when the key has never paged, and otherwise updates only if
   * the cooldown has elapsed.
   */
  claim(message: string, cooldownMinutes: number): Promise<boolean>;
  /** Undo a claim whose page reached nobody, restoring `prior` (or deleting). */
  release(prior: PriorPage | null): Promise<void>;
}

/** Resolve a spec's key and cooldown against the defaults. */
export function pageKeyAndCooldown(spec: PageSpec): { key: string; cooldownMinutes: number } {
  return {
    key: spec.key || DEFAULT_PAGE_KEY,
    cooldownMinutes: Math.max(0, spec.cooldownMinutes ?? DEFAULT_PAGE_COOLDOWN_MINUTES),
  };
}

/** SMS body: short, prefixed, and says who is talking. */
function smsBody(audience: PageAudience, spec: PageSpec): string {
  return `infrawrench: ${spec.title ?? audience.name} — ${spec.message}`;
}

/**
 * Deliver one page, honoring the key's cooldown. Never throws: a paging outage
 * must not fail the caller that reported the problem.
 */
export async function deliverPage(
  audience: PageAudience,
  store: PageCooldownStore,
  spec: PageSpec,
): Promise<PageResult> {
  const { cooldownMinutes } = pageKeyAndCooldown(spec);

  const prior = await store.read();
  const claimed = await store.claim(spec.message, cooldownMinutes);
  if (!claimed) {
    // Only a prior row can block the claim, so `prior` is set here in practice;
    // fall back to "now" rather than reporting a retryAt we can't compute.
    const since = prior?.lastPagedAt ?? new Date();
    return {
      delivered: false,
      suppressed: true,
      sms: 0,
      push: 0,
      slack: 0,
      msTeams: 0,
      retryAt: new Date(since.getTime() + cooldownMinutes * 60_000).toISOString(),
    };
  }

  const title = spec.title ?? audience.name;
  const twilio = await sendOneShotPage(audience.organizationId, smsBody(audience, spec), {
    ...(spec.voice ? { voice: true } : {}),
  });
  // `bypassQuietHours`: `infra.page()` is the author saying "wake someone".
  // The org can still route it wherever it likes — and can give the rule an
  // escalation policy, which is what makes an unanswered 3am page ring a second
  // channel — but holding a page until morning would defeat the one call in the
  // whole API whose entire purpose is to interrupt.
  const routed = await routeAlert(
    {
      organizationId: audience.organizationId,
      trigger: "workflowPages",
      title,
      body: spec.message,
      context: audience.context,
      url: audience.url,
      pushData: audience.pushData,
      facts: { key: audience.name },
    },
    { bypassQuietHours: true },
  );

  const delivered = twilio.succeeded > 0 || alertReached(routed);
  if (!delivered) await store.release(prior);

  return {
    delivered,
    suppressed: false,
    sms: twilio.succeeded,
    push: routed.byTransport.push,
    slack: routed.byTransport.slack,
    msTeams: routed.byTransport.msTeams,
  };
}

/** Base URL for deep links, or null when the server has no APP_URL configured. */
export function appBaseUrl(): string | null {
  const base = process.env["APP_URL"];
  return base ? base.replace(/\/$/, "") : null;
}
