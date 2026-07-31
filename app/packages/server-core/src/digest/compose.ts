/**
 * Weekly digest composition — pure functions only. Everything here takes data
 * in and returns data out, so the whole module is unit-testable without a
 * database, a clock, or a network. Gathering the inputs and delivering the
 * result live in `./weekly.ts`.
 *
 * The digest is deterministic by design: a well-formatted summary of real
 * numbers ships now; an AI-written narrative is a follow-up, not a dependency.
 */

/** One grouped daily cost series, shaped like ClickHouse's `queryCosts` output. */
export interface DigestCostGroup {
  /** Group key (provider id or service name); "" for ungrouped rows. */
  key: string;
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
}

/** The two adjacent Monday-to-Sunday weeks a digest compares. All ISO days, UTC. */
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
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MOVERS = 3;
/** Don't call something a "mover" over pocket change. */
const MIN_MOVER_DELTA = 0.01;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The digest window as of `now`: the last complete Monday-to-Sunday week
 * (UTC), and the week before it. On a Monday this is the week that just
 * ended — which is exactly when the scheduler fires.
 */
export function digestWindow(now: Date): DigestWindow {
  // getUTCDay: Sunday 0 … Saturday 6. Days since the most recent Monday:
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const thisMonday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday),
  );
  const weekStartDate = new Date(thisMonday.getTime() - 7 * DAY_MS);
  return {
    weekStart: isoDay(weekStartDate),
    weekEnd: isoDay(new Date(thisMonday.getTime() - DAY_MS)),
    prevWeekStart: isoDay(new Date(weekStartDate.getTime() - 7 * DAY_MS)),
    prevWeekEnd: isoDay(new Date(weekStartDate.getTime() - DAY_MS)),
  };
}

/** Hour of Monday (UTC) after which the digest for the just-ended week is due. */
export const DIGEST_SEND_HOUR_UTC = 7;

/**
 * Whether a digest covering `window` is due at `now`. True from Monday
 * 07:00 UTC after the reported week onward — so a poller that was down on
 * Monday still sends on Tuesday, and the conditional-UPDATE claim in
 * `weekly.ts` keeps it to once per week regardless.
 */
export function isDigestDue(now: Date, window: DigestWindow): boolean {
  const monday = new Date(`${window.weekEnd}T00:00:00.000Z`).getTime() + DAY_MS;
  return now.getTime() >= monday + DIGEST_SEND_HOUR_UTC * 60 * 60 * 1000;
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
  };
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
 * The digest body as plain-text lines, shared by both transports. Slack wraps
 * headline lines in mrkdwn bold; Teams keeps them plain (its card escaper
 * would show literal asterisks otherwise).
 *
 * `bold` wraps a fragment in the transport's bold markup, or returns it
 * unchanged for plain text.
 */
export function digestLines(digest: WeeklyDigest, bold: (s: string) => string): string[] {
  const lines: string[] = [];

  if (digest.totals.length === 0) {
    lines.push(
      "No cost data was recorded for last week. Connect a provider account with cost collection to see spend here.",
    );
  } else {
    for (const t of digest.totals) {
      const suffix = digest.totals.length > 1 ? ` (${t.currency})` : "";
      lines.push(
        `${bold(`Spend${suffix}: ${formatAmount(t.currentAmount, t.currency)}`)} — ${formatDelta(t.delta, t.currency)} (${formatPct(t.deltaPct)}) vs ${formatAmount(t.previousAmount, t.currency)} the week before`,
      );
    }
    if (digest.topProviderMovers.length > 0) {
      lines.push("");
      lines.push(bold("Top movers by provider"));
      for (const m of digest.topProviderMovers) lines.push(`• ${moverLine(m)}`);
    }
    if (digest.topServiceMovers.length > 0) {
      lines.push("");
      lines.push(bold("Top movers by service"));
      for (const m of digest.topServiceMovers) lines.push(`• ${moverLine(m)}`);
    }
  }

  lines.push("");
  lines.push(
    `${bold("Reliability")}: ${pluralize(digest.syncIncidentsOpened, "sync incident")} opened`,
  );
  lines.push(
    `${bold("Resources")}: ${digest.resourcesAdded} added, ${digest.resourcesRemoved} removed`,
  );
  return lines;
}

/** Slack mrkdwn body. `slack.ts` escapes `&<>` and leaves `*bold*` intact. */
export function formatDigestSlackBody(digest: WeeklyDigest): string {
  return digestLines(digest, (s) => `*${s}*`).join("\n");
}

/** Teams plain-text body — the Adaptive Card escaper strips markdown anyway. */
export function formatDigestTeamsBody(digest: WeeklyDigest): string {
  return digestLines(digest, (s) => s).join("\n\n");
}
