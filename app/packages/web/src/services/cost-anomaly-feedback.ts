/**
 * Anomaly feedback, the write side: verdicts on findings, the suppressions an
 * `expected` verdict can create, and the two read models that come out of
 * them (per-key sensitivity, and precision over time).
 *
 * What detection *does* with all of this lives in server-core
 * `cost/anomaly-feedback.ts`; this file only stores and reads it. The rules
 * worth stating once:
 *
 * - **A verdict is a judgement of the detector, not an explanation of the
 *   spend.** It is recorded on the anomaly beside (not instead of) the
 *   acknowledgement. `explain: true` with a note also acknowledges, which is
 *   the same path the Explain action takes and puts the note on charts.
 * - **One suppression per verdict.** Re-sending `expected` with a recurrence
 *   edits the suppression that verdict made rather than adding another;
 *   switching to `unexpected`, or withdrawing the verdict, deletes it (it was
 *   premised on "this was expected"). Suppressions made by hand are never
 *   touched by feedback.
 * - **Cost-scoped callers see none of it**, the same as the anomaly list:
 *   findings are org-wide totals, and the verdicts and suppressions on them
 *   describe those totals.
 */
import { and, asc, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  costAnomalySuppressionInputError,
  defaultSuppressionExpiry,
  type CostAnomaly,
  type CostAnomalyFeedbackInput,
  type CostAnomalyFeedbackReason,
  type CostAnomalyFeedbackResult,
  type CostAnomalyPrecisionPeriod,
  type CostAnomalyPrecisionReport,
  type CostAnomalySensitivity,
  type CostAnomalySuppression,
  type CostAnomalySuppressionInput,
} from "@infrawrench/client-core";
import { getOrgAnomalySettings } from "@infrawrench/server-core/cost/anomaly-settings";
import {
  buildSensitivityAdjustments,
  readVerdictCounts,
} from "@infrawrench/server-core/cost/anomaly-feedback";
import { db } from "../db/client";
import { accounts, costAnomalies, costAnomalySuppressions, costCentres, users } from "../db/schema";
import { withholdOrgWideFindings } from "./cost-visibility-filter";
import { acknowledgeCostAnomaly, getCostAnomalyView } from "./cost-anomalies";

/** A rejected request. `status` is what the route answers with. */
export class CostAnomalyFeedbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

type SuppressionRow = typeof costAnomalySuppressions.$inferSelect;

function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function laterDay(a: string, b: string): string {
  return a > b ? a : b;
}

/* ------------------------------------------------------------------ *
 * Suppressions.
 * ------------------------------------------------------------------ */

/**
 * Rows → API shape, with labels for id-valued scopes and the count of
 * findings each one has suppressed. Three small reads for the whole list,
 * never one per row.
 */
