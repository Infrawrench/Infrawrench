import type { GameDayDetector, GameDayStatus, GameDayTargetState } from "@infrawrench/client-core";
import { colors } from "@/lib/theme";

export function gameDayStatusLabel(status: GameDayStatus): string {
  switch (status) {
    case "planned":
      return "Planned";
    case "armed":
      return "Armed";
    case "injecting":
      return "Injecting";
    case "running":
      return "Running";
    case "reverting":
      return "Undoing";
    case "recovering":
      return "Waiting for recovery";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "undo_failed":
      return "Undo failed";
  }
}

export function gameDayStatusColor(status: GameDayStatus): string {
  switch (status) {
    case "injecting":
    case "running":
    case "reverting":
    case "undo_failed":
      return colors.danger;
    case "armed":
    case "recovering":
      return colors.warning;
    case "completed":
      return colors.success;
    case "planned":
    case "cancelled":
      return colors.textMuted;
  }
}

export function gameDayTargetStateLabel(state: GameDayTargetState): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "injecting":
      return "Injecting";
    case "injected":
      return "Injected";
    case "skipped":
      return "Skipped (already in that state)";
    case "inject_failed":
      return "Inject failed";
    case "reverted":
      return "Undone";
    case "undo_failed":
      return "Undo failed";
  }
}

export function gameDayDetectorLabel(detector: GameDayDetector): string {
  switch (detector) {
    case "probe_failure":
      return "First failed probe check";
    case "probe_alert":
      return "Probe declared down";
    case "metric_alert":
      return "Metric alert";
    case "slo_burn":
      return "SLO burn alert";
    case "incident":
      return "Incident declared";
    case "alert":
      return "Alert sent";
    case "page":
      return "On-call paged";
    case "acknowledge":
      return "Page acknowledged";
  }
}

export function formatInstant(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}
