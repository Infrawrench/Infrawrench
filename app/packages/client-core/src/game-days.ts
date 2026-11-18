/**
 * Game days: a planned, controlled failure that measures how well the
 * organization detects and recovers.
 *
 * The wire types every surface reads (web, desktop, mobile, the CLI), the
 * limits the editor, the API and the CLI agree on, and the pure arithmetic of
 * the report. The report is computed here rather than on the server so the
 * page, the phone and the terminal print the same numbers from the same
 * stored timestamps.
 *
 * The server half (the pass that injects, watches, undoes and confirms
 * recovery) is `server-core/src/game-days/`; which failures a resource
 * supports is declared by its plugin (`failureActions`, or `lifecycle` for a
 * plain stop) and never listed here.
 */

/**
 * Where a game day is.
 *
 * - `planned`: written, not confirmed. Nothing will happen.
 * - `armed`: a person confirmed it; the failure is injected at `startsAt`.
 * - `injecting`: the injection is under way. A game day found here after a
 *   restart is reverted rather than resumed.
 * - `running`: the failure is in effect; signals are being watched.
 * - `reverting`: the undo is under way (time limit, end now, abort).
 * - `recovering`: undone; waiting for the watched probes to go green.
 * - `completed`: the report is final.
 * - `cancelled`: never injected (disarmed, aborted before the start, or a
 *   change freeze was in effect at the start).
 * - `undo_failed`: the undo kept failing. The resource may still be broken;
 *   somebody has to look, and "Retry undo" puts it back to `reverting`.
 */
export type GameDayStatus =
  | "planned"
  | "armed"
  | "injecting"
  | "running"
  | "reverting"
  | "recovering"
  | "completed"
  | "cancelled"
  | "undo_failed";

export const GAME_DAY_STATUSES: readonly GameDayStatus[] = [
  "planned",
  "armed",
  "injecting",
  "running",
  "reverting",
  "recovering",
  "completed",
  "cancelled",
  "undo_failed",
];

/** Statuses in which the failure may be in effect. */
export const GAME_DAY_LIVE_STATUSES: readonly GameDayStatus[] = [
  "injecting",
  "running",
  "reverting",
  "undo_failed",
];

/** Statuses the poller pass keeps working on. */
export const GAME_DAY_ACTIVE_STATUSES: readonly GameDayStatus[] = [
  "armed",
  "injecting",
  "running",
  "reverting",
  "recovering",
];

/** Why the failure was taken out (or never put in). */
export type GameDayEndReason =
  "time_limit" | "ended" | "aborted" | "inject_failed" | "interrupted" | "freeze";

export const GAME_DAY_END_REASONS: readonly GameDayEndReason[] = [
  "time_limit",
  "ended",
  "aborted",
  "inject_failed",
  "interrupted",
  "freeze",
];

/** One target's progress. */
export type GameDayTargetState =
  "pending" | "injecting" | "injected" | "skipped" | "inject_failed" | "reverted" | "undo_failed";

export const GAME_DAY_TARGET_STATES: readonly GameDayTargetState[] = [
  "pending",
  "injecting",
  "injected",
  "skipped",
  "inject_failed",
  "reverted",
  "undo_failed",
];

/** Bounds shared by the editor, the API's schemas and the CLI. */
export const GAME_DAY_LIMITS = {
  nameMax: 120,
  descriptionMax: 2000,
  targetsMax: 20,
  watchedProbesMax: 20,
  durationMinutesMin: 5,
  durationMinutesMax: 240,
  durationMinutesDefault: 15,
  recoveryTimeoutMinutesMin: 5,
  recoveryTimeoutMinutesMax: 120,
  recoveryTimeoutMinutesDefault: 30,
  /** How far ahead a game day may be scheduled. */
  scheduleAheadDaysMax: 90,
  /** Undo attempts before a game day is parked as `undo_failed`. */
  undoAttemptsMax: 10,
} as const;

