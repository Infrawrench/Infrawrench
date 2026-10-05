/**
 * What anomaly feedback does to detection: the evaluator's half.
 *
 * People mark findings `expected` (planned or known) or `unexpected` (a real
 * problem); the write side lives in web `services/cost-anomaly-feedback.ts`.
 * Two things here act on those answers during a detection pass, and both are
 * read once per pass, never per key:
 *
 * 1. **Suppressions set spend aside.** A suppression says "spend in this scope
 *    is expected on these days". On a covered day, detection subtracts the
 *    scope's spend from the day it is judging, and if the finding disappears
 *    the row is stored as suppressed (`suppressed_by_id`) rather than alerted
 *    on. For a suppression whose scope *is* the key being judged (a provider
 *    suppression on the provider breakdown), that is the whole day and needs
 *    no query. For every other scope (an account, a tag, a cost centre, or a
 *    provider seen from the service breakdown) it is one grouped read of the
 *    scope's spend over the covered days, per breakdown. That is what lets a
 *    migration in one account be declared expected without muting the
 *    services it happens to use for everybody else.
 *
 *    The finding is judged twice, not once against a smaller number: the full
 *    day must clear the bar (or nothing is stored at all) and the remainder
 *    must not (or the finding stands, because spend beyond the expected slice
 *    is exactly what somebody wants to hear about). A suppressed finding keeps
 *    the full amounts, so the list shows what was actually spent.
 *
 * 2. **Repeated `expected` verdicts nudge sensitivity.** Per provider or
 *    service, `costAnomalySigmaNudge` (client-core, shared with the tuning
 *    panel's explanation) adds half a σ per expected verdict after the first
 *    within 90 days, capped at +2σ and the global 10σ ceiling, and any
 *    `unexpected` verdict in the window cancels it. Spikes only: a new spend
 *    source has no σ to raise. The org can switch this off
 *    (`feedback_tuning`).
 *
 * Neither ever throws into the evaluator: a failed read degrades to "no
 * suppressions" or "no nudges" for the pass, which is the behaviour that
 * existed before feedback did. Both fail towards alerting, never towards
 * silence.
 */
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  costAnomalyEffectiveSigmas,
  costAnomalySigmaNudge,
  suppressionCoversDay,
  type CostAnomalyRecurrence,
  type CostAnomalySensitivityAdjustment,
  type CostAnomalySuppressionScope,
  type CostFilter,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAnomalies, costAnomalySuppressions } from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { listAllocationRules, listCostCentres } from "./allocation";
import { expandCentreSubtrees, runWithCostVisibility } from "./visibility-context";
import type { SlackMessageButton } from "../slack";
import { appBaseUrl } from "../app-url";

export type AnomalyDimension = "provider" | "service";

/** The columns detection needs from a suppression row. */
export interface EvalSuppression {
  id: string;
  scope: CostAnomalySuppressionScope;
  scopeKey: string;
  tagKey: string | null;
  recurrence: CostAnomalyRecurrence;
  anchorDay: string;
  startsOn: string;
  expiresOn: string;
}

/** Spend set aside on one day for one key, and which suppression said so. */
export interface SetAside {
  /** Currency units. `Infinity` means the whole day (the scope is the key). */
  amount: number;
  suppressionId: string;
}

/** Everything a pass needs from feedback, read once. */
export interface AnomalyFeedbackContext {
  /** `dimension\0key` → σ to judge that key's spikes against. */
  sigmas: Map<string, number>;
  /** `dimension\0key\0currency\0day` → set-aside spend; exact matches use `*` as currency. */
  setAside: Map<string, SetAside>;
}

export const EMPTY_FEEDBACK_CONTEXT: AnomalyFeedbackContext = {
  sigmas: new Map(),
  setAside: new Map(),
};

/**
 * Most scope reads one pass will issue. Each is one grouped ClickHouse read
 * over at most `EVALUATION_DAYS` days; past this the rest are skipped for the
 * pass (and logged), which fails towards alerting.
 */
export const MAX_SLICE_READS_PER_PASS = 40;

const sigmaKey = (dimension: AnomalyDimension, key: string) => `${dimension}\0${key}`;
const asideKey = (dimension: AnomalyDimension, key: string, currency: string, day: string) =>
  `${dimension}\0${key}\0${currency}\0${day}`;

/** The σ to judge one key's spikes against: the org's, unless feedback moved it. */
export function sigmasFor(
  ctx: AnomalyFeedbackContext,
  dimension: AnomalyDimension,
  key: string,
  base: number,
): number {
  return ctx.sigmas.get(sigmaKey(dimension, key)) ?? base;
}

