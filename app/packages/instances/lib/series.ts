import { msg } from "gt-react";
import { effectiveHourly, termOptionKey } from "./format";
import type { InstanceModel, RegionData } from "./model";

export interface PriceSeries {
  id: "od" | "1yr" | "3yr";
  /** A `msg()` source; translate it where it is shown. */
  label: string;
  /** `[at, USD per hour]`, oldest first; `null` means not offered from then on. */
  points: [number, number | null][];
}

/** The default reserved option: standard, no upfront, when the platform sells it. */
export function defaultTermOption(m: InstanceModel): string {
  const keys = m.terms.map(termOptionKey);
  return keys.includes("standard|No Upfront") ? "standard|No Upfront" : (keys[0] ?? "");
}

/**
 * On-demand and effective reserved (1- and 3-year, upfront spread over the
 * term) price history for one variant in one region.
 */
export function priceHistory(
  m: InstanceModel,
  data: RegionData,
  variant: number,
  termOption: string,
): PriceSeries[] {
  const out: PriceSeries[] = [
    { id: "od", label: msg("On demand"), points: data.onDemand[variant] ?? [] },
  ];
  for (const [lease, label] of [
    ["1yr", msg("1-year reserved")],
    ["3yr", msg("3-year reserved")],
  ] as const) {
    const term = m.terms.findIndex((t) => t.lease === lease && termOptionKey(t) === termOption);
    const rows = term < 0 ? undefined : data.reserved[`${variant}:${term}`];
    if (!rows) continue;
    out.push({
      id: lease,
      label,
      points: rows.map(([at, hourly, upfront]) => [
        at,
        hourly === null ? null : effectiveHourly(m.terms[term]!, hourly, upfront ?? 0),
      ]),
    });
  }
  return out;
}