export interface GameDayTarget {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** The resource's name when the game day was written. */
  displayName: string;
  /** The plugin's failure action id, e.g. `stop` or `scale-to-zero`. */
  actionId: string;
  actionLabel: string;
  undoLabel: string;
  state: GameDayTargetState;
  /** What the plugin reported before the inject, e.g. "3 replicas". */
  stateBefore: string | null;
  injectedAt: string | null;
  revertedAt: string | null;
  attempts: number;
  lastError: string | null;
}

/**
 * When each detector first noticed, all ISO strings or null.
 *
 * The first five are read from the features' own records (probe rows, metric
 * alert events, SLO alert states, declared incidents); the last three from the
 * alerts the org's routing rules sent while the game day ran.
 */
export interface GameDaySignals {
  /** First failed check of a watched probe. */
  probeFailedAt: string | null;
  /** A watched probe declared down (which is what sends the probe alert). */
  probeDownAt: string | null;
  /** A metric alert fired on a target or a member of the service. */
  metricAlertAt: string | null;
  /** A watched SLO started burning its budget fast or slow. */
  sloBurnAt: string | null;
  /** Somebody declared an incident. */
  incidentDeclaredAt: string | null;
  /** First related alert the routing rules sent anywhere. */
  alertedAt: string | null;
  /** First related alert routed to an on-call rotation or a paging provider. */
  pagedAt: string | null;
  /** First acknowledgement of a related alert. */
  acknowledgedAt: string | null;
}

export const EMPTY_GAME_DAY_SIGNALS: GameDaySignals = {
  probeFailedAt: null,
  probeDownAt: null,
  metricAlertAt: null,
  sloBurnAt: null,
  incidentDeclaredAt: null,
  alertedAt: null,
  pagedAt: null,
  acknowledgedAt: null,
};

/** An alert the routing rules handled while the game day ran. */
export interface GameDayAlert {
  id: string;
  at: string;
  trigger: string;
  severity: string;
  title: string;
  /** About a target, a member of the service, a watched probe or SLO, or an incident. */
  related: boolean;
  /** Routed to an on-call rotation or a paging provider. */
  paged: boolean;
  /** Matched no rule with a destination: raised, but nobody was told. */
  unrouted: boolean;
}

export interface GameDayWatchedProbe {
  id: string;
  name: string;
  status: "up" | "down" | "unknown";
}

export interface GameDay {
  id: string;
  name: string;
  description: string | null;
  serviceId: string | null;
  serviceName: string | null;
  status: GameDayStatus;
  endReason: GameDayEndReason | null;
  startsAt: string;
  durationMinutes: number;
  recoveryTimeoutMinutes: number;
  freezeDuringRun: boolean;
  /** The change freeze this game day opened, while it exists. */
  freezeId: string | null;
  watchedProbes: GameDayWatchedProbe[];
  watchedSloIds: string[];
  armedAt: string | null;
  armedByUserId: string | null;
  armedByEmail: string | null;
  injectedAt: string | null;
  /** The time limit: `injectedAt + durationMinutes`. */
  endsAt: string | null;
  endRequestedAt: string | null;
  undoneAt: string | null;
  recoveredAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  signals: GameDaySignals;
  targets: GameDayTarget[];
  createdAt: string;
  updatedAt: string;
}

export interface GameDayList {
  gameDays: GameDay[];
}

export interface GameDayDetail {
  gameDay: GameDay;
  alerts: GameDayAlert[];
  report: GameDayReport;
}

/** A failure a resource supports, as the editor's picker lists it. */
export interface GameDayFailureOption {
  actionId: string;
  label: string;
  undoLabel: string;
  description: string | null;
}

export interface GameDayCandidate {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  actions: GameDayFailureOption[];
}

export interface GameDayCandidates {
  /** Synced resources whose type supports at least one failure action. */
  resources: GameDayCandidate[];
  services: { id: string; name: string; resourceIds: string[] }[];
  probes: GameDayWatchedProbe[];
  slos: { id: string; name: string }[];
}

