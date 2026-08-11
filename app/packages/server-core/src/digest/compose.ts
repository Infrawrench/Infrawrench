import type { CostConversion } from "@infrawrench/client-core";
/**
 * Weekly digest composition — pure functions only. Everything here takes data
 * in and returns data out, so the whole module is unit-testable without a
 * database, a clock, or a network. Gathering the inputs and delivering the
 * result live in `./weekly.ts`.
 *
 * The digest is deterministic by design and stays LLM-free: the AI narrative
 * (`./narrative.ts`) is a separate step that takes the *composed* digest as
 * input and is threaded back in here only as an opaque paragraph of text, so a
 * missing or failed narrative costs nothing but the paragraph.
 */

/** One grouped daily cost series, shaped like ClickHouse's `queryCosts` output. */
export interface DigestCostGroup {
  /** Group key (provider id or service name); "" for ungrouped rows. */
  key: string;
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
}

/**
 * The two adjacent Monday-to-Sunday weeks a digest compares. All ISO days in
 * the org's local calendar (see {@link digestWindow}).
 */
export interface DigestWindow {
  /** Monday of the reported (last complete) week. */
  weekStart: string;
  /** Sunday of the reported week. */
  weekEnd: string;
  /** Monday of the week before, for the comparison. */
  prevWeekStart: string;
  /** Sunday of the week before. */
  prevWeekEnd: string;
}

/**
 * What last week's resource churn does to the *forward-looking* bill, from
 * the plugins' `estimateCost`.
 *
 * This is a different question from the spend totals above, and the digest
 * says so: those are what the providers billed for days that have already
 * happened, while this is the run-rate the week's creates and deletes leave
 * behind. A cluster spun up last Sunday barely shows in last week's spend and
 * is most of next month's.
 */
export interface DigestProjection {
  currency: string;
  /** Monthly run-rate of the resources created during the week. */
  addedMonthly: number;
  /** Monthly run-rate of the resources deleted during the week. */
  removedMonthly: number;
  /**
   * Resources in the week's churn that could not be priced at all — no
   * `estimateCost` for their plugin, or no rate for their type. Surfaced so
   * a small number is never read as "nothing else changed".
   */
  unpricedCount: number;
  /** True when the churn was too large to price in full; the figure is a floor. */
  truncated: boolean;
}

export interface DigestInput {
  window: DigestWindow;
  /** Daily costs from `prevWeekStart` through `weekEnd`, grouped by provider. */
  byProvider: DigestCostGroup[];
  /** Daily costs from `prevWeekStart` through `weekEnd`, grouped by service. */
  byService: DigestCostGroup[];
  /** Sync incidents opened during the reported week (from `paging_incidents`). */
  syncIncidentsOpened: number;
  /** Resources first seen during the reported week. */
  resourcesAdded: number;
  /** Resources soft-deleted during the reported week. */
  resourcesRemoved: number;
  /**
   * Provider status-page incidents active during the reported week on
   * providers the org holds accounts with (from `provider_status_incidents`).
   */
  providerIncidents: number;
  /**
   * Deadlines currently inside the org's expiry lead time — expiring certs,
   * domains, tokens and keys past their rotation budget (from the expiry
   * feed, severity expired/critical/warning/upcoming).
   */
  expiringSoon: number;
  /** Critical security posture findings currently open (from the posture feed). */
  postureCritical: number;
  /** High-severity posture findings currently open. */
  postureHigh: number;
  /**
   * Provider quotas at or heading for their limit (from the quota feed, the
   * same `alertableQuotas` predicate the quota alert pass fires on).
   */
  quotasAtRisk: number;
  /**
   * Set when the spend figures above were converted into the org's display
   * currency. Every renderer turns this into a caveat line — a converted total
   * that does not say so is worse than the several totals it replaced.
   */
  conversion?: CostConversion;
  /**
   * Projected monthly change from the week's churn. Null when no resource
   * changed hands, or when nothing that did could be priced.
   */
  projection?: DigestProjection | null;
}

export interface DigestTotal {
  currency: string;
  currentAmount: number;
  previousAmount: number;
  delta: number;
  /** Percentage change vs last week; null when last week was zero. */
  deltaPct: number | null;
}

export interface DigestMover {
  key: string;
  currency: string;
  currentAmount: number;
  previousAmount: number;
  delta: number;
}

