/**
 * The Twilio leg of cost anomaly alerting: one batched SMS per evaluation pass.
 *
 * Kept apart from `anomaly-eval.ts` for the reason `drift/summary.ts` is kept
 * apart from `drift/alerts.ts` — the rendering is pure and worth testing on its
 * own, and the pipeline that calls it should read as one line.
 *
 * ## Why batched
 *
 * A pass produces anomalies per dimension (`provider` **and** `service`) per key
 * per currency, so the day one account's spend jumps yields a provider anomaly
 * plus one for every service underneath it — all newly detected, all past the
 * 7-day per-key cooldown, all in the same set of loop iterations. One text per
 * anomaly is a flood by construction. So the evaluator collects what it
 * alerted on and calls {@link pageAboutAnomalies} once, after the loops.
 *
 * ## Why also rate-bounded
 *
 * Batching bounds a pass; it does not bound the *day*. The evaluation pass runs
 * at most hourly per org (`MIN_EVAL_INTERVAL_MS`), and the per-key cooldown
 * only stops the *same* key alerting again — a steady trickle of different keys
 * crossing the bar as late-restated data lands would text somebody 24 times.
 * `org_cost_anomaly_settings.sms_last_paged_at` is the hard bound: one text per
 * org per {@link ANOMALY_SMS_COOLDOWN_MS}, claimed with a single conditional
 * UPDATE (so two poller replicas produce one text) and rolled back when the
 * text reached nobody — otherwise an outage would buy six hours of silence.
 *
 * A suppressed text loses nothing that matters: the anomalies it would have
 * named are already stored, already listed in the UI, and already delivered to
 * push/Slack/Teams. SMS is the interrupt, not the record.
 *
 * Never throws. Anomaly evaluation sits on the poller's cost pass.
 */
import {
  ANOMALY_SMS_COOLDOWN_MS,
  claimAnomalySmsWindow,
  releaseAnomalySmsWindow,
  smsWantsKind,
  type CostAnomalySmsMode,
} from "./anomaly-settings";
import { sendOneShotPage } from "../twilio-pager";

export { ANOMALY_SMS_COOLDOWN_MS };

/** What one anomaly contributes to the text. */
export interface AnomalySmsItem {
  day: string;
  kind: "spike" | "new_source";
  dimension: "provider" | "service";
  dimensionKey: string;
  currency: string;
  /** The day's spend, in currency units. */
  actual: number;
  /** Baseline mean per day, in currency units. Zero-ish for a new source. */
  mean: number;
}

/**
 * How many anomalies the body names before collapsing into "and N more".
 *
 * Three, because the body has to survive `sendOneShotPage`'s 320-character cap
 * and a named item is the expensive part — a service key can be as long as
 * "Amazon Elastic Compute Cloud - Compute". The list is a pointer to the Costs
 * panel, not a replacement for it.
 */
export const MAX_LISTED_ANOMALIES = 3;

/**
 * The cap `sendOneShotPage` truncates at. Mirrored rather than imported as a
 * behavioural coupling: this module's job is to make sure that truncation never
 * has anything to do, because it cuts mid-word and would eat the trailing
 * "and N more" — the one part of the message that says the list is partial.
 */
export const SMS_BODY_MAX = 320;

/** A long provider/service key, shortened at a fixed budget per named item. */
const MAX_KEY_CHARS = 28;

function shortenKey(key: string): string {
  return key.length <= MAX_KEY_CHARS ? key : `${key.slice(0, MAX_KEY_CHARS - 1)}…`;
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The day, or the span, the batch covers — a pass judges three days. */
function dayLabel(items: AnomalySmsItem[]): string {
  let min = items[0]?.day ?? "";
  let max = min;
  for (const item of items) {
    if (item.day < min) min = item.day;
    if (item.day > max) max = item.day;
  }
  return min === max ? min : `${min}–${max}`;
}

/** One named anomaly: what it is, what it cost, what that is measured against. */
function describe(item: AnomalySmsItem): string {
  const key = shortenKey(item.dimensionKey);
  const spend = formatAmount(item.actual, item.currency);
  return item.kind === "new_source"
    ? `new ${item.dimension} ${key} ${spend}`
    : `${key} ${spend} vs ${formatAmount(item.mean, item.currency)}/day`;
}

/**
 * Render the batch.
 *
 * Built to fit rather than trimmed to fit: the header and the "and N more" tail
 * are budgeted *before* any item is appended, and items are only added while
 * the whole string still fits {@link SMS_BODY_MAX}. So the count is never the
 * thing that gets cut, and no name is ever chopped mid-word — the item either
 * fits whole or is folded into the remainder.
 */
export function formatAnomalySmsBody(items: AnomalySmsItem[]): string {
  const head = `infrawrench cost anomalies ${dayLabel(items)}: ${items.length} flagged`;
  const listable = items.slice(0, MAX_LISTED_ANOMALIES);

  const named: string[] = [];
  for (const item of listable) {
    const next = [...named, describe(item)];
    const remaining = items.length - next.length;
    const tail = remaining > 0 ? `; and ${remaining} more` : "";
    if (`${head} — ${next.join("; ")}${tail}`.length > SMS_BODY_MAX) break;
    named.push(next[next.length - 1]!);
  }

  const remaining = items.length - named.length;
  if (named.length === 0) return `${head}. See the Costs panel`;
  return `${head} — ${named.join("; ")}${remaining > 0 ? `; and ${remaining} more` : ""}`;
}

/** Why a pass did or did not text. Returned for tests and logs. */
export type AnomalySmsOutcome =
  | { status: "disabled" }
  | { status: "nothing-to-send" }
  | { status: "cooling-down" }
  | { status: "sent"; anomalies: number; recipients: number; body: string }
  | { status: "undelivered"; anomalies: number }
  | { status: "failed"; error: string };

/**
 * Send at most one SMS for everything this pass alerted on.
 *
 * `items` is what the evaluator delivered (or attempted to deliver) in this
 * pass, in detection order — oldest day first, providers before services, which
 * is the order worth naming in first.
 */
export async function pageAboutAnomalies(
  organizationId: string,
  mode: CostAnomalySmsMode,
  items: AnomalySmsItem[],
  now = new Date(),
): Promise<AnomalySmsOutcome> {
  try {
    if (mode === "off") return { status: "disabled" };
    const wanted = items.filter((item) => smsWantsKind(mode, item.kind));
    if (wanted.length === 0) return { status: "nothing-to-send" };

    const { claimed, prior } = await claimAnomalySmsWindow(organizationId, now);
    if (!claimed) return { status: "cooling-down" };

    const body = formatAnomalySmsBody(wanted);
    // SMS only. A budget crossing does not ring a phone and neither does this;
    // `sendOneShotPage` leaves voice off unless a caller asks for it.
    const result = await sendOneShotPage(organizationId, body);
    if (result.succeeded > 0) {
      return {
        status: "sent",
        anomalies: wanted.length,
        recipients: result.succeeded,
        body,
      };
    }

    // Nobody was reachable (no recipients opted in, creds missing, Twilio
    // down). The window was not spent, so hand it back.
    await releaseAnomalySmsWindow(organizationId, now, prior).catch((err: unknown) => {
      console.error(`[anomaly-sms] releasing the claim for org ${organizationId} failed:`, err);
    });
    return { status: "undelivered", anomalies: wanted.length };
  } catch (err) {
    console.error(`[anomaly-sms] paging for org ${organizationId} failed:`, err);
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
