/**
 * Scorecards: how well each service meets the org's own operational bar.
 *
 * A scorecard is a weighted list of **checks** ("has an on-call schedule",
 * "no critical posture findings") plus a ladder of **levels** (bronze, silver,
 * gold by default). Each service a scorecard applies to gets a score, the
 * weight of passing checks over the weight of applicable ones, and the
 * highest level whose minimum that score reaches.
 *
 * ## The check registry
 *
 * {@link SCORECARD_CHECK_TYPES} is the whole list of check *types*, one entry
 * each: label, description and the parameters an editor offers. The server's
 * evaluators (`server-core/src/scorecards/checks.ts`) are keyed by the same
 * ids and typed `satisfies Record<ScorecardCheckType, …>`, so a type without
 * an evaluator, or an evaluator without metadata, is a compile error rather
 * than a check that silently never passes. Adding a check is one entry here
 * and one there.
 *
 * ## Not applicable is not failing
 *
 * A check that has nothing to judge (no stateful members to back up, no
 * budget set) is `not_applicable` and leaves the denominator, so a stateless
 * service is not marked down for lacking restore drills. A service where
 * nothing applies has a null score and no level, which every surface prints as
 * "not scored", never as zero.
 */
import type { CloudFetch } from "./fetch";
import type { ServiceTier } from "./services";

// ---------------------------------------------------------------------------
// Check registry (metadata)
// ---------------------------------------------------------------------------

export type ScorecardCheckType =
  | "has_owner"
  | "has_on_call"
  | "slo_within_budget"
  | "has_runbook"
  | "backups_verified"
  | "no_critical_posture"
  | "no_orphans"
  | "required_tags"
  | "cost_within_budget";

export type ScorecardParamKind = "number" | "string_list" | "severity_list";

export interface ScorecardParamDef {
  key: string;
  label: string;
  description: string;
  kind: ScorecardParamKind;
  default: number | string[];
  min?: number;
  max?: number;
}

export interface ScorecardCheckTypeDef {
  type: ScorecardCheckType;
  label: string;
  description: string;
  defaultWeight: number;
  params: readonly ScorecardParamDef[];
}

export const SCORECARD_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type ScorecardSeverity = (typeof SCORECARD_SEVERITIES)[number];

/**
 * One entry per check type. Order is the order editors offer them in.
 * Integration points (vulnerabilities, deploy metrics) add their entries here
 * and their evaluators beside the built-ins.
 */
export const SCORECARD_CHECK_TYPES: readonly ScorecardCheckTypeDef[] = [
  {
    type: "has_owner",
    label: "Has an owner",
    description: "The service names an owning team or at least one owning member.",
    defaultWeight: 2,
    params: [],
  },
  {
    type: "has_on_call",
    label: "Has an on-call schedule",
    description: "The service links an enabled on-call schedule.",
    defaultWeight: 2,
    params: [],
  },
  {
    type: "slo_within_budget",
    label: "SLO within budget",
    description:
      "The service links at least one SLO, and every linked SLO has at least the minimum share of its error budget left.",
    defaultWeight: 2,
    params: [
      {
        key: "minBudgetRemainingPercent",
        label: "Minimum budget remaining (%)",
        description: "Fail when any linked SLO has less than this share of its error budget left.",
        kind: "number",
        default: 0,
        min: 0,
        max: 100,
      },
    ],
  },
  {
    type: "has_runbook",
    label: "Has a runbook",
    description: "The service links at least one enabled runbook.",
    defaultWeight: 1,
    params: [],
  },
  {
    type: "backups_verified",
    label: "Backed up and restore-tested",
    description:
      "Every stateful member is backed up within the org's backup policy and has a passing restore drill within the window. Not applicable to services with no stateful members.",
    defaultWeight: 2,
    params: [
      {
        key: "drillWithinDays",
        label: "Restore drill within (days)",
        description: "How recent the last verified restore drill must be.",
        kind: "number",
        default: 90,
        min: 1,
        max: 730,
      },
    ],
  },
  {
    type: "no_critical_posture",
    label: "No serious posture findings",
    description: "No member has an open posture finding at the chosen severities.",
    defaultWeight: 2,
    params: [
      {
        key: "severities",
        label: "Severities that fail",
        description: "Open findings at any of these severities fail the check.",
        kind: "severity_list",
        default: ["critical", "high"],
      },
    ],
  },
  {
    type: "no_orphans",
    label: "No orphaned resources",
    description: "No member is flagged by the orphan finder.",
    defaultWeight: 1,
    params: [],
  },
  {
    type: "required_tags",
    label: "Required tags present",
    description:
      "Every taggable member carries the required tags. Leave the list empty to use the org's tag policy.",
    defaultWeight: 1,
    params: [
      {
        key: "tags",
        label: "Required tag keys",
        description: "Tag keys every taggable member must carry. Empty uses the org tag policy.",
        kind: "string_list",
        default: [],
      },
    ],
  },
  {
    type: "cost_within_budget",
    label: "Cost within budget",
    description:
      "The last 30 days of member spend is within the service's monthly budget. Not applicable when the service has no budget.",
    defaultWeight: 1,
    params: [],
  },
];