export interface WeeklyDigest {
  window: DigestWindow;
  /** One total per currency seen in the two weeks, largest current spend first. */
  totals: DigestTotal[];
  /** Biggest absolute week-over-week changes by provider, in the primary currency. */
  topProviderMovers: DigestMover[];
  /** Biggest absolute week-over-week changes by service, in the primary currency. */
  topServiceMovers: DigestMover[];
  syncIncidentsOpened: number;
  resourcesAdded: number;
  resourcesRemoved: number;
  /** Provider status-page incidents that overlapped the org's providers. */
  providerIncidents: number;
  /** Deadlines currently inside the org's expiry lead time. */
  expiringSoon: number;
  /** Critical security posture findings currently open. */
  postureCritical: number;
  /** High-severity posture findings currently open. */
  postureHigh: number;
  /** Provider quotas at or heading for their limit. */
  quotasAtRisk: number;
  /** Projected monthly change from the week's churn, when anything priced. */
  projection: DigestProjection | null;
}

const MAX_MOVERS = 3;
/** Don't call something a "mover" over pocket change. */
const MIN_MOVER_DELTA = 0.01;

// --- Schedule and week-boundary math ---
//
// Everything below works on *civil* values — a `YYYY-MM-DD` date plus an
// integer local hour — and never on instants. That is the whole trick, and it
// is what makes DST structurally irrelevant rather than something to patch
// around:
//
//   * The window is a run of calendar dates. Day arithmetic happens on the
//     Y/M/D triple, so a 23- or 25-hour local day cannot shift it — a week is
//     always seven dated days, whatever their length in milliseconds.
//   * "Is it due" compares (localDate, localHour) against (dueDate, sendHour)
//     lexicographically. On a spring-forward day the local hour skips 02:00
//     entirely, so a `sendHour` of 2 is reached the moment the clock reads 03
//     — late, never skipped. On a fall-back day the hour repeats, and the
//     `last_sent_week_start` claim absorbs the duplicate.
//   * `last_sent_week_start` is the window's own `weekStart`, so the claim key,
//     the composed window, and the due check are all derived from one local
//     civil date and cannot disagree.
//
// Zones with non-hour offsets (Asia/Kolkata, +05:30) and zones across the date
// line (Pacific/Kiritimati at +14, Pacific/Niue at −11) need no special case:
// `Intl` reports the local civil date directly, and every later step is
// calendar arithmetic on that date.

/** ISO day of week: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A per-org send schedule. Defaults reproduce the original Monday 07:00 UTC. */
export interface DigestSchedule {
  /** IANA zone, e.g. `America/New_York`. */
  timezone: string;
  sendDay: IsoWeekday;
  /** Local hour, 0–23. */
  sendHour: number;
}

export const DEFAULT_DIGEST_SCHEDULE: DigestSchedule = {
  timezone: "UTC",
  sendDay: 1,
  sendHour: 7,
};

/**
 * Whether `tz` is a zone this runtime knows. `Intl.DateTimeFormat` throws a
 * `RangeError` on an unknown identifier, which is the only check that stays
 * correct as the tz database grows — an allowlist would go stale.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const ISO_DOW: Record<string, IsoWeekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** The civil (wall-clock) date, hour, and weekday in `timeZone` at `now`. */
export interface CivilMoment {
  /** ISO `YYYY-MM-DD` as the local calendar reads it. */
  date: string;
  /** Local hour, 0–23. */
  hour: number;
  isoDow: IsoWeekday;
}

/**
 * Read the wall clock in `timeZone`. Uses `Intl.DateTimeFormat` rather than a
 * timezone library — the platform already ships the tz database, and the repo
 * has no date dependency to reuse. `hourCycle: "h23"` avoids the "24" that
 * `hour12: false` reports at midnight in some ICU versions.
 *
 * An unknown zone falls back to UTC rather than throwing: this runs inside the
 * poller, and a bad row must not stop every other org's digest. The API rejects
 * unknown zones on the way in, so this is a backstop, not the guard.
 */
export function civilMoment(now: Date, timeZone: string): CivilMoment {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
    }).formatToParts(now);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number.parseInt(get("hour"), 10) % 24,
    isoDow: ISO_DOW[get("weekday")] ?? 1,
  };
}

