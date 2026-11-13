import type { BLimits, BSandboxType } from "./types.js";

/**
 * boat's four machine sizes, from https://docs.boat.dev/machines and
 * https://docs.boat.dev/pricing (checked 2026-11). The API reports a running
 * sandbox's `vcpu` and `memoryGB` but publishes no catalog, so the shape of each
 * size is written down here; the price is taken live from `/limits`
 * (`overagePrices.vmHourDollars`, the default size's hourly rate) times the
 * size's multiplier whenever the account answers, and the documented rate only
 * stands in when it does not.
 */
export interface SandboxSize {
  id: BSandboxType;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  /** Price relative to `default`, the same number boat returns as `billingMultiplier`. */
  multiplier: number;
}

export const SIZES: readonly SandboxSize[] = [
  { id: "small", vcpus: 2, memoryGb: 4, diskGb: 51, multiplier: 0.5 },
  { id: "default", vcpus: 4, memoryGb: 8, diskGb: 51, multiplier: 1 },
  { id: "large", vcpus: 8, memoryGb: 16, diskGb: 111, multiplier: 2 },
  // $0.20/h against $0.036/h: the docs give the ratio as 50/9.
  { id: "xlarge", vcpus: 16, memoryGb: 32, diskGb: 251, multiplier: 50 / 9 },
];

/** The default size's hourly list price, $0.036 (one dollar buys 100,000 seconds). */
export const DOCUMENTED_DEFAULT_HOURLY = 0.036;

export const HOURS_PER_MONTH = 730;

export function sizeById(id: string): SandboxSize | undefined {
  return SIZES.find((s) => s.id === id);
}

/** The default size's hourly rate this account pays past its plan. */
export function defaultHourly(limits: BLimits | undefined): number {
  const live = limits?.overagePrices?.vmHourDollars;
  return typeof live === "number" && live > 0 ? live : DOCUMENTED_DEFAULT_HOURLY;
}

export function hourlyPrice(size: SandboxSize, limits: BLimits | undefined): number {
  return defaultHourly(limits) * size.multiplier;
}

/** Why the account cannot create this size now, or "" when it can. */
export function unavailableReason(id: string, limits: BLimits | undefined): string {
  const entry = (limits?.machineTypes ?? []).find((m) => m.type === id);
  if (!entry || entry.available) return "";
  return entry.reason || "not available on this plan";
}
