/**
 * Cost annotations — dated notes drawn over a cost chart.
 *
 * A spend chart shows a step change and nothing else. Six weeks later nobody
 * remembers whether it was a migration, a launch, or a price change, and the
 * answer lives in a Slack thread if it lives anywhere. An annotation puts it
 * next to the number.
 *
 * Two decisions are worth stating up front, because everything below follows
 * from them:
 *
 * 1. **An annotation carries a start day and an optional end day.** A deploy is
 *    a moment; a migration is a week. Spelling the week as seven notes is a lie
 *    about how many things happened, and spelling it as one day is a lie about
 *    when it stopped. The cost of supporting both is one nullable column and a
 *    comparison — "which buckets does [start, end] intersect" is the same set
 *    operation as "which bucket contains start", with the degenerate case
 *    falling out for free.
 * 2. **An annotation is an overlay, never data.** Nothing here is summed, and
 *    nothing here reaches a series, a total, or an axis domain. A chart drawn
 *    with annotations and the same chart drawn without them plot identical
 *    numbers; only the markers differ.
 *
 * These types and helpers live in `@infrawrench/client-core` rather than
 * `@infrawrench/ui` because mobile draws the same markers with SVG and doesn't
 * depend on that package. `ui/src/cost/config.ts` holds the zod schema the API
 * validates against and proves, at compile time, that it still parses to
 * exactly {@link CostAnnotationInput}.
 */

import {
  costAnomalyDeltaPercent,
  costBucketStart,
  type CostAnomaly,
  type CostBinningId,
} from "./costs";
import type { CloudFetch } from "./fetch";

/** Bounds the API enforces on an annotation. */
export const COST_ANNOTATION_LIMITS = {
  /**
   * A note, not a document. Long enough for "Migrated the API fleet from m5 to
   * m7g — see RFC-114", short enough that a marker's text is readable in a
   * popover on a phone.
   */
  maxTextLength: 500,
  /**
   * The longest span a single annotation may cover, in days. A note that covers
   * a year is not an annotation, it is a background colour: it would shade every
   * bucket of most charts and stop distinguishing anything.
   */
  maxSpanDays: 366,
} as const;

/**
 * A dated note as the API returns it.
 *
 * `costReportId` is the scope, and its default matters: **null is org-wide**,
 * and an org-wide annotation appears on every cost chart. "We changed instance
 * types" is not a fact about one report, and filing it under one would mean
 * every other chart showing the same step change still has no explanation. A
 * report id narrows it to the one report whose chart it is really about.
 */
export interface CostAnnotation {
  id: string;
  /** Inclusive first day, `YYYY-MM-DD` (UTC) — the day the thing happened. */
  startDate: string;
  /**
   * Inclusive last day, or null when the annotation is a moment rather than a
   * span. Never earlier than `startDate`; equal to it reads as a moment too.
   */
  endDate: string | null;
  text: string;
  /** Report this note is scoped to; **null is org-wide** — see above. */
  costReportId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The detected anomaly this note was written to explain, when it came from
   * acknowledging one, and null for a hand-written note.
   *
   * The other half of {@link CostAnomalyAcknowledgement.annotationId}, resolved
   * by the API from the same single foreign key rather than stored twice — two
   * columns for one fact is how the two disagree. It is what makes a marker on
   * a chart traceable back to the finding it closed, so "we migrated the fleet"
   * can be checked against the spike it explains.
   */
  costAnomalyId?: string | null;
}