/** Shift an ISO calendar date by whole days. Pure Y/M/D arithmetic — no DST. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  // Date.UTC is used only as a civil-calendar calculator here (leap years,
  // month lengths). No instant is derived from it, so no offset applies.
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The digest window as of `now`: the last complete Monday-to-Sunday week in
 * `timeZone`, and the week before it. On the org's Monday this is the week
 * that just ended — which is when the default schedule fires.
 *
 * The window is always Monday-to-Sunday regardless of `sendDay`: the send day
 * chooses *when the message arrives*, not what a week is. An org that reads its
 * digest on Wednesday still gets a Mon–Sun recap, which is the unit its cost
 * dashboards and everyone else's calendar agree on.
 */
export function digestWindow(now: Date, timeZone = "UTC"): DigestWindow {
  const { date, isoDow } = civilMoment(now, timeZone);
  const thisMonday = addDays(date, -(isoDow - 1));
  const weekStart = addDays(thisMonday, -7);
  return {
    weekStart,
    weekEnd: addDays(thisMonday, -1),
    prevWeekStart: addDays(weekStart, -7),
    prevWeekEnd: addDays(weekStart, -1),
  };
}

/**
 * The local calendar date the digest for `window` is due on: the first
 * occurrence of `sendDay` on or after the Monday that follows the window.
 * `sendDay: 1` is that Monday itself; `sendDay: 7` is the Sunday six days later.
 */
export function digestDueDate(window: DigestWindow, sendDay: IsoWeekday): string {
  const mondayAfter = addDays(window.weekEnd, 1);
  return addDays(mondayAfter, sendDay - 1);
}

/**
 * Whether a digest covering `window` is due at `now`. True from the org's
 * chosen local day and hour onward — so a poller that was down at the send
 * time still sends later that week, and the conditional-UPDATE claim in
 * `weekly.ts` keeps it to once per week regardless.
 */
export function isDigestDue(
  now: Date,
  window: DigestWindow,
  schedule: DigestSchedule = DEFAULT_DIGEST_SCHEDULE,
): boolean {
  const dueDate = digestDueDate(window, schedule.sendDay);
  const { date, hour } = civilMoment(now, schedule.timezone);
  if (date > dueDate) return true;
  if (date < dueDate) return false;
  return hour >= schedule.sendHour;
}

/** Sum a group's points that fall inside an inclusive ISO-day range. */
function sumRange(group: DigestCostGroup, from: string, to: string): number {
  let total = 0;
  for (const p of group.points) {
    if (p.bucket >= from && p.bucket <= to) total += p.amount;
  }
  return total;
}

function computeTotals(groups: DigestCostGroup[], window: DigestWindow): DigestTotal[] {
  const byCurrency = new Map<string, { current: number; previous: number }>();
  for (const g of groups) {
    const entry = byCurrency.get(g.currency) ?? { current: 0, previous: 0 };
    entry.current += sumRange(g, window.weekStart, window.weekEnd);
    entry.previous += sumRange(g, window.prevWeekStart, window.prevWeekEnd);
    byCurrency.set(g.currency, entry);
  }
  const totals: DigestTotal[] = [...byCurrency.entries()]
    .filter(([, v]) => v.current !== 0 || v.previous !== 0)
    .map(([currency, v]) => ({
      currency,
      currentAmount: v.current,
      previousAmount: v.previous,
      delta: v.current - v.previous,
      deltaPct: v.previous === 0 ? null : ((v.current - v.previous) / v.previous) * 100,
    }));
  totals.sort((a, b) => b.currentAmount - a.currentAmount);
  return totals;
}