/** What to set aside for (dimension, key, currency, day), or null. */
export function setAsideFor(
  ctx: AnomalyFeedbackContext,
  dimension: AnomalyDimension,
  key: string,
  currency: string,
  day: string,
): SetAside | null {
  return (
    ctx.setAside.get(asideKey(dimension, key, "*", day)) ??
    ctx.setAside.get(asideKey(dimension, key, currency, day)) ??
    null
  );
}

/** Verdict counts per key, as the sensitivity read returns them. */
export interface VerdictCounts {
  dimension: AnomalyDimension;
  dimensionKey: string;
  expected: number;
  unexpected: number;
}

/**
 * One sentence on why a key's σ is where it is. English, for the API, the CLI
 * and MCP; the web and desktop panel compose their own translated sentence
 * from the same counts.
 */
export function sensitivityExplanation(c: VerdictCounts, base: number, sigmas: number): string {
  const days = COST_ANOMALY_FEEDBACK_LIMITS.sensitivityWindowDays;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (c.unexpected > 0) {
    return (
      `Held at ${base}σ: ${plural(c.unexpected, "anomaly")} on ${c.dimensionKey} ` +
      `in the last ${days} days ${c.unexpected === 1 ? "was" : "were"} marked unexpected.`
    );
  }
  if (sigmas <= base) {
    return (
      `Unchanged at ${base}σ: ${plural(c.expected, "expected verdict")} in the last ${days} ` +
      `days; sensitivity moves from the second one.`
    );
  }
  return (
    `Raised from ${base}σ to ${sigmas}σ: ${plural(c.expected, "anomaly")} on ` +
    `${c.dimensionKey} in the last ${days} days ${c.expected === 1 ? "was" : "were"} marked expected.`
  );
}

/** Turn verdict counts into the per-key adjustments the API and evaluator use. */
export function buildSensitivityAdjustments(
  counts: readonly VerdictCounts[],
  baseSigmas: number,
): CostAnomalySensitivityAdjustment[] {
  return counts
    .map((c) => {
      const sigmas = costAnomalyEffectiveSigmas(baseSigmas, c.expected, c.unexpected);
      return {
        dimension: c.dimension,
        dimensionKey: c.dimensionKey,
        baseSigmas,
        sigmas,
        expectedCount: c.expected,
        unexpectedCount: c.unexpected,
        explanation: sensitivityExplanation(c, baseSigmas, sigmas),
      };
    })
    .sort((a, b) => b.sigmas - a.sigmas || a.dimensionKey.localeCompare(b.dimensionKey));
}

/** Verdicts per key within the sensitivity window. */
export async function readVerdictCounts(
  organizationId: string,
  now: Date,
): Promise<VerdictCounts[]> {
  const since = new Date(
    now.getTime() - COST_ANOMALY_FEEDBACK_LIMITS.sensitivityWindowDays * 86_400_000,
  );
  const rows = await db
    .select({
      dimension: costAnomalies.dimension,
      dimensionKey: costAnomalies.dimensionKey,
      expected: sql<number>`count(*) filter (where ${costAnomalies.feedbackVerdict} = 'expected')`,
      unexpected: sql<number>`count(*) filter (where ${costAnomalies.feedbackVerdict} = 'unexpected')`,
    })
    .from(costAnomalies)
    .where(
      and(
        eq(costAnomalies.organizationId, organizationId),
        isNotNull(costAnomalies.feedbackVerdict),
        gte(costAnomalies.feedbackAt, since),
      ),
    )
    .groupBy(costAnomalies.dimension, costAnomalies.dimensionKey);
  return rows.map((r) => ({
    dimension: r.dimension,
    dimensionKey: r.dimensionKey,
    expected: Number(r.expected),
    unexpected: Number(r.unexpected),
  }));
}

/** The σ map a pass judges with, from verdict counts. Only moved keys appear. */
export function sigmaMap(
  counts: readonly VerdictCounts[],
  baseSigmas: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of counts) {
    if (costAnomalySigmaNudge(c.expected, c.unexpected) <= 0) continue;
    out.set(
      sigmaKey(c.dimension, c.dimensionKey),
      costAnomalyEffectiveSigmas(baseSigmas, c.expected, c.unexpected),
    );
  }
  return out;
}

