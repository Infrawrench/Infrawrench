import {
  SERVICE_TIER_LABELS,
  formatScorecardScore,
  type ScorecardCheckStatus,
  type ScorecardLevel,
  type ServiceSloStanding,
  type ServiceTier,
} from "@infrawrench/client-core";
import { colors } from "@/lib/theme";

/** Mobile is deliberately untranslated (see CLAUDE.md), so these are plain English. */
export function serviceTierLabel(tier: ServiceTier | null): string {
  return tier === null ? "Not tiered" : SERVICE_TIER_LABELS[tier];
}

/** "Gold · 92%" / "not scored". The level name is omitted when no level is reached. */
export function scoreLine(score: number | null, levelName: string | null): string {
  const value = formatScorecardScore(score);
  return levelName && score !== null ? `${levelName} · ${value}` : value;
}

/**
 * The level's own colour when the scorecard defines one (the overview carries
 * the ladder), else a neutral tone; "not scored" is faint, never red.
 */
export function levelColor(
  level: string | null,
  levels: readonly ScorecardLevel[] | undefined,
): string {
  if (level === null) return colors.textFaint;
  const color = levels?.find((l) => l.key === level)?.color;
  return color ?? colors.textSecondary;
}

export function checkStatusLabel(status: ScorecardCheckStatus): string {
  const labels: Record<ScorecardCheckStatus, string> = {
    pass: "pass",
    fail: "fail",
    not_applicable: "n/a",
    error: "error",
  };
  return labels[status];
}

export function checkStatusColor(status: ScorecardCheckStatus): string {
  switch (status) {
    case "pass":
      return colors.success;
    case "fail":
    case "error":
      return colors.danger;
    case "not_applicable":
      return colors.textFaint;
  }
}

export function sloStandingLabel(status: ServiceSloStanding["status"]): string {
  const labels: Record<ServiceSloStanding["status"], string> = {
    exhausted: "budget spent",
    fast_burn: "fast burn",
    slow_burn: "slow burn",
    ok: "within budget",
    unknown: "no data",
  };
  return labels[status];
}

export function sloStandingColor(status: ServiceSloStanding["status"]): string {
  switch (status) {
    case "exhausted":
    case "fast_burn":
      return colors.danger;
    case "slow_burn":
      return colors.warning;
    case "ok":
      return colors.success;
    case "unknown":
      return colors.textFaint;
  }
}

/** Short relative time for change rows: "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