async function toSuppressions(
  organizationId: string,
  rows: SuppressionRow[],
  now = new Date(),
): Promise<CostAnomalySuppression[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const accountIds = rows.filter((r) => r.scope === "account").map((r) => r.scopeKey);
  const centreIds = rows.filter((r) => r.scope === "cost_centre").map((r) => r.scopeKey);
  const creatorIds = [
    ...new Set(rows.flatMap((r) => (r.createdByUserId ? [r.createdByUserId] : []))),
  ];

  const [counts, accountRows, centreRows, creatorRows] = await Promise.all([
    db
      .select({ id: costAnomalies.suppressedById, n: count() })
      .from(costAnomalies)
      .where(
        and(
          eq(costAnomalies.organizationId, organizationId),
          inArray(costAnomalies.suppressedById, ids),
        ),
      )
      .groupBy(costAnomalies.suppressedById),
    accountIds.length > 0
      ? db
          .select({ id: accounts.id, name: accounts.displayName })
          .from(accounts)
          .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)))
      : Promise.resolve([]),
    centreIds.length > 0
      ? db
          .select({ id: costCentres.id, name: costCentres.name })
          .from(costCentres)
          .where(
            and(eq(costCentres.organizationId, organizationId), inArray(costCentres.id, centreIds)),
          )
      : Promise.resolve([]),
    creatorIds.length > 0
      ? db
          .select({
            id: users.id,
            name: sql<string>`coalesce(${users.displayName}, ${users.email})`,
          })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : Promise.resolve([]),
  ]);
  const suppressed = new Map(counts.map((c) => [c.id, Number(c.n)]));
  const labels = new Map<string, string>();
  for (const a of accountRows) labels.set(`account:${a.id}`, a.name);
  for (const c of centreRows) labels.set(`cost_centre:${c.id}`, c.name);
  const creators = new Map(creatorRows.map((u) => [u.id, u.name]));
  const today = todayIso(now);

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    scopeKey: r.scopeKey,
    tagKey: r.tagKey,
    scopeLabel: labels.get(`${r.scope}:${r.scopeKey}`) ?? null,
    recurrence: r.recurrence,
    anchorDay: r.anchorDay,
    startsOn: r.startsOn,
    expiresOn: r.expiresOn,
    reason: r.reason ?? null,
    note: r.note ?? null,
    sourceAnomalyId: r.sourceAnomalyId,
    createdByUserId: r.createdByUserId,
    createdByName: r.createdByUserId ? (creators.get(r.createdByUserId) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    active: r.expiresOn >= today,
    suppressedCount: suppressed.get(r.id) ?? 0,
  }));
}

/** Every suppression of the org, active first, then by expiry. */
export async function listCostAnomalySuppressions(
  organizationId: string,
): Promise<CostAnomalySuppression[]> {
  if (withholdOrgWideFindings(organizationId)) return [];
  const rows = await db
    .select()
    .from(costAnomalySuppressions)
    .where(eq(costAnomalySuppressions.organizationId, organizationId))
    .orderBy(asc(costAnomalySuppressions.expiresOn), asc(costAnomalySuppressions.createdAt))
    .limit(500);
  const out = await toSuppressions(organizationId, rows);
  // Active ones first (soonest expiry first), then expired, most recent first.
  return [...out.filter((s) => s.active), ...out.filter((s) => !s.active).reverse()];
}

export async function getCostAnomalySuppression(
  organizationId: string,
  id: string,
): Promise<CostAnomalySuppression | null> {
  if (withholdOrgWideFindings(organizationId)) return null;
  const [row] = await db
    .select()
    .from(costAnomalySuppressions)
    .where(
      and(
        eq(costAnomalySuppressions.id, id),
        eq(costAnomalySuppressions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [view] = await toSuppressions(organizationId, [row]);
  return view ?? null;
}

/** The validated columns an input writes. Throws on a bad input. */
function suppressionColumns(input: CostAnomalySuppressionInput) {
  const problem = costAnomalySuppressionInputError(input);
  if (problem) throw new CostAnomalyFeedbackError(problem);
  const note = input.note?.trim() || null;
  return {
    scope: input.scope,
    scopeKey: input.scopeKey.trim(),
    tagKey: input.scope === "tag" ? (input.tagKey?.trim() ?? null) : null,
    recurrence: input.recurrence,
    anchorDay: input.anchorDay,
    startsOn: input.startsOn ?? input.anchorDay,
    expiresOn: input.expiresOn,
    reason: input.reason ?? null,
    note,
  };
}

async function assertUnderActiveLimit(organizationId: string, now = new Date()): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(costAnomalySuppressions)
    .where(
      and(
        eq(costAnomalySuppressions.organizationId, organizationId),
        gte(costAnomalySuppressions.expiresOn, todayIso(now)),
      ),
    );
  if (Number(row?.n ?? 0) >= COST_ANOMALY_FEEDBACK_LIMITS.maxActiveSuppressions) {
    throw new CostAnomalyFeedbackError(
      `An organization can hold at most ${COST_ANOMALY_FEEDBACK_LIMITS.maxActiveSuppressions} ` +
        "active suppressions. Delete or shorten one first.",
      409,
    );
  }
}

/** Accounts and cost centres are ids: refuse ones that are not this org's. */
async function assertScopeBelongsToOrg(
  organizationId: string,
  cols: ReturnType<typeof suppressionColumns>,
): Promise<void> {
  if (cols.scope === "account") {
    const [hit] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, cols.scopeKey), eq(accounts.organizationId, organizationId)))
      .limit(1);
    if (!hit) throw new CostAnomalyFeedbackError("That account is not in this organization");
  } else if (cols.scope === "cost_centre") {
    const [hit] = await db
      .select({ id: costCentres.id })
      .from(costCentres)
      .where(and(eq(costCentres.id, cols.scopeKey), eq(costCentres.organizationId, organizationId)))
      .limit(1);
    if (!hit) throw new CostAnomalyFeedbackError("That cost centre is not in this organization");
  }
}

