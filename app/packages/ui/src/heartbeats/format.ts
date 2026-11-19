import type { useGT } from "gt-react";
import type { Heartbeat, HeartbeatSchedule } from "@infrawrench/client-core";

type GT = ReturnType<typeof useGT>;

/** A schedule in words, translated. */
export function scheduleLabel(schedule: HeartbeatSchedule, gt: GT): string {
  if (schedule.kind === "cron") {
    return schedule.timezone === "UTC"
      ? gt("Cron {expression} (UTC)", { expression: schedule.cronExpression })
      : gt("Cron {expression} ({zone})", {
          expression: schedule.cronExpression,
          zone: schedule.timezone,
        });
  }
  const n = schedule.intervalMinutes;
  if (n % 1440 === 0) {
    return n === 1440 ? gt("Every day") : gt("Every {count} days", { count: n / 1440 });
  }
  if (n % 60 === 0) {
    return n === 60 ? gt("Every hour") : gt("Every {count} hours", { count: n / 60 });
  }
  return n === 1 ? gt("Every minute") : gt("Every {count} minutes", { count: n });
}

export function statusLabel(heartbeat: Heartbeat, gt: GT): string {
  if (!heartbeat.enabled) return gt("Paused");
  switch (heartbeat.status) {
    case "up":
      return gt("Up");
    case "down":
      return heartbeat.downReason === "failed" ? gt("Failed") : gt("Missed");
    default:
      return gt("Waiting for first ping");
  }
}

export function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** `1234` ms → `1.2s`, `95000` → `1m 35s`, `7200000` → `2h 0m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
