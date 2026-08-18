/**
 * The wallboard — one screen, read from across the room.
 *
 * Every page in this product is designed for somebody sitting at it: dense
 * tables, hover states, filters. None of that survives being put on a television
 * four metres away, which is where a team actually wants "is anything wrong".
 *
 * So this is not a dashboard in kiosk mode. It is a different reading of the
 * same data, built on one rule: **a wallboard may only show things that are
 * true right now and that somebody would walk over to look at.** A count that
 * nobody would cross a room for does not belong on a wall, and every trend,
 * breakdown and history has therefore been left out — they belong on the page
 * you open when you do walk over.
 *
 * This module is the pure half: the panel shapes, the overall status rule, and
 * the rotation arithmetic.
 */

/**
 * How the whole wall reads at a glance.
 *
 * Three states rather than five, because at four metres a person distinguishes
 * three colours reliably and nothing more. `degraded` is deliberately the
 * catch-all: an unresolved incident of any severity, an account that stopped
 * syncing. The screen's job is to make somebody walk over, not to grade the
 * problem for them.
 */
export type WallboardStatus = "ok" | "degraded" | "down";

export interface WallboardTile {
  /** Stable across refreshes so a tile does not jump when its value changes. */
  id: string;
  label: string;
  /** The number or short phrase. Big type — this is what carries across a room. */
  value: string;
  /** One line under it, when there is something worth saying. */
  detail: string | null;
  status: WallboardStatus;
}

export interface WallboardIncidentLine {
  id: string;
  title: string;
  severity: string;
  /** ISO 8601; the wall renders "for 41m" from it. */
  startedAt: string;
  status: string;
}

export interface WallboardFailureLine {
  id: string;
  label: string;
  /** What is wrong, in one line. */
  detail: string;
  /** ISO 8601 of when it started failing, when that is known. */
  since: string | null;
}

export interface WallboardResponse {
  status: WallboardStatus;
  tiles: WallboardTile[];
  /** Unresolved incidents, newest first. Empty is the normal case. */
  incidents: WallboardIncidentLine[];
  /** Probes that are down, accounts that stopped syncing. */
  failures: WallboardFailureLine[];
  /**
   * Sources that could not be read. Named on the wall itself, because a
   * wallboard showing green because a query failed is worse than a blank
   * screen — it is a screen actively telling the room the wrong thing.
   */
  failedSources: string[];
  generatedAt: string;
}

/**
 * The overall status.
 *
 * `down` is reserved for the two things that mean customers are affected right
 * now: a sev1 incident, or a probe that is down. Everything else that is wrong
 * — a lower-severity incident, an account that stopped syncing — is
 * `degraded`.
 *
 * A failed source is `degraded` and never `ok`: a wall that shows green because
 * a query threw is worse than a blank one.
 */
export function wallboardStatus(input: {
  incidents: readonly WallboardIncidentLine[];
  failures: readonly WallboardFailureLine[];
  failedSources: readonly string[];
  probesDown: number;
}): WallboardStatus {
  if (input.probesDown > 0) return "down";
  if (input.incidents.some((incident) => incident.severity.toLowerCase() === "sev1")) return "down";
  if (input.incidents.length > 0 || input.failures.length > 0 || input.failedSources.length > 0) {
    return "degraded";
  }
  return "ok";
}

export const WALLBOARD_LIMITS = {
  /** Incidents and failures listed. Past this a wall is a wall of text. */
  maxLines: 8,
  minRefreshSeconds: 15,
  maxRefreshSeconds: 600,
  defaultRefreshSeconds: 60,
  minRotateSeconds: 5,
  maxRotateSeconds: 600,
  defaultRotateSeconds: 20,
} as const;

/**
 * Which panel a rotating wall should be showing.
 *
 * Derived from the clock rather than held in a timer, so every screen in the
 * building shows the same panel at the same moment — two televisions in one
 * room rotating out of step is the sort of thing people notice and nobody can
 * explain. It also means a browser that was asleep resumes in the right place
 * instead of continuing from where it stopped.
 */
export function rotationIndex(nowMs: number, panelCount: number, rotateSeconds: number): number {
  if (panelCount <= 0) return 0;
  const period = Math.max(1, rotateSeconds) * 1000;
  return Math.floor(nowMs / period) % panelCount;
}

/** Clamp a query-supplied number into its allowed range, or the default. */
export function clampWallboardSeconds(
  raw: unknown,
  bounds: { min: number; max: number; fallback: number },
): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/** "41m", "3h 12m", "2d" — a duration read from across a room. */
export function formatWallDuration(sinceIso: string | null, nowMs: number): string {
  if (!sinceIso) return "";
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return "";
  const minutes = Math.max(0, Math.round((nowMs - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