export const SCORECARD_CHECK_TYPE_IDS: readonly ScorecardCheckType[] = SCORECARD_CHECK_TYPES.map(
  (d) => d.type,
);

export function scorecardCheckTypeDef(type: string): ScorecardCheckTypeDef | undefined {
  return SCORECARD_CHECK_TYPES.find((d) => d.type === type);
}

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

export interface ScorecardCheck {
  /** Stable within the scorecard; results and history refer to it. */
  id: string;
  type: ScorecardCheckType;
  /** Display override; the type's label when null. */
  name: string | null;
  weight: number;
  params: Record<string, number | string[]>;
}

export interface ScorecardLevel {
  /** Stable key, e.g. "gold"; alerts and history store it. */
  key: string;
  name: string;
  /** Minimum score (0-100) to reach the level. */
  minScore: number;
  /** Optional hex colour, e.g. "#d4af37". */
  color: string | null;
}

export interface ScorecardInput {
  name: string;
  description: string | null;
  checks: ScorecardCheck[];
  /** Ordered lowest first; the API sorts them by `minScore`. */
  levels: ScorecardLevel[];
  /** Tiers the scorecard applies to; empty means every service, tiered or not. */
  applicableTiers: ServiceTier[];
  /** Route an alert when a service drops a level. */
  alertOnLevelDrop: boolean;
  enabled: boolean;
}

export interface Scorecard extends ScorecardInput {
  id: string;
  /** The one seeded for the org; still editable and deletable. */
  isDefault: boolean;
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScorecardCheckStatus = "pass" | "fail" | "not_applicable" | "error";

export interface ScorecardCheckResult {
  checkId: string;
  type: ScorecardCheckType;
  name: string;
  weight: number;
  status: ScorecardCheckStatus;
  /** Why, in a sentence: "2 of 3 stateful members have no restore drill". */
  detail: string | null;
}

export interface ScorecardResult {
  scorecardId: string;
  scorecardName: string;
  serviceId: string;
  /** 0-100; null when no check applied. */
  score: number | null;
  level: string | null;
  levelName: string | null;
  checks: ScorecardCheckResult[];
  evaluatedAt: string;
}

export interface ScorecardHistoryPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  score: number | null;
  level: string | null;
}

export interface ScorecardListResponse {
  scorecards: Scorecard[];
}

export interface ScorecardOverviewService {
  id: string;
  name: string;
  slug: string;
  tier: ServiceTier | null;
  ownerTeam: string | null;
}

/** The matrix: services down, scorecards across, a result in each applicable cell. */
export interface ScorecardOverviewResponse {
  scorecards: Scorecard[];
  services: ScorecardOverviewService[];
  results: ScorecardResult[];
}

export interface ServiceScorecardsResponse {
  results: ScorecardResult[];
  /** Per scorecard id, oldest first, at most 90 days. */
  history: Record<string, ScorecardHistoryPoint[]>;
}

export const SCORECARD_LIMITS = {
  nameMaxLength: 120,
  descriptionMaxLength: 1000,
  maxChecks: 30,
  minWeight: 1,
  maxWeight: 10,
  maxLevels: 6,
  levelNameMaxLength: 40,
  checkNameMaxLength: 120,
  historyDays: 90,
} as const;

export const DEFAULT_SCORECARD_LEVELS: readonly ScorecardLevel[] = [
  { key: "bronze", name: "Bronze", minScore: 50, color: "#b0793e" },
  { key: "silver", name: "Silver", minScore: 75, color: "#9aa4ad" },
  { key: "gold", name: "Gold", minScore: 90, color: "#d4a72c" },
];

/** Default params for a check type, from the registry. */
export function defaultScorecardParams(
  type: ScorecardCheckType,
): Record<string, number | string[]> {
  const def = scorecardCheckTypeDef(type);
  const out: Record<string, number | string[]> = {};
  for (const p of def?.params ?? []) {
    out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  }
  return out;
}