/** Create/update payload (POST/PUT /cost-annotations). */
export interface CostAnnotationInput {
  startDate: string;
  /** Absent or null is a single-day note. */
  endDate?: string | null | undefined;
  text: string;
  /** Absent or null files the note org-wide, on every cost chart. */
  costReportId?: string | null | undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between two ISO dates, inclusive of both ends. */
function inclusiveDaySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Why this annotation cannot be saved, or null when it can.
 *
 * Shared so the editors refuse locally exactly what the API refuses remotely,
 * with the same words — a form that accepts a note the server then rejects is
 * the failure this prevents.
 */
export function costAnnotationInputError(input: CostAnnotationInput): string | null {
  if (!ISO_DAY.test(input.startDate)) return "Pick a date for the annotation.";
  const text = input.text.trim();
  if (!text) return "An annotation needs some text — that is the whole point of it.";
  if (text.length > COST_ANNOTATION_LIMITS.maxTextLength) {
    return `Keep the note under ${COST_ANNOTATION_LIMITS.maxTextLength} characters.`;
  }
  const end = input.endDate ?? null;
  if (end !== null) {
    if (!ISO_DAY.test(end)) return "The end date isn't a date.";
    if (end < input.startDate) return "The end date can't be before the start date.";
    if (inclusiveDaySpan(input.startDate, end) > COST_ANNOTATION_LIMITS.maxSpanDays) {
      return `An annotation can span at most ${COST_ANNOTATION_LIMITS.maxSpanDays} days.`;
    }
  }
  return null;
}

/**
 * The bucket key a day falls in, or null when the day is not an ISO date.
 *
 * The binning itself is {@link costBucketStart} — the one derivation that has to
 * agree with `bucketExpr` in `server-core/clickhouse/cost-readers` (Monday-start
 * weeks, first-of-month, daily keys for `cumulative` because it is a running sum
 * over them). Re-deriving it here is exactly how a marker would end up one bar
 * away from the money it explains, so this only adds the guard the overlay
 * needs: a stored value that isn't a date must produce no marker at all rather
 * than throw on `new Date(...).toISOString()`.
 */
function bucketKey(day: string, binning: CostBinningId): string | null {
  if (!ISO_DAY.test(day)) return null;
  return costBucketStart(day, binning);
}

/**
 * One drawn marker: a bucket, the annotations that belong to it, and how far a
 * spanning annotation reaches.
 *
 * There is at most one marker per bucket **by construction**. Several notes on
 * one day — or on one month, at monthly binning, which is the common case — must
 * aggregate into a single marker; drawing one flag per note would overprint them
 * into an unreadable smear exactly where the interesting thing happened.
 */
export interface CostAnnotationMarker {
  /** An existing chart bucket — the marker's x position. */
  bucket: string;
  /**
   * The last chart bucket a spanning annotation in this marker reaches, or null
   * when every annotation here begins and ends in `bucket`. Clamped to the
   * chart's own last bucket, so shading never extends the axis.
   */
  endBucket: string | null;
  /** 1-based position in bucket order — the number printed on the chart. */
  index: number;
  /** Every annotation on this bucket, earliest start first. */
  annotations: CostAnnotation[];
}

/**
 * Map annotations onto the buckets a chart actually drew.
 *
 * `buckets` is the chart's own bucket list (the pivoted rows' keys, forecast
 * buckets included) — the derivation is never repeated here, which is what keeps
 * a marker on the bar it names. Everything else follows three rules:
 *
 * - **Out of range is not drawn.** An annotation whose span shares no bucket
 *   with the chart is dropped entirely. It is never appended as a new category,
 *   so it cannot stretch the axis or add an empty bar.
 * - **Overlapping is clamped, not dropped.** A migration that started before the
 *   window and ends inside it is real information about the window, so its
 *   marker snaps to the first drawn bucket and its shading stops at the last.
 * - **One marker per bucket.** Annotations sharing a bucket aggregate; the
 *   marker's `endBucket` is the furthest any of them reaches.
 *
 * A bucket the chart skipped entirely (no spend at all in that period, so the
 * query returned no row for it) is not a valid x position, so an annotation
 * landing there snaps to the nearest drawn bucket on or after it. Dropping it
 * would hide a note that is genuinely inside the window.
 */
export function bucketCostAnnotations(
  annotations: readonly CostAnnotation[],
  buckets: readonly string[],
  binning: CostBinningId,
): CostAnnotationMarker[] {
  if (buckets.length === 0 || annotations.length === 0) return [];
  // ISO dates sort lexicographically, so ordering is comparison, not parsing.
  const ordered = [...new Set(buckets)].sort();
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;

  /** First drawn bucket at or after `key`; null when `key` is past the end. */
  const snapForward = (key: string): string | null => ordered.find((b) => b >= key) ?? null;
  /** Last drawn bucket at or before `key`; null when `key` precedes the start. */
  const snapBackward = (key: string): string | null => {
    for (let i = ordered.length - 1; i >= 0; i--) {
      const b = ordered[i]!;
      if (b <= key) return b;
    }
    return null;
  };

  const byBucket = new Map<string, { endBucket: string | null; annotations: CostAnnotation[] }>();
  for (const a of annotations) {
    const startBucket = bucketKey(a.startDate, binning);
    if (startBucket === null) continue;
    // An end before the start is nonsense the API rejects; treated as a moment
    // here so a corrupted row degrades to a point marker rather than vanishing.
    const endDay = a.endDate && a.endDate > a.startDate ? a.endDate : a.startDate;
    const endBucket = bucketKey(endDay, binning) ?? startBucket;
    // No overlap with the drawn window in either direction.
    if (endBucket < first || startBucket > last) continue;

    const markerBucket = snapForward(startBucket < first ? first : startBucket);
    if (markerBucket === null) continue;
    const reach = snapBackward(endBucket > last ? last : endBucket);

    const entry = byBucket.get(markerBucket) ?? { endBucket: null, annotations: [] };
    entry.annotations.push(a);
    if (
      reach !== null &&
      reach > markerBucket &&
      (entry.endBucket === null || reach > entry.endBucket)
    ) {
      entry.endBucket = reach;
    }
    byBucket.set(markerBucket, entry);
  }

  return [...byBucket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, entry], i) => ({
      bucket,
      endBucket: entry.endBucket,
      index: i + 1,
      annotations: [...entry.annotations].sort((x, y) =>
        x.startDate === y.startDate ? x.id.localeCompare(y.id) : x.startDate < y.startDate ? -1 : 1,
      ),
    }));
}