export async function createCostAnomalySuppression(
  organizationId: string,
  input: CostAnomalySuppressionInput,
  userId: string | null,
  sourceAnomalyId: string | null = null,
): Promise<CostAnomalySuppression | null> {
  if (withholdOrgWideFindings(organizationId)) return null;
  const cols = suppressionColumns(input);
  await assertScopeBelongsToOrg(organizationId, cols);
  await assertUnderActiveLimit(organizationId);
  const id = uuidv4();
  await db.insert(costAnomalySuppressions).values({
    id,
    organizationId,
    ...cols,
    sourceAnomalyId,
    createdByUserId: userId,
  });
  return getCostAnomalySuppression(organizationId, id);
}

export async function updateCostAnomalySuppression(
  organizationId: string,
  id: string,
  input: CostAnomalySuppressionInput,
): Promise<CostAnomalySuppression | null> {
  if (withholdOrgWideFindings(organizationId)) return null;
  const cols = suppressionColumns(input);
  await assertScopeBelongsToOrg(organizationId, cols);
  const [row] = await db
    .update(costAnomalySuppressions)
    .set({ ...cols, updatedAt: new Date() })
    .where(
      and(
        eq(costAnomalySuppressions.id, id),
        eq(costAnomalySuppressions.organizationId, organizationId),
      ),
    )
    .returning({ id: costAnomalySuppressions.id });
  if (!row) return null;
  return getCostAnomalySuppression(organizationId, id);
}

/**
 * Delete one. The anomalies it suppressed keep their rows; the foreign key
 * nulls their link, and any whose day detection still re-judges becomes
 * eligible to alert on the next pass.
 */