/** Suppressions whose window reaches any of `days`. */
export async function readEvalSuppressions(
  organizationId: string,
  days: readonly string[],
): Promise<EvalSuppression[]> {
  const oldest = days[0];
  const newest = days[days.length - 1];
  if (!oldest || !newest) return [];
  const rows = await db
    .select({
      id: costAnomalySuppressions.id,
      scope: costAnomalySuppressions.scope,
      scopeKey: costAnomalySuppressions.scopeKey,
      tagKey: costAnomalySuppressions.tagKey,
      recurrence: costAnomalySuppressions.recurrence,
      anchorDay: costAnomalySuppressions.anchorDay,
      startsOn: costAnomalySuppressions.startsOn,
      expiresOn: costAnomalySuppressions.expiresOn,
    })
    .from(costAnomalySuppressions)
    .where(
      and(
        eq(costAnomalySuppressions.organizationId, organizationId),
        gte(costAnomalySuppressions.expiresOn, oldest),
        lte(costAnomalySuppressions.startsOn, newest),
      ),
    )
    .orderBy(costAnomalySuppressions.createdAt);
  return rows;
}

/** One read a pass must make to learn a scope's spend. */
export interface SliceRead {
  suppression: EvalSuppression;
  dimension: AnomalyDimension;
  /** The covered days among the ones being judged, oldest first. */
  days: string[];
}

/**
 * Split a pass's suppressions into what can be set aside without reading
 * anything (the scope is the breakdown itself) and the reads the rest need.
 * Pure, so the coverage and the read plan are tested without a database.
 */
export function planSetAside(
  suppressions: readonly EvalSuppression[],
  days: readonly string[],
): { exact: Map<string, SetAside>; reads: SliceRead[] } {
  const exact = new Map<string, SetAside>();
  const reads: SliceRead[] = [];
  for (const s of suppressions) {
    const covered = days.filter((d) => suppressionCoversDay(s, d));
    if (covered.length === 0) continue;
    for (const dimension of ["provider", "service"] as const) {
      if (s.scope === dimension) {
        for (const day of covered) {
          const k = asideKey(dimension, s.scopeKey, "*", day);
          if (!exact.has(k)) exact.set(k, { amount: Infinity, suppressionId: s.id });
        }
      } else {
        reads.push({ suppression: s, dimension, days: covered });
      }
    }
  }
  return { exact, reads };
}

/** The cost filter a non-centre scope compiles to. */
export function scopeFilter(s: EvalSuppression): CostFilter[] {
  switch (s.scope) {
    case "provider":
    case "service":
    case "account":
      return [{ dimension: s.scope, op: "in", values: [s.scopeKey] }];
    case "tag":
      return [{ dimension: "tag", op: "in", values: [s.scopeKey], tagKey: s.tagKey ?? "" }];
    case "cost_centre":
      return [];
  }
}

/**
 * Run `fn` with reads narrowed to one cost centre (and its sub-centres), by
 * reusing the cost visibility layer, which is exactly "rows the allocation
 * rules give to these centres". A centre that no longer exists compiles to a
 * layer that matches nothing, so its suppression sets nothing aside.
 */
async function withinCostCentre<T>(
  organizationId: string,
  centreId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [centres, rules] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
  ]);
  const live = new Set(centres.map((c) => c.id));
  const expanded = expandCentreSubtrees([centreId], centres);
  return runWithCostVisibility(
    {
      organizationId,
      restricted: true,
      userId: null,
      layers: [
        {
          source: {
            kind: "member",
            label: null,
            costCentreIds: [centreId],
            accountIds: [],
            savedFilterId: null,
          },
          accountIds: [],
          costCentreIds: expanded,
          rules: rules.flatMap((r) =>
            live.has(r.costCentreId) ? [{ costCentreId: r.costCentreId, match: r.match }] : [],
          ),
          filters: null,
          unresolvable: expanded.length === 0,
        },
      ],
    },
    fn,
  );
}

/** Read one scope's spend per key for the covered days, into `into`. */
async function readSlice(
  organizationId: string,
  read: SliceRead,
  into: Map<string, SetAside>,
): Promise<void> {
  const from = read.days[0];
  const to = read.days[read.days.length - 1];
  if (!from || !to) return;
  const s = read.suppression;
  const run = () =>
    queryCosts(organizationId, {
      from,
      to,
      binning: "daily",
      groupBy: read.dimension,
      filters: scopeFilter(s),
    });
  const groups =
    s.scope === "cost_centre"
      ? await withinCostCentre(organizationId, s.scopeKey, run)
      : await run();
  const covered = new Set(read.days);
  for (const group of groups) {
    if (!group.key) continue;
    for (const p of group.points) {
      if (!covered.has(p.bucket) || !(p.amount > 0)) continue;
      const k = asideKey(read.dimension, group.key, group.currency, p.bucket);
      const prior = into.get(k);
      // Two scopes covering the same key and day add up; the first one to
      // claim it is the one the row names.
      into.set(
        k,
        prior
          ? { amount: prior.amount + p.amount, suppressionId: prior.suppressionId }
          : { amount: p.amount, suppressionId: s.id },
      );
    }
  }
}