/** `"Jul 5"`, or `"Jul 5 – Jul 12"` for a span. */
export function formatCostAnnotationDates(
  annotation: Pick<CostAnnotation, "startDate" | "endDate">,
): string {
  const day = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const start = day(annotation.startDate);
  if (!annotation.endDate || annotation.endDate <= annotation.startDate) return start;
  return `${start} – ${day(annotation.endDate)}`;
}

/** `"Org-wide"` or `"This report"` — the scope, said out loud in every list. */
export function describeCostAnnotationScope(
  annotation: Pick<CostAnnotation, "costReportId">,
): string {
  return annotation.costReportId === null ? "Org-wide" : "This report";
}

/* ------------------------------------------------------------------ *
 * Turning an explained anomaly into an annotation.
 *
 * The bridge between the two features lives here, next to the annotation
 * types, because everything in it is a statement about the *note* an
 * acknowledgement produces. Both ends import it: the composer to check what it
 * will send, the server to build what it stores. A second derivation of "which
 * day does this note go on" is exactly how a marker ends up explaining the
 * wrong bar.
 * ------------------------------------------------------------------ */

/**
 * The annotation an acknowledgement creates.
 *
 * Three decisions, all deliberate:
 *
 * - **The anomaly's own day**, never today. The note explains a bar that may be
 *   a month old, and dating it to when somebody got round to writing it would
 *   put the marker nowhere near the money.
 * - **A moment, not a span.** An anomaly is one UTC day by construction.
 * - **Org-wide** (`costReportId: null`), which is the whole point: "we migrated
 *   the fleet" explains that day's step on every chart that draws it, not just
 *   on whichever report somebody happened to be looking at.
 */
export function costAnomalyAnnotationInput(
  anomaly: Pick<CostAnomaly, "day">,
  explanation: string,
): CostAnnotationInput {
  return {
    startDate: anomaly.day,
    endDate: null,
    text: explanation.trim(),
    costReportId: null,
  };
}

/**
 * Why this explanation cannot be saved, or null when it can.
 *
 * Delegates to {@link costAnnotationInputError} against the note that would
 * actually be created, so the composer refuses exactly what the API refuses —
 * including the 500-character ceiling, which is a fact about annotations rather
 * than about anomalies and should only ever be stated once.
 */
export function costAnomalyExplanationError(
  anomaly: Pick<CostAnomaly, "day">,
  explanation: string,
): string | null {
  return costAnnotationInputError(costAnomalyAnnotationInput(anomaly, explanation));
}

/**
 * The half-written sentence the composer opens with.
 *
 * Prefill is the difference between this feature being used and not: facing an
 * empty box, people write nothing; facing "Amazon EC2 spend up 173% — ", they
 * finish the sentence. It restates what the row already knows so the *note* is
 * self-contained on a chart, where the reader has no anomaly next to it — the
 * date is not repeated, because the marker's position is the date.
 */
export function costAnomalyExplanationPrefill(
  anomaly: Pick<CostAnomaly, "kind" | "dimensionKey" | "actualCents" | "baselineCents">,
): string {
  const delta = costAnomalyDeltaPercent(anomaly);
  if (anomaly.kind === "new_source" || delta === null) {
    return `${anomaly.dimensionKey} started spending — `;
  }
  return `${anomaly.dimensionKey} spend ${delta} — `;
}

/**
 * The annotations a chart should draw (`GET /cost-annotations`, permission
 * `costs:read`).
 *
 * With a `reportId` this is "what a chart for that report shows": the org-wide
 * notes plus that report's own. Without one it is every annotation in the org,
 * which is what a management list wants.
 */
export async function listCostAnnotations(
  api: CloudFetch,
  orgId: string,
  reportId?: string,
): Promise<CostAnnotation[]> {
  const qs = reportId ? `?reportId=${encodeURIComponent(reportId)}` : "";
  const res = await api.org<{ annotations: CostAnnotation[] }>(orgId, `/cost-annotations${qs}`);
  return res?.annotations ?? [];
}