export async function deleteCostAnomalySuppression(
  organizationId: string,
  id: string,
): Promise<boolean> {
  if (withholdOrgWideFindings(organizationId)) return false;
  const rows = await db
    .delete(costAnomalySuppressions)
    .where(
      and(
        eq(costAnomalySuppressions.id, id),
        eq(costAnomalySuppressions.organizationId, organizationId),
      ),
    )
    .returning({ id: costAnomalySuppressions.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * Verdicts.
 * ------------------------------------------------------------------ */

/**
 * Give a finding a verdict. Null when the anomaly is not this org's. Throws
 * {@link CostAnomalyFeedbackError} for an input that cannot be honoured
 * (a suppression on an `unexpected` verdict, a bad scope or date), and the
 * acknowledgement's own error when `explain` carries an unusable note.
 */
export async function submitCostAnomalyFeedback(
  organizationId: string,
  anomalyId: string,
  input: CostAnomalyFeedbackInput,
  userId: string | null,
  now = new Date(),
): Promise<CostAnomalyFeedbackResult | null> {
  if (withholdOrgWideFindings(organizationId)) return null;
  const [existing] = await db
    .select()
    .from(costAnomalies)
    .where(and(eq(costAnomalies.id, anomalyId), eq(costAnomalies.organizationId, organizationId)))
    .limit(1);
  if (!existing) return null;

  if (input.suppress && input.verdict !== "expected") {
    throw new CostAnomalyFeedbackError("Only an expected anomaly can create a suppression");
  }
  const note = input.note?.trim() || null;
  const reason: CostAnomalyFeedbackReason | null = input.reason ?? null;

  // The suppression this verdict owns, if it still exists.
  let suppressionId: string | null = existing.feedbackSuppressionId;

  if (input.verdict === "expected" && input.suppress) {
    const s = input.suppress;
    const scope = s.scope ?? existing.dimension;
    const scopeKey = s.scopeKey ?? (scope === existing.dimension ? existing.dimensionKey : "");
    // Lifetimes count from the later of the anomaly's day and today: a
    // one-off week anchored to a finding from three weeks ago would already
    // have expired.
    const expiresOn =
      s.expiresOn ??
      laterDay(
        defaultSuppressionExpiry(s.recurrence, existing.day),
        defaultSuppressionExpiry(s.recurrence, todayIso(now)),
      );
    const suppressionInput: CostAnomalySuppressionInput = {
      scope,
      scopeKey,
      ...(s.tagKey !== undefined ? { tagKey: s.tagKey } : {}),
      recurrence: s.recurrence,
      anchorDay: existing.day,
      startsOn: existing.day,
      expiresOn,
      reason,
      note,
    };
    const updated = suppressionId
      ? await updateCostAnomalySuppression(organizationId, suppressionId, suppressionInput)
      : null;
    if (updated) {
      suppressionId = updated.id;
    } else {
      const created = await createCostAnomalySuppression(
        organizationId,
        suppressionInput,
        userId,
        anomalyId,
      );
      suppressionId = created?.id ?? null;
    }
  } else if (input.verdict === "unexpected" && suppressionId) {
    // The suppression was premised on "this was expected"; the verdict that
    // made it has been reversed.
    await deleteCostAnomalySuppression(organizationId, suppressionId);
    suppressionId = null;
  }

  await db
    .update(costAnomalies)
    .set({
      feedbackVerdict: input.verdict,
      feedbackReason: reason,
      feedbackNote: note,
      // Restamped on every save, so "who and when" names whoever gave the
      // current answer rather than whoever first answered.
      feedbackAt: now,
      feedbackByUserId: userId,
      feedbackSuppressionId: suppressionId,
    })
    .where(eq(costAnomalies.id, anomalyId));

  if (input.explain && note) {
    await acknowledgeCostAnomaly(organizationId, anomalyId, note, userId);
  }

  const anomaly = await getCostAnomalyView(organizationId, anomalyId);
  if (!anomaly) return null;
  const suppression = suppressionId
    ? await getCostAnomalySuppression(organizationId, suppressionId)
    : null;
  return { anomaly, suppression };
}

/** Withdraw a verdict, and the suppression it created. Null when not found. */
export async function clearCostAnomalyFeedback(
  organizationId: string,
  anomalyId: string,
): Promise<CostAnomaly | null> {
  if (withholdOrgWideFindings(organizationId)) return null;
  const [existing] = await db
    .select({ suppressionId: costAnomalies.feedbackSuppressionId })
    .from(costAnomalies)
    .where(and(eq(costAnomalies.id, anomalyId), eq(costAnomalies.organizationId, organizationId)))
    .limit(1);
  if (!existing) return null;
  if (existing.suppressionId) {
    await deleteCostAnomalySuppression(organizationId, existing.suppressionId);
  }
  await db
    .update(costAnomalies)
    .set({
      feedbackVerdict: null,
      feedbackReason: null,
      feedbackNote: null,
      feedbackAt: null,
      feedbackByUserId: null,
      feedbackSuppressionId: null,
    })
    .where(eq(costAnomalies.id, anomalyId));
  return getCostAnomalyView(organizationId, anomalyId);
}

/* ------------------------------------------------------------------ *
 * Read models.
 * ------------------------------------------------------------------ */

/** Which keys feedback has moved, and why. */
export async function getCostAnomalySensitivity(
  organizationId: string,
  now = new Date(),
): Promise<CostAnomalySensitivity> {
  const settings = await getOrgAnomalySettings(organizationId);
  const base = settings.sigmas;
  const empty: CostAnomalySensitivity = {
    enabled: settings.feedbackTuning !== false,
    windowDays: COST_ANOMALY_FEEDBACK_LIMITS.sensitivityWindowDays,
    baseSigmas: base,
    adjustments: [],
  };
  if (withholdOrgWideFindings(organizationId)) return empty;
  const counts = await readVerdictCounts(organizationId, now);
  return { ...empty, adjustments: buildSensitivityAdjustments(counts, base) };
}

/** `YYYY-MM` for each of the last `months` months, oldest first. */
function monthKeys(months: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function precisionOf(expected: number, unexpected: number): number | null {
  const reviewed = expected + unexpected;
  return reviewed === 0 ? null : Math.round((unexpected / reviewed) * 1000) / 1000;
}

/**
 * Precision by month of the anomalous day: of the findings somebody gave a
 * verdict, the share that were real problems. Suppressed findings are counted
 * separately; they never alerted, so they are not part of what precision
 * measures.
 */
export async function getCostAnomalyPrecision(
  organizationId: string,
  months: number,
  now = new Date(),
): Promise<CostAnomalyPrecisionReport> {
  const keys = monthKeys(months, now);
  const zero = { detected: 0, suppressed: 0, expected: 0, unexpected: 0 };
  const byMonth = new Map(keys.map((k) => [k, { ...zero }]));
  let reasons: Array<{ reason: CostAnomalyFeedbackReason; count: number }> = [];

  if (!withholdOrgWideFindings(organizationId)) {
    const since = `${keys[0]}-01`;
    const month = sql<string>`substr(${costAnomalies.day}, 1, 7)`;
    const inWindow = and(
      eq(costAnomalies.organizationId, organizationId),
      gte(costAnomalies.day, since),
    );
    const [rows, reasonRows] = await Promise.all([
      db
        .select({
          month,
          detected: count(),
          suppressed: sql<number>`count(*) filter (where ${costAnomalies.suppressedById} is not null)`,
          expected: sql<number>`count(*) filter (where ${costAnomalies.feedbackVerdict} = 'expected')`,
          unexpected: sql<number>`count(*) filter (where ${costAnomalies.feedbackVerdict} = 'unexpected')`,
        })
        .from(costAnomalies)
        .where(inWindow)
        .groupBy(month),
      db
        .select({ reason: costAnomalies.feedbackReason, n: count() })
        .from(costAnomalies)
        .where(and(inWindow, isNotNull(costAnomalies.feedbackReason)))
        .groupBy(costAnomalies.feedbackReason),
    ]);
    for (const r of rows) {
      const slot = byMonth.get(r.month);
      if (!slot) continue;
      slot.detected = Number(r.detected);
      slot.suppressed = Number(r.suppressed);
      slot.expected = Number(r.expected);
      slot.unexpected = Number(r.unexpected);
    }
    reasons = reasonRows
      .flatMap((r) => (r.reason ? [{ reason: r.reason, count: Number(r.n) }] : []))
      .sort((a, b) => b.count - a.count);
  }

  const periods: CostAnomalyPrecisionPeriod[] = keys.map((k) => {
    const v = byMonth.get(k) ?? zero;
    return { month: k, ...v, precision: precisionOf(v.expected, v.unexpected) };
  });
  const totals = periods.reduce(
    (t, p) => ({
      detected: t.detected + p.detected,
      suppressed: t.suppressed + p.suppressed,
      expected: t.expected + p.expected,
      unexpected: t.unexpected + p.unexpected,
    }),
    { ...zero },
  );
  return {
    months,
    periods,
    totals: { ...totals, precision: precisionOf(totals.expected, totals.unexpected) },
    reasons,
  };
}