/** One step of the dry run. */
export interface GameDayPlanStep {
  resourceId: string;
  displayName: string;
  pluginId: string;
  actionId: string;
  actionLabel: string;
  undoLabel: string;
  /**
   * `inject`: would inject. `skip`: the failure is already in effect, so it
   * would be left alone (neither injected nor undone). `blocked`: it cannot
   * run, and `problem` says why.
   */
  outcome: "inject" | "skip" | "blocked";
  currentState: string | null;
  problem: string | null;
}

export interface GameDayPlan {
  steps: GameDayPlanStep[];
  /** The change freeze that would stop the injection, if one is in effect now. */
  blockingFreeze: { id: string; name: string } | null;
  /** Detectors nothing is set up to measure (no watched probe, no SLO). */
  unmeasured: GameDayDetector[];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type GameDayDetector =
  | "probe_failure"
  | "probe_alert"
  | "metric_alert"
  | "slo_burn"
  | "incident"
  | "alert"
  | "page"
  | "acknowledge";

export interface GameDayDetectorRow {
  detector: GameDayDetector;
  /** When it fired, or null when it did not. */
  at: string | null;
  /** Milliseconds after the injection, or null. */
  afterMs: number | null;
  /**
   * False when nothing was set up that could fire it (no watched probe for the
   * probe rows, no SLO for the SLO row): "did not fire" and "could not fire"
   * are different findings.
   */
  measurable: boolean;
}

export interface GameDayReport {
  /** Injection to the first detector of any kind. */
  timeToDetectMs: number | null;
  /** Injection to the first page. */
  timeToPageMs: number | null;
  /** Page to its first acknowledgement. */
  timeToAcknowledgeMs: number | null;
  /** Undo to the watched probes green again. */
  timeToRecoverMs: number | null;
  /** How long the failure was in effect. */
  injectedForMs: number | null;
  detectedBy: GameDayDetector | null;
  detectors: GameDayDetectorRow[];
  /**
   * Whether the report is final (`completed`), still filling in, or never
   * applies (`cancelled` and `planned`).
   */
  state: "final" | "in_progress" | "not_run";
}

const DETECTOR_ORDER: readonly GameDayDetector[] = [
  "probe_failure",
  "probe_alert",
  "metric_alert",
  "slo_burn",
  "alert",
  "page",
  "acknowledge",
  "incident",
];

/** Detectors that count as the organization having noticed. */
const DETECTING: ReadonlySet<GameDayDetector> = new Set([
  "probe_failure",
  "probe_alert",
  "metric_alert",
  "slo_burn",
  "alert",
  "page",
  "incident",
]);

function signalFor(signals: GameDaySignals, detector: GameDayDetector): string | null {
  switch (detector) {
    case "probe_failure":
      return signals.probeFailedAt;
    case "probe_alert":
      return signals.probeDownAt;
    case "metric_alert":
      return signals.metricAlertAt;
    case "slo_burn":
      return signals.sloBurnAt;
    case "incident":
      return signals.incidentDeclaredAt;
    case "alert":
      return signals.alertedAt;
    case "page":
      return signals.pagedAt;
    case "acknowledge":
      return signals.acknowledgedAt;
  }
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function diff(from: string | null, to: string | null): number | null {
  const a = ms(from);
  const b = ms(to);
  if (a === null || b === null) return null;
  return Math.max(0, b - a);
}

/**
 * The game day's report, from its stored timestamps. Pure: the server, the
 * pages and the CLI all call this on the same `GameDay`.
 */
export function computeGameDayReport(
  gameDay: Pick<
    GameDay,
    | "status"
    | "injectedAt"
    | "undoneAt"
    | "recoveredAt"
    | "signals"
    | "watchedProbes"
    | "watchedSloIds"
  >,
  now: number = Date.now(),
): GameDayReport {
  const { signals, injectedAt } = gameDay;
  const hasProbes = gameDay.watchedProbes.length > 0;
  const hasSlos = gameDay.watchedSloIds.length > 0;
  const detectors: GameDayDetectorRow[] = DETECTOR_ORDER.map((detector) => {
    const at = signalFor(signals, detector);
    const measurable =
      detector === "probe_failure" || detector === "probe_alert"
        ? hasProbes
        : detector === "slo_burn"
          ? hasSlos
          : true;
    return { detector, at, afterMs: diff(injectedAt, at), measurable };
  });

  let first: GameDayDetectorRow | null = null;
  for (const row of detectors) {
    if (!DETECTING.has(row.detector) || row.afterMs === null) continue;
    if (!first || row.afterMs < (first.afterMs ?? Infinity)) first = row;
  }

  const notRun = gameDay.status === "planned" || gameDay.status === "cancelled" || !injectedAt;
  const state = notRun ? "not_run" : gameDay.status === "completed" ? "final" : "in_progress";
  const injectedUntil =
    gameDay.undoneAt ?? (state === "in_progress" ? new Date(now).toISOString() : null);

  return {
    timeToDetectMs: first?.afterMs ?? null,
    timeToPageMs: diff(injectedAt, signals.pagedAt),
    timeToAcknowledgeMs: diff(signals.pagedAt ?? signals.alertedAt, signals.acknowledgedAt),
    timeToRecoverMs: diff(gameDay.undoneAt, gameDay.recoveredAt),
    injectedForMs: diff(injectedAt, injectedUntil),
    detectedBy: first?.detector ?? null,
    detectors,
    state,
  };
}

/** The earlier of two optional ISO instants (the signal-recording rule: first wins). */
export function earliestIso(a: string | null, b: string | null): string | null {
  const ta = ms(a);
  const tb = ms(b);
  if (ta === null) return tb === null ? null : b;
  if (tb === null) return a;
  return tb < ta ? b : a;
}

/**
 * Merge freshly observed signals into stored ones. A signal is only ever set
 * once, to the earliest instant seen; a later observation never moves it, so
 * a report cannot change after the fact because a pass ran again.
 */
export function mergeGameDaySignals(
  stored: GameDaySignals,
  observed: Partial<GameDaySignals>,
): GameDaySignals {
  const out: GameDaySignals = { ...stored };
  for (const key of Object.keys(EMPTY_GAME_DAY_SIGNALS) as (keyof GameDaySignals)[]) {
    const next = observed[key];
    if (next !== undefined) out[key] = earliestIso(stored[key], next);
  }
  return out;
}

/** Whether anything noticed the failure: every detector but the acknowledgement. */
export function gameDayDetected(signals: Partial<GameDaySignals>): boolean {
  return Boolean(
    signals.probeFailedAt ??
    signals.probeDownAt ??
    signals.metricAlertAt ??
    signals.sloBurnAt ??
    signals.incidentDeclaredAt ??
    signals.alertedAt ??
    signals.pagedAt,
  );
}

/** Whether a game day can still be aborted (the failure may be in effect, or is about to be). */
export function gameDayAbortable(status: GameDayStatus): boolean {
  return (
    status === "armed" ||
    status === "injecting" ||
    status === "running" ||
    status === "reverting" ||
    status === "undo_failed"
  );
}

/** Whether a game day can still be edited: only before it is armed. */
export function gameDayEditable(status: GameDayStatus): boolean {
  return status === "planned";
}

// ---------------------------------------------------------------------------
// Writing one
// ---------------------------------------------------------------------------

/** One resource and the failure to inject into it. */
export interface GameDayTargetInput {
  resourceId: string;
  actionId: string;
}

/** A game day as the editor writes it and the API stores it. */
export interface GameDayInput {
  name: string;
  description: string | null;
  /** The service the game day is about. Its members are what alerts are matched against. */
  serviceId: string | null;
  targets: GameDayTargetInput[];
  /** ISO 8601. */
  startsAt: string;
  durationMinutes: number;
  recoveryTimeoutMinutes: number;
  /** Open a change freeze for the run, ended when it completes. */
  freezeDuringRun: boolean;
  watchedProbeIds: string[];
  watchedSloIds: string[];
}

/** `1 h 4 min`, `3 min 20 s`, `45 s`; the format every surface prints durations in. */
export function formatGameDayDuration(msValue: number | null): string {
  if (msValue === null) return "-";
  const total = Math.round(msValue / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 && m < 10 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}
