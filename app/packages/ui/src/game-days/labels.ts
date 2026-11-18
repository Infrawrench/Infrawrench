import type { useGT } from "gt-react";
import type {
  GameDayDetector,
  GameDayEndReason,
  GameDayStatus,
  GameDayTargetState,
} from "@infrawrench/client-core";

type Gt = ReturnType<typeof useGT>;

export function gameDayStatusLabel(status: GameDayStatus, gt: Gt): string {
  switch (status) {
    case "planned":
      return gt("Planned");
    case "armed":
      return gt("Armed");
    case "injecting":
      return gt("Injecting");
    case "running":
      return gt("Running");
    case "reverting":
      return gt("Undoing");
    case "recovering":
      return gt("Waiting for recovery");
    case "completed":
      return gt("Completed");
    case "cancelled":
      return gt("Cancelled");
    case "undo_failed":
      return gt("Undo failed");
  }
}

export function gameDayStatusClass(status: GameDayStatus): string {
  switch (status) {
    case "injecting":
    case "running":
    case "reverting":
    case "undo_failed":
      return "bg-red-500/10 text-danger";
    case "armed":
    case "recovering":
      return "bg-amber-500/10 text-warning";
    case "completed":
      return "bg-emerald-500/10 text-success";
    case "planned":
    case "cancelled":
      return "bg-surface-overlay text-on-surface-tertiary";
  }
}

export function gameDayEndReasonLabel(reason: GameDayEndReason, gt: Gt): string {
  switch (reason) {
    case "time_limit":
      return gt("Time limit reached");
    case "ended":
      return gt("Ended early");
    case "aborted":
      return gt("Aborted");
    case "inject_failed":
      return gt("Inject failed");
    case "interrupted":
      return gt("Interrupted by a restart");
    case "freeze":
      return gt("A change freeze was in effect");
  }
}

export function gameDayTargetStateLabel(state: GameDayTargetState, gt: Gt): string {
  switch (state) {
    case "pending":
      return gt("Pending");
    case "injecting":
      return gt("Injecting");
    case "injected":
      return gt("Injected");
    case "skipped":
      return gt("Skipped (already in that state)");
    case "inject_failed":
      return gt("Inject failed");
    case "reverted":
      return gt("Undone");
    case "undo_failed":
      return gt("Undo failed");
  }
}

export function gameDayDetectorLabel(detector: GameDayDetector, gt: Gt): string {
  switch (detector) {
    case "probe_failure":
      return gt("First failed probe check");
    case "probe_alert":
      return gt("Probe declared down");
    case "metric_alert":
      return gt("Metric alert");
    case "slo_burn":
      return gt("SLO burn alert");
    case "incident":
      return gt("Incident declared");
    case "alert":
      return gt("Alert sent");
    case "page":
      return gt("On-call paged");
    case "acknowledge":
      return gt("Page acknowledged");
  }
}
