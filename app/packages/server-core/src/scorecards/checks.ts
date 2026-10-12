/**
 * Scorecard check evaluators: one entry per check type.
 *
 * The metadata (label, description, params) lives in client-core's
 * `SCORECARD_CHECK_TYPES` because the editors, mobile and the CLI need it;
 * this record is the half that needs the database. It is typed
 * `satisfies Record<ScorecardCheckType, …>`, so a type added to the union
 * without an evaluator here does not compile.
 *
 * **Adding a check** (the integration path for vulnerability and deploy
 * metric checks): add the id to `ScorecardCheckType` and an entry to
 * `SCORECARD_CHECK_TYPES` in client-core, then an evaluator here. If it needs a
 * feed nothing else loads, read it through `ctx.signals.extension(key, load)`
 * so it is fetched once per evaluation, not once per service.
 *
 * An evaluator returns `pass`, `fail` or `not_applicable` with a one-sentence
 * reason. It must not throw for missing data; a feed that is down is `error`,
 * which the score counts as failing (see `computeScorecardScore`).
 */
import {
  extractRecordTags,
  tagPolicyViolations,
  type ScorecardCheckStatus,
  type ScorecardCheckType,
  type ScorecardSeverity,
  type Service,
  type ServiceMember,
} from "@infrawrench/client-core";
import type { ServiceSignals } from "../service-catalog/signals";

export interface CheckContext {
  service: Service;
  /** Resolved, present members (missing ones excluded). */
  members: ServiceMember[];
  /** Stored `fields_json` per member resource id, for tag checks. */
  memberFields: Map<string, Record<string, unknown>>;
  signals: ServiceSignals;
}

export interface CheckOutcome {
  status: ScorecardCheckStatus;
  detail: string | null;
}

export type CheckEvaluator = (
  ctx: CheckContext,
  params: Record<string, number | string[]>,
) => Promise<CheckOutcome>;

const pass = (detail: string | null = null): CheckOutcome => ({ status: "pass", detail });
const fail = (detail: string): CheckOutcome => ({ status: "fail", detail });
const na = (detail: string): CheckOutcome => ({ status: "not_applicable", detail });
const unavailable = (feed: string): CheckOutcome => ({
  status: "error",
  detail: `The ${feed} data could not be read.`,
});