function computeMovers(
  groups: DigestCostGroup[],
  window: DigestWindow,
  currency: string,
): DigestMover[] {
  const movers: DigestMover[] = [];
  for (const g of groups) {
    if (g.currency !== currency || g.key === "") continue;
    const current = sumRange(g, window.weekStart, window.weekEnd);
    const previous = sumRange(g, window.prevWeekStart, window.prevWeekEnd);
    const delta = current - previous;
    if (Math.abs(delta) < MIN_MOVER_DELTA) continue;
    movers.push({ key: g.key, currency, currentAmount: current, previousAmount: previous, delta });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return movers.slice(0, MAX_MOVERS);
}

/** Assemble the structured digest from raw inputs. Pure. */
export function composeWeeklyDigest(input: DigestInput): WeeklyDigest {
  const totals = computeTotals(input.byProvider, input.window);
  // Movers are reported in the org's dominant currency; a mixed-currency org
  // still sees every currency in the totals line.
  const primaryCurrency = totals[0]?.currency ?? null;
  return {
    window: input.window,
    totals,
    topProviderMovers: primaryCurrency
      ? computeMovers(input.byProvider, input.window, primaryCurrency)
      : [],
    topServiceMovers: primaryCurrency
      ? computeMovers(input.byService, input.window, primaryCurrency)
      : [],
    syncIncidentsOpened: input.syncIncidentsOpened,
    resourcesAdded: input.resourcesAdded,
    resourcesRemoved: input.resourcesRemoved,
    providerIncidents: input.providerIncidents,
    expiringSoon: input.expiringSoon,
    postureCritical: input.postureCritical,
    postureHigh: input.postureHigh,
    quotasAtRisk: input.quotasAtRisk,
    projection: normalizeProjection(input.projection),
    ...(input.conversion ? { conversion: input.conversion } : {}),
  };
}

/**
 * Drop a projection that has nothing to say. A week where every changed
 * resource was unpriceable produces zeroes on both sides, and a
 * "Projected spend: no change" line would claim knowledge the estimates do
 * not have.
 */
function normalizeProjection(
  projection: DigestProjection | null | undefined,
): DigestProjection | null {
  if (!projection) return null;
  if (projection.addedMonthly === 0 && projection.removedMonthly === 0) return null;
  return projection;
}

/**
 * The one-line caveat under a converted spend figure, or null when nothing was
 * converted.
 *
 * Two facts, in the order they matter: that the number is a conversion at rates
 * the org itself stated (not a market rate we fetched), and which currencies
 * are still sitting outside it because no rate covers them.
 */
export function conversionCaveat(conversion: CostConversion | undefined): string | null {
  if (!conversion) return null;
  const parts: string[] = [];
  if (conversion.converted.length > 0) {
    const codes = conversion.converted.map((c) => c.currency).join(", ");
    parts.push(
      `${codes} converted to ${conversion.displayCurrency} at your organization's stated rates`,
    );
  }
  if (conversion.unconverted.length > 0) {
    parts.push(
      `${conversion.unconverted.join(", ")} shown unconverted — no exchange rate is configured`,
    );
  }
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}

// --- Formatting ---

export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `+12.3%` / `−4.5%`; "new" when there was no spend last week. */
function formatPct(deltaPct: number | null): string {
  if (deltaPct === null) return "new";
  const sign = deltaPct >= 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(1)}%`;
}

function formatDelta(delta: number, currency: string): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${formatAmount(delta, currency)}`;
}