/** The scorecard seeded for a new org: every built-in check at its default weight. */
export function defaultScorecardInput(): ScorecardInput {
  return {
    name: "Production readiness",
    description:
      "Ownership, reliability, recoverability, security and cost basics for every service.",
    checks: SCORECARD_CHECK_TYPES.map((def) => ({
      id: def.type,
      type: def.type,
      name: null,
      weight: def.defaultWeight,
      params: defaultScorecardParams(def.type),
    })),
    levels: DEFAULT_SCORECARD_LEVELS.map((l) => ({ ...l })),
    applicableTiers: [],
    alertOnLevelDrop: true,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Scoring (pure; the poller, the API and the editors' preview agree)
// ---------------------------------------------------------------------------

/** Levels sorted lowest first. */
export function sortScorecardLevels(levels: readonly ScorecardLevel[]): ScorecardLevel[] {
  return [...levels].sort((a, b) => a.minScore - b.minScore);
}

/** The highest level whose minimum `score` reaches, or null. */
export function scorecardLevelFor(
  score: number | null,
  levels: readonly ScorecardLevel[],
): ScorecardLevel | null {
  if (score === null) return null;
  let reached: ScorecardLevel | null = null;
  for (const level of sortScorecardLevels(levels)) {
    if (score >= level.minScore) reached = level;
  }
  return reached;
}

/** Position of a level key on the ladder; -1 for "no level" or an unknown key. */
export function scorecardLevelRank(key: string | null, levels: readonly ScorecardLevel[]): number {
  if (key === null) return -1;
  return sortScorecardLevels(levels).findIndex((l) => l.key === key);
}

/** True when `next` sits lower on the ladder than `previous`. */
export function isScorecardLevelDrop(
  previous: string | null,
  next: string | null,
  levels: readonly ScorecardLevel[],
): boolean {
  if (previous === null) return false;
  return scorecardLevelRank(next, levels) < scorecardLevelRank(previous, levels);
}

/**
 * Weighted score over applicable checks, rounded to one decimal. `error`
 * counts as failing: a check that could not be evaluated has not been met,
 * and a broken data feed must not quietly lift a service's level.
 */
export function computeScorecardScore(
  results: ReadonlyArray<Pick<ScorecardCheckResult, "status" | "weight">>,
): number | null {
  let applicable = 0;
  let passed = 0;
  for (const r of results) {
    if (r.status === "not_applicable") continue;
    applicable += r.weight;
    if (r.status === "pass") passed += r.weight;
  }
  if (applicable === 0) return null;
  return Math.round((passed / applicable) * 1000) / 10;
}

/** Whether a scorecard applies to a service of this tier. */
export function scorecardAppliesTo(
  scorecard: Pick<ScorecardInput, "applicableTiers" | "enabled">,
  tier: ServiceTier | null,
): boolean {
  if (!scorecard.enabled) return false;
  if (scorecard.applicableTiers.length === 0) return true;
  return tier !== null && scorecard.applicableTiers.includes(tier);
}

export function scorecardCheckName(check: Pick<ScorecardCheck, "name" | "type">): string {
  return check.name?.trim() || scorecardCheckTypeDef(check.type)?.label || check.type;
}

const LEVEL_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function validateScorecardInput(input: ScorecardInput): string | null {
  const name = input.name.trim();
  if (!name) return "Give the scorecard a name.";
  if (name.length > SCORECARD_LIMITS.nameMaxLength) {
    return `Names are at most ${SCORECARD_LIMITS.nameMaxLength} characters.`;
  }
  if ((input.description ?? "").length > SCORECARD_LIMITS.descriptionMaxLength) {
    return `Descriptions are at most ${SCORECARD_LIMITS.descriptionMaxLength} characters.`;
  }
  if (input.checks.length === 0) return "Add at least one check.";
  if (input.checks.length > SCORECARD_LIMITS.maxChecks) {
    return `A scorecard can have at most ${SCORECARD_LIMITS.maxChecks} checks.`;
  }
  const ids = new Set<string>();
  for (const check of input.checks) {
    const def = scorecardCheckTypeDef(check.type);
    if (!def) return `Unknown check type "${check.type}".`;
    if (!check.id || ids.has(check.id)) return "Every check needs a unique id.";
    ids.add(check.id);
    if (
      !Number.isInteger(check.weight) ||
      check.weight < SCORECARD_LIMITS.minWeight ||
      check.weight > SCORECARD_LIMITS.maxWeight
    ) {
      return `Weights are whole numbers from ${SCORECARD_LIMITS.minWeight} to ${SCORECARD_LIMITS.maxWeight}.`;
    }
    if ((check.name ?? "").length > SCORECARD_LIMITS.checkNameMaxLength) {
      return "A check name is too long.";
    }
    for (const param of def.params) {
      const value = check.params[param.key];
      if (value === undefined) continue;
      if (param.kind === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return `${def.label}: ${param.label} must be a number.`;
        }
        if (
          (param.min !== undefined && value < param.min) ||
          (param.max !== undefined && value > param.max)
        ) {
          return `${def.label}: ${param.label} must be between ${param.min ?? "-"} and ${param.max ?? "-"}.`;
        }
      } else {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          return `${def.label}: ${param.label} must be a list.`;
        }
        if (
          param.kind === "severity_list" &&
          value.some((v) => !(SCORECARD_SEVERITIES as readonly string[]).includes(v))
        ) {
          return `${def.label}: unknown severity.`;
        }
      }
    }
  }
  if (input.levels.length === 0) return "Add at least one level.";
  if (input.levels.length > SCORECARD_LIMITS.maxLevels) {
    return `A scorecard can have at most ${SCORECARD_LIMITS.maxLevels} levels.`;
  }
  const keys = new Set<string>();
  const scores = new Set<number>();
  for (const level of input.levels) {
    if (!LEVEL_KEY_PATTERN.test(level.key)) {
      return "Level keys are lower-case letters, digits, dashes and underscores.";
    }
    if (keys.has(level.key)) return "Level keys must be unique.";
    keys.add(level.key);
    if (!level.name.trim() || level.name.length > SCORECARD_LIMITS.levelNameMaxLength) {
      return "Every level needs a short name.";
    }
    if (!Number.isFinite(level.minScore) || level.minScore < 0 || level.minScore > 100) {
      return "Level minimums are between 0 and 100.";
    }
    if (scores.has(level.minScore)) return "Two levels cannot share a minimum score.";
    scores.add(level.minScore);
    if (level.color !== null && !/^#[0-9a-fA-F]{6}$/.test(level.color)) {
      return "Level colours are six-digit hex values like #d4a72c.";
    }
  }
  for (const tier of input.applicableTiers) {
    if (![1, 2, 3, 4].includes(tier)) return "Tiers are 1, 2, 3 or 4.";
  }
  return null;
}

/** Fill a partial body from defaults; levels sorted lowest first. */
export function normalizeScorecardInput(input: ScorecardInput): ScorecardInput {
  return {
    ...input,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    checks: input.checks.map((c) => ({
      ...c,
      name: c.name?.trim() || null,
      params: { ...defaultScorecardParams(c.type), ...c.params },
    })),
    levels: sortScorecardLevels(input.levels).map((l) => ({
      ...l,
      name: l.name.trim(),
      color: l.color ?? null,
    })),
    applicableTiers: [...new Set(input.applicableTiers)].sort(),
  };
}

export function formatScorecardScore(score: number | null): string {
  return score === null ? "not scored" : `${Math.round(score)}%`;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers
// ---------------------------------------------------------------------------

/** `GET /api/org/:orgId/scorecards` (`resources:read`). */
export async function fetchScorecards(
  api: CloudFetch,
  orgId: string,
): Promise<ScorecardListResponse> {
  const res = await api.org<ScorecardListResponse>(orgId, "/scorecards");
  return res ?? { scorecards: [] };
}

/** `GET /api/org/:orgId/scorecards/overview`: the service × scorecard matrix. */
export async function fetchScorecardOverview(
  api: CloudFetch,
  orgId: string,
): Promise<ScorecardOverviewResponse> {
  const res = await api.org<ScorecardOverviewResponse>(orgId, "/scorecards/overview");
  return res ?? { scorecards: [], services: [], results: [] };
}

/** `GET /api/org/:orgId/services/:id/scorecards`: results plus history for one service. */
export async function fetchServiceScorecards(
  api: CloudFetch,
  orgId: string,
  serviceId: string,
): Promise<ServiceScorecardsResponse> {
  const res = await api.org<ServiceScorecardsResponse>(
    orgId,
    `/services/${encodeURIComponent(serviceId)}/scorecards`,
  );
  return res ?? { results: [], history: {} };
}

export async function createScorecard(
  api: CloudFetch,
  orgId: string,
  body: Partial<ScorecardInput> & { name: string },
): Promise<Scorecard | null> {
  return api.org<Scorecard>(orgId, "/scorecards", { method: "POST", body: JSON.stringify(body) });
}

export async function updateScorecard(
  api: CloudFetch,
  orgId: string,
  scorecardId: string,
  body: Partial<ScorecardInput>,
): Promise<Scorecard | null> {
  return api.org<Scorecard>(orgId, `/scorecards/${encodeURIComponent(scorecardId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteScorecard(
  api: CloudFetch,
  orgId: string,
  scorecardId: string,
): Promise<void> {
  await api.org(orgId, `/scorecards/${encodeURIComponent(scorecardId)}`, { method: "DELETE" });
}

/** `POST /api/org/:orgId/scorecards/:id/evaluate`: re-score every service now. */
export async function evaluateScorecard(
  api: CloudFetch,
  orgId: string,
  scorecardId: string,
): Promise<ScorecardOverviewResponse | null> {
  return api.org<ScorecardOverviewResponse>(
    orgId,
    `/scorecards/${encodeURIComponent(scorecardId)}/evaluate`,
    { method: "POST" },
  );
}