/**
 * Everything one pass needs from feedback. Never throws; each half degrades
 * to empty on its own.
 */
export async function loadAnomalyFeedbackContext(
  organizationId: string,
  days: readonly string[],
  opts: { baseSigmas: number; feedbackTuning: boolean; now: Date },
): Promise<AnomalyFeedbackContext> {
  let sigmas = new Map<string, number>();
  if (opts.feedbackTuning) {
    try {
      sigmas = sigmaMap(await readVerdictCounts(organizationId, opts.now), opts.baseSigmas);
    } catch (err) {
      console.error(`[anomaly-feedback] verdict read failed for org ${organizationId}:`, err);
    }
  }

  const setAside = new Map<string, SetAside>();
  try {
    const suppressions = await readEvalSuppressions(organizationId, days);
    const { exact, reads } = planSetAside(suppressions, days);
    for (const [k, v] of exact) setAside.set(k, v);
    if (reads.length > MAX_SLICE_READS_PER_PASS) {
      console.error(
        `[anomaly-feedback] org ${organizationId} has ${reads.length} scope reads due; ` +
          `only the oldest ${MAX_SLICE_READS_PER_PASS} suppressions apply this pass`,
      );
    }
    for (const read of reads.slice(0, MAX_SLICE_READS_PER_PASS)) {
      try {
        await readSlice(organizationId, read, setAside);
      } catch (err) {
        console.error(
          `[anomaly-feedback] scope read for suppression ${read.suppression.id} failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(`[anomaly-feedback] suppression read failed for org ${organizationId}:`, err);
  }

  return { sigmas, setAside };
}

/* ------------------------------------------------------------------ *
 * Slack buttons.
 *
 * Anomaly alerts carry Expected / Unexpected buttons. The value names the org
 * and the anomaly and nothing else: it is not a credential. The inbound
 * handler (web `slack-inbound.ts`) honours a click only once the Slack user
 * resolves through `slack_user_links` to a member of that org holding
 * `costs:write`, the same gate as the HTTP route, and the write is scoped to
 * that org, so a forged value matches no row.
 * ------------------------------------------------------------------ */

export const ANOMALY_EXPECTED_ACTION_ID = "infrawrench_anomaly_expected";
export const ANOMALY_UNEXPECTED_ACTION_ID = "infrawrench_anomaly_unexpected";

export interface AnomalyFeedbackButtonValue {
  organizationId: string;
  anomalyId: string;
}

export function anomalyFeedbackButtons(
  organizationId: string,
  anomalyId: string,
): SlackMessageButton[] {
  const value = JSON.stringify({ o: organizationId, a: anomalyId });
  return [
    { text: "Expected", actionId: ANOMALY_EXPECTED_ACTION_ID, value },
    { text: "Unexpected", actionId: ANOMALY_UNEXPECTED_ACTION_ID, value, style: "danger" },
  ];
}

/**
 * The Teams equivalent. Teams cards arrive through one-way incoming webhooks,
 * so a button cannot call back; instead each opens a signed-in confirmation
 * page (web `anomaly-feedback-link.ts`) with the verdict preselected. The GET
 * only renders; the write is a CSRF-guarded POST, because link unfurlers and
 * mail scanners follow URLs. Empty without `APP_URL`, like every deep link.
 */
export function anomalyFeedbackTeamsActions(
  organizationId: string,
  anomalyId: string,
): Array<{ title: string; url: string }> {
  const base = appBaseUrl();
  if (!base) return [];
  const url = (verdict: "expected" | "unexpected") =>
    `${base}/api/anomaly-feedback?o=${encodeURIComponent(organizationId)}` +
    `&a=${encodeURIComponent(anomalyId)}&v=${verdict}`;
  return [
    { title: "Expected", url: url("expected") },
    { title: "Unexpected", url: url("unexpected") },
  ];
}

export function parseAnomalyFeedbackButtonValue(
  raw: string | undefined,
): AnomalyFeedbackButtonValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { o?: unknown; a?: unknown };
    if (typeof parsed.o !== "string" || typeof parsed.a !== "string") return null;
    if (!parsed.o || !parsed.a) return null;
    return { organizationId: parsed.o, anomalyId: parsed.a };
  } catch {
    return null;
  }
}