function moverLine(m: DigestMover): string {
  return `${m.key}: ${formatAmount(m.currentAmount, m.currency)} (${formatDelta(m.delta, m.currency)} vs last week)`;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The digest title, e.g. `Weekly digest · Jul 21 – Jul 27`. */
export function digestTitle(digest: WeeklyDigest): string {
  const fmt = (day: string) =>
    new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `Weekly digest · ${fmt(digest.window.weekStart)} – ${fmt(digest.window.weekEnd)}`;
}

/**
 * One run of text within a digest line, and whether the transport should
 * emphasise it.
 *
 * The body is modelled as segments rather than as pre-marked-up strings for one
 * reason: a renderer has to be able to tell *its own* markup apart from the
 * text it is rendering, and it cannot do that once both are in the same string.
 * The AI narrative is arbitrary model output that goes into the body verbatim,
 * so a scheme that recovered the markup by pattern-matching the rendered line
 * (splitting on `<strong>`, say) would hand the model a way to smuggle markup
 * past the escaper. Here the structure is never destroyed in the first place:
 * `text` is always literal text, and only `bold: true` asks for markup.
 */
export interface DigestSegment {
  text: string;
  bold: boolean;
}

/** A line of the digest body. An empty array is a blank line. */
export type DigestLine = DigestSegment[];

const plain = (text: string): DigestLine => [{ text, bold: false }];
const strong = (text: string): DigestLine => [{ text, bold: true }];
/** A blank separator line. */
const BLANK: DigestLine = [];

/**
 * The digest body as structured lines, shared by every transport. Every
 * renderer builds from this, so the three transports can never drift in what
 * they report — and none of them has to guess which part of a line is markup.
 *
 * `narrative` is the optional AI-written paragraph; it goes above the
 * deterministic content as a single non-bold segment and is strictly additive —
 * omitting it changes nothing else about the message.
 */
export function digestSegments(digest: WeeklyDigest, narrative?: string | null): DigestLine[] {
  const lines: DigestLine[] = [];

  if (narrative) {
    lines.push(plain(narrative));
    lines.push(BLANK);
  }

  if (digest.totals.length === 0) {
    lines.push(
      plain(
        "No cost data was recorded for last week. Connect a provider account with cost collection to see spend here.",
      ),
    );
  } else {
    for (const t of digest.totals) {
      const suffix = digest.totals.length > 1 ? ` (${t.currency})` : "";
      lines.push([
        { text: `Spend${suffix}: ${formatAmount(t.currentAmount, t.currency)}`, bold: true },
        {
          text: ` — ${formatDelta(t.delta, t.currency)} (${formatPct(t.deltaPct)}) vs ${formatAmount(t.previousAmount, t.currency)} the week before`,
          bold: false,
        },
      ]);
    }
    if (digest.topProviderMovers.length > 0) {
      lines.push(BLANK);
      lines.push(strong("Top movers by provider"));
      for (const m of digest.topProviderMovers) lines.push(plain(`• ${moverLine(m)}`));
    }
    if (digest.topServiceMovers.length > 0) {
      lines.push(BLANK);
      lines.push(strong("Top movers by service"));
      for (const m of digest.topServiceMovers) lines.push(plain(`• ${moverLine(m)}`));
    }
  }

  lines.push(BLANK);
  lines.push([
    { text: "Reliability", bold: true },
    { text: `: ${pluralize(digest.syncIncidentsOpened, "sync incident")} opened`, bold: false },
  ]);
  if (digest.providerIncidents > 0) {
    lines.push([
      { text: "Provider incidents", bold: true },
      {
        text: `: ${pluralize(digest.providerIncidents, "upstream incident")} affected your providers`,
        bold: false,
      },
    ]);
  }
  if (digest.expiringSoon > 0) {
    lines.push([
      { text: "Expiring soon", bold: true },
      {
        text: `: ${pluralize(digest.expiringSoon, "deadline")} within your lead time`,
        bold: false,
      },
    ]);
  }
  if (digest.quotasAtRisk > 0) {
    lines.push([
      { text: "Quotas", bold: true },
      {
        text: `: ${pluralize(digest.quotasAtRisk, "provider limit")} at or heading for exhaustion`,
        bold: false,
      },
    ]);
  }
  if (digest.postureCritical + digest.postureHigh > 0) {
    lines.push([
      { text: "Posture", bold: true },
      {
        text: `: ${digest.postureCritical} critical, ${digest.postureHigh} high ${
          digest.postureCritical + digest.postureHigh === 1 ? "finding" : "findings"
        }`,
        bold: false,
      },
    ]);
  }
  lines.push([
    { text: "Resources", bold: true },
    { text: `: ${digest.resourcesAdded} added, ${digest.resourcesRemoved} removed`, bold: false },
  ]);
  const projectionLine = projectionSegments(digest.projection);
  if (projectionLine) lines.push(projectionLine);
  return lines;
}

/**
 * The forward-looking line: what last week's churn does to the monthly bill.
 *
 * Deliberately phrased as a run-rate rather than folded into the spend total
 * above — one is billed history, the other is a projection, and a reader has
 * to be able to tell which they are looking at.
 */
function projectionSegments(projection: DigestProjection | null): DigestLine | null {
  if (!projection) return null;
  const net = projection.addedMonthly - projection.removedMonthly;
  const { currency } = projection;
  const parts: string[] = [];
  if (projection.addedMonthly > 0) {
    parts.push(`${formatAmount(projection.addedMonthly, currency)}/mo added`);
  }
  if (projection.removedMonthly > 0) {
    parts.push(`${formatAmount(projection.removedMonthly, currency)}/mo removed`);
  }
  const caveats: string[] = [];
  if (projection.truncated) caveats.push("at least");
  if (projection.unpricedCount > 0) {
    caveats.push(`${pluralize(projection.unpricedCount, "resource")} could not be priced`);
  }
  const suffix = [
    parts.length > 0 ? ` (${parts.join(", ")})` : "",
    caveats.length > 0 ? ` — ${caveats.join("; ")}` : "",
  ].join("");
  return [
    { text: "Projected spend", bold: true },
    {
      text: `: ${formatDelta(net, currency)}/month from last week's changes${suffix}`,
      bold: false,
    },
  ];
}

/**
 * {@link digestSegments} flattened to plain-text lines. Slack wraps headline
 * fragments in mrkdwn bold; Teams and email text keep them plain (the Teams
 * card escaper would show literal asterisks otherwise).
 *
 * `bold` wraps a fragment in the transport's bold markup, or returns it
 * unchanged for plain text. Only use this for transports whose markup is a
 * plain-string convention; the HTML renderer works off the segments directly,
 * because it has to escape everything the segments did *not* ask to be markup.
 */
export function digestLines(
  digest: WeeklyDigest,
  bold: (s: string) => string,
  narrative?: string | null,
): string[] {
  return digestSegments(digest, narrative).map((line) =>
    line.map((seg) => (seg.bold ? bold(seg.text) : seg.text)).join(""),
  );
}

/**
 * Slack mrkdwn body. `slack.ts` escapes `&<>` in the whole body before it goes
 * up, which is what keeps narrative text from forging a Slack link or a
 * `<!channel>` mention; the `*` this adds survives because mrkdwn has no escape
 * for it. A narrative that contains a stray asterisk can therefore only
 * mis-emphasise its own paragraph — it cannot reach out of the text.
 */
export function formatDigestSlackBody(digest: WeeklyDigest, narrative?: string | null): string {
  return digestLines(digest, (s) => `*${s}*`, narrative).join("\n");
}

/**
 * Teams plain-text body — no markup added here at all, because `msteams.ts`
 * escapes `\ * _ [ ]` on the whole card text. That escaper is also what
 * neutralises card markdown in narrative text; it is applied to the body
 * wholesale, so it cannot be stepped around from in here.
 */
export function formatDigestTeamsBody(digest: WeeklyDigest, narrative?: string | null): string {
  return digestLines(digest, (s) => s, narrative).join("\n\n");
}

// --- Email rendering ---
//
// Email is its own format rather than a reuse of the Slack or Teams body:
// mrkdwn asterisks would show literally, and a mail client needs both a
// plain-text part (for text-only readers and spam scoring) and an HTML one.
// Both are built from the same `digestSegments` output so the three transports
// can never drift in what they report.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The plain-text part: the shared lines, unadorned. */
export function formatDigestEmailText(
  digest: WeeklyDigest,
  narrative?: string | null,
  url?: string | null,
): string {
  const lines = [digestTitle(digest), "", ...digestLines(digest, (s) => s, narrative)];
  if (url) {
    lines.push("");
    lines.push(`View in Infrawrench: ${url}`);
  }
  return lines.join("\n");
}

/**
 * The HTML part. Hand-rolled rather than templated — the markup is a handful
 * of tags and a templating dependency would buy nothing. Styles are inline
 * because mail clients strip `<style>` blocks, and the palette is deliberately
 * neutral so it reads in both light and dark clients.
 *
 * Every character of every segment is escaped, and the only markup in the body
 * is the `<strong>` this function writes around segments that asked for it.
 * That is why the body is built from {@link digestSegments} rather than from
 * the flattened lines: text and markup are never mixed into one string, so
 * there is nothing to un-mix afterwards and no input — model-written narrative
 * included — that can arrive already looking like markup.
 */
export function formatDigestEmailHtml(
  digest: WeeklyDigest,
  narrative?: string | null,
  url?: string | null,
): string {
  const body = digestSegments(digest, narrative)
    .filter((line) => line.length > 0)
    .map((line) => {
      const html = line
        .map((seg) =>
          seg.bold ? `<strong>${escapeHtml(seg.text)}</strong>` : escapeHtml(seg.text),
        )
        .join("");
      const bullet = line[0]?.text.startsWith("•") ?? false;
      return `<p style="margin:0 0 8px;${bullet ? "padding-left:12px;" : ""}">${html}</p>`;
    })
    .join("\n");

  const button = url
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">View in Infrawrench</a></p>`
    : "";

  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;max-width:640px;">`,
    `<h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(digestTitle(digest))}</h1>`,
    body,
    button,
    `</div>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
