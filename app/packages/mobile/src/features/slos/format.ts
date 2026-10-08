import {
  describeSloSource,
  formatBudgetDuration,
  type Slo,
  type SloStatus,
} from "@infrawrench/client-core";
import { colors } from "@/lib/theme";

/** Mobile is deliberately untranslated (see CLAUDE.md), so these are plain English. */
export function sloStatusLabel(slo: Slo): string {
  if (!slo.enabled) return "disabled";
  const labels: Record<SloStatus, string> = {
    exhausted: "budget spent",
    fast_burn: "fast burn",
    slow_burn: "slow burn",
    ok: "within budget",
    unknown: "no data",
  };
  return labels[slo.status];
}

export function sloStatusColor(slo: Slo): string {
  if (!slo.enabled) return colors.textFaint;
  switch (slo.status) {
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

/** "64.2% left (27m 40s)" / "over by 12m" / null with no data. */
export function sloBudgetLine(slo: Slo): string | null {
  if (slo.budgetRemaining === null || slo.budgetRemainingMinutes === null) return null;
  if (slo.budgetRemaining <= 0) {
    return `over by ${formatBudgetDuration(slo.budgetRemainingMinutes)}`;
  }
  return `${Number((slo.budgetRemaining * 100).toFixed(1))}% left (${formatBudgetDuration(slo.budgetRemainingMinutes)})`;
}

export function sloSourceLine(slo: Slo): string {
  return describeSloSource(slo);
}
