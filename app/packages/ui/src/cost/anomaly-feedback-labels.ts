import { useMemo } from "react";
import { useGT } from "gt-react";
import type {
  CostAnomalyFeedbackReason,
  CostAnomalyRecurrence,
  CostAnomalySuppressionScope,
  CostAnomalyVerdict,
} from "@infrawrench/client-core";

/**
 * Translated labels for the anomaly feedback enums. Client-core carries the
 * English maps for the CLI, MCP and mobile; these are the same words spelled
 * as literal `gt()` calls so the extractor sees every one.
 */
export function useAnomalyFeedbackLabels() {
  const gt = useGT();
  return useMemo(
    () => ({
      verdict(v: CostAnomalyVerdict): string {
        return v === "expected" ? gt("Expected") : gt("Unexpected");
      },
      reason(r: CostAnomalyFeedbackReason): string {
        switch (r) {
          case "planned_launch":
            return gt("Planned launch");
          case "migration":
            return gt("Migration");
          case "seasonal":
            return gt("Seasonal");
          case "pricing_change":
            return gt("Pricing change");
          case "data_issue":
            return gt("Data issue");
          case "other":
            return gt("Other");
        }
      },
      recurrence(r: CostAnomalyRecurrence): string {
        switch (r) {
          case "one_off":
            return gt("One-off");
          case "weekly":
            return gt("Recurring weekly");
          case "monthly":
            return gt("Recurring monthly");
          case "seasonal":
            return gt("Seasonal (yearly)");
        }
      },
      scope(s: CostAnomalySuppressionScope): string {
        switch (s) {
          case "provider":
            return gt("Provider");
          case "service":
            return gt("Service");
          case "account":
            return gt("Account");
          case "tag":
            return gt("Tag");
          case "cost_centre":
            return gt("Cost centre");
        }
      },
    }),
    [gt],
  );
}

/** "Oct 4, 2026" for a YYYY-MM-DD day, read as UTC. */
export function formatFeedbackDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Today as YYYY-MM-DD (UTC). */
export function todayIsoDay(): string {
  return new Date().toISOString().slice(0, 10);
}