function num(params: Record<string, number | string[]>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function list(params: Record<string, number | string[]>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const SCORECARD_CHECK_EVALUATORS = {
  has_owner: async ({ service }) => {
    if (service.owners.length > 0 || service.ownerTeam) {
      return pass(
        service.ownerTeam
          ? `Owned by ${service.ownerTeam}.`
          : `Owned by ${plural(service.owners.length, "member")}.`,
      );
    }
    return fail("No owning team or member is set.");
  },

  has_on_call: async ({ service, signals }) => {
    if (!service.onCallScheduleId) return fail("No on-call schedule is linked.");
    const schedule = await signals.onCallSchedule(service.onCallScheduleId);
    if (!schedule) return fail("The linked on-call schedule no longer exists.");
    if (!schedule.enabled) return fail(`The on-call schedule "${schedule.name}" is disabled.`);
    return pass(`On-call: ${schedule.name}.`);
  },

  slo_within_budget: async ({ service, signals }, params) => {
    if (service.sloIds.length === 0) return fail("No SLO is linked.");
    const slos = await signals.slos();
    if (!slos) return unavailable("SLO");
    const linked = slos.filter((s) => service.sloIds.includes(s.id) && s.enabled);
    if (linked.length === 0) return fail("No enabled SLO is linked.");
    const min = num(params, "minBudgetRemainingPercent", 0) / 100;
    const unknown = linked.filter((s) => s.budgetRemaining === null);
    const short = linked.filter((s) => s.budgetRemaining !== null && s.budgetRemaining <= min);
    if (short.length > 0) {
      return fail(
        `${short.map((s) => s.name).join(", ")} ${short.length === 1 ? "has" : "have"} spent the error budget.`,
      );
    }
    if (unknown.length === linked.length) return fail("No linked SLO has data yet.");
    return pass(`${plural(linked.length - unknown.length, "SLO")} within budget.`);
  },

  has_runbook: async ({ service, signals }) => {
    if (service.runbookIds.length === 0) return fail("No runbook is linked.");
    const runbooks = await signals.runbooks();
    if (!runbooks) return unavailable("runbook");
    const live = runbooks.filter((r) => service.runbookIds.includes(r.id) && r.enabled);
    return live.length > 0
      ? pass(`${plural(live.length, "runbook")} linked.`)
      : fail("Every linked runbook is disabled or deleted.");
  },

  backups_verified: async ({ members, signals }, params) => {
    const days = num(params, "drillWithinDays", 90);
    const [coverage, drills] = await Promise.all([signals.backups(), signals.drills(days)]);
    if (!coverage || !drills) return unavailable("backup");
    const ids = new Set(members.map((m) => m.resourceId));
    const stateful = coverage.resources.filter((r) => ids.has(r.resourceId));
    if (stateful.length === 0) return na("No member is a stateful resource.");
    const breaches = new Set(
      coverage.findings
        .filter((f) => ids.has(f.resourceId) && f.kind !== "orphaned-snapshot")
        .map((f) => f.resourceId),
    );
    const standing = new Map(drills.rows.map((r) => [r.resourceId, r.standing]));
    const notDrilled = stateful.filter((r) => standing.get(r.resourceId) !== "verified");
    if (breaches.size > 0) {
      return fail(`${plural(breaches.size, "stateful member")} outside the backup policy.`);
    }
    if (notDrilled.length > 0) {
      return fail(
        `${notDrilled.length} of ${stateful.length} stateful members have no verified restore drill in ${days} days.`,
      );
    }
    return pass(`${plural(stateful.length, "stateful member")} backed up and restore-tested.`);
  },

  no_critical_posture: async ({ members, signals }, params) => {
    const posture = await signals.posture();
    if (!posture) return unavailable("posture");
    const severities = new Set<string>(
      list(params, "severities").length > 0
        ? list(params, "severities")
        : (["critical", "high"] satisfies ScorecardSeverity[]),
    );
    const ids = new Set(members.map((m) => m.resourceId));
    const hits = posture.findings.filter(
      (f) => ids.has(f.resourceId) && severities.has(f.severity),
    );
    return hits.length === 0
      ? pass(null)
      : fail(`${plural(hits.length, "open finding")} at ${[...severities].join("/")} severity.`);
  },

  no_orphans: async ({ members, signals }) => {
    const orphans = await signals.orphans();
    if (!orphans) return unavailable("orphan");
    const ids = new Set(members.map((m) => m.resourceId));
    const hits = orphans.accounts.flatMap((g) => g.resources).filter((r) => ids.has(r.id));
    return hits.length === 0
      ? pass(null)
      : fail(`${plural(hits.length, "member")} flagged as orphaned.`);
  },

  required_tags: async ({ members, memberFields, signals }, params) => {
    let required = list(params, "tags").map((key) => ({ key }));
    if (required.length === 0) {
      const policy = await signals.tagPolicy();
      if (!policy) return unavailable("tag policy");
      required = policy.requiredTags;
    }
    if (required.length === 0) return na("No required tags are configured.");
    let taggable = 0;
    let violating = 0;
    for (const member of members) {
      const tags = extractRecordTags(memberFields.get(member.resourceId) ?? null);
      if (!tags) continue;
      taggable += 1;
      if (tagPolicyViolations(tags, required).length > 0) violating += 1;
    }
    if (taggable === 0) return na("No member can carry tags.");
    return violating === 0
      ? pass(`${plural(taggable, "taggable member")} carry every required tag.`)
      : fail(`${violating} of ${taggable} taggable members are missing a required tag.`);
  },

  cost_within_budget: async ({ service, members, signals }) => {
    if (service.monthlyBudget === null || !service.budgetCurrency) {
      return na("The service has no monthly budget.");
    }
    const spend = await signals.resourceSpend();
    if (!spend) return unavailable("cost");
    let total = 0;
    let otherCurrency = false;
    for (const m of members) {
      if (!m.externalId) continue;
      for (const row of spend.get(`${m.accountId} ${m.externalId}`) ?? []) {
        if (row.currency === service.budgetCurrency) total += row.amount;
        else otherCurrency = true;
      }
    }
    const line = `${total.toFixed(2)} ${service.budgetCurrency} in 30 days against ${service.monthlyBudget.toFixed(2)}`;
    const suffix = otherCurrency ? " (spend in other currencies not counted)" : "";
    return total <= service.monthlyBudget ? pass(`${line}${suffix}.`) : fail(`${line}${suffix}.`);
  },
} satisfies Record<ScorecardCheckType, CheckEvaluator>;

/** The evaluator for a type, or undefined for a type this build does not know. */
export function scorecardCheckEvaluator(type: string): CheckEvaluator | undefined {
  return (SCORECARD_CHECK_EVALUATORS as Record<string, CheckEvaluator>)[type];
}
