import type { QuotaUsage } from "@infrawrench/plugin-base";
import type { BLimits, BSavedSnapshotAllowance } from "./types.js";

/**
 * Quotas from `GET /limits` and the saved-snapshot allowance on
 * `GET /saved-snapshots`, every limit and every count as boat states them.
 * An unlimited account answers null start windows and no plan allowance, and
 * those quotas are left out rather than read as zero.
 *
 * Only the sandboxes-at-once cap refuses outright. Starts past the window
 * limits, machine time past the plan's hours and snapshots past the included
 * count are paid from the wallet, so those rows say so in their names: running
 * out of them is where spending starts, not where work stops.
 */

const DOCS = "https://docs.boat.dev/pricing";

function windowQuota(
  id: string,
  name: string,
  window: { limit?: number; used?: number } | null | undefined,
): QuotaUsage | null {
  if (!window || typeof window.limit !== "number" || window.limit <= 0) return null;
  return {
    id,
    service: "sandboxes",
    name,
    limit: window.limit,
    used: window.used ?? 0,
    unit: "starts",
    adjustable: true,
    docsUrl: DOCS,
  };
}

export function quotasFrom(
  limits: BLimits,
  allowance: BSavedSnapshotAllowance | undefined,
): QuotaUsage[] {
  const out: QuotaUsage[] = [];
  if (typeof limits.maxActiveSandboxes === "number" && limits.maxActiveSandboxes > 0) {
    out.push({
      id: "sandboxes/active",
      service: "sandboxes",
      name: "Sandboxes running at once",
      limit: limits.maxActiveSandboxes,
      used: limits.activeSandboxes ?? 0,
      unit: "sandboxes",
      adjustable: true,
      docsUrl: DOCS,
    });
  }
  const starts = limits.starts;
  if (starts && !starts.unlimited) {
    for (const q of [
      windowQuota("starts/minute", "Starts per minute before paid extras", starts.minute),
      windowQuota("starts/hour", "Starts per hour before paid extras", starts.hour),
      windowQuota("starts/day", "Starts per day before paid extras", starts.day),
    ]) {
      if (q) out.push(q);
    }
  }
  const plan = limits.planIncluded;
  if (plan && typeof plan.vmHours === "number" && plan.vmHours > 0) {
    const remaining =
      typeof plan.vmHoursRemaining === "number" ? plan.vmHoursRemaining : plan.vmHours;
    out.push({
      id: "plan/vm-hours",
      service: "plan",
      name: "Included machine time this period",
      limit: plan.vmHours,
      used: Math.max(0, Math.round((plan.vmHours - remaining) * 100) / 100),
      unit: "default-size hours",
      adjustable: true,
      docsUrl: DOCS,
    });
  }
  if (allowance && typeof allowance.included === "number" && allowance.included > 0) {
    out.push({
      id: "plan/saved-snapshots",
      service: "plan",
      name: "Included saved snapshots",
      limit: allowance.included,
      used: allowance.used ?? 0,
      unit: "snapshots",
      adjustable: true,
      docsUrl: DOCS,
    });
  }
  return out;
}
