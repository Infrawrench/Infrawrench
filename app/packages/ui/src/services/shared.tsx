import { useGT } from "gt-react";
import {
  SERVICE_TIER_LABELS,
  formatScorecardScore,
  type Scorecard,
  type ScorecardCheckStatus,
  type ServiceTier,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";

export const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
export const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
export const smallButtonClass =
  "px-2 py-1 rounded-lg text-xs text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50";
export const primaryButtonClass =
  "rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white disabled:opacity-50";
export const secondaryButtonClass =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";

type Gt = ReturnType<typeof useGT>;

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** "Tier 1" etc., translated through the data-string lookup (the labels live in client-core). */
export function useTierLabel(): (tier: ServiceTier | null) => string {
  const gt = useGT();
  const dataString = useDataString();
  return (tier) => (tier === null ? gt("Untiered") : dataString(SERVICE_TIER_LABELS[tier]));
}

export function checkStatusLabel(status: ScorecardCheckStatus, gt: Gt): string {
  switch (status) {
    case "pass":
      return gt("Pass");
    case "fail":
      return gt("Fail");
    case "not_applicable":
      return gt("N/A");
    case "error":
      return gt("Error");
  }
}

export function checkStatusClass(status: ScorecardCheckStatus): string {
  switch (status) {
    case "pass":
      return "text-success";
    case "fail":
      return "text-danger";
    case "error":
      return "text-warning";
    case "not_applicable":
      return "text-on-surface-faint";
  }
}

/** The colour a scorecard gives a level key, when it set one. */
export function levelColor(
  scorecards: readonly Scorecard[] | null | undefined,
  scorecardId: string,
  levelKey: string | null,
): string | null {
  if (!levelKey || !scorecards) return null;
  const card = scorecards.find((s) => s.id === scorecardId);
  return card?.levels.find((l) => l.key === levelKey)?.color ?? null;
}

/**
 * A score with its level: the level name on a tint of the level's colour. The
 * colour is decoration; the name and the number carry the meaning, so it
 * reads the same to somebody who cannot tell bronze from gold.
 */
export function ScoreBadge({
  score,
  levelName,
  color,
  label,
}: {
  score: number | null;
  levelName: string | null;
  color: string | null;
  /** Scorecard name, prefixed when several badges sit side by side. */
  label?: string | undefined;
}) {
  const gt = useGT();
  const text =
    score === null
      ? gt("Not scored")
      : levelName
        ? gt("{level} · {score}", { level: levelName, score: formatScorecardScore(score) })
        : gt("No level · {score}", { score: formatScorecardScore(score) });
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-on-surface tabular-nums whitespace-nowrap"
      style={
        color && score !== null ? { borderColor: color, backgroundColor: `${color}22` } : undefined
      }
      title={label}
    >
      {label ? <span className="text-on-surface-secondary">{label}:</span> : null}
      {text}
    </span>
  );
}
