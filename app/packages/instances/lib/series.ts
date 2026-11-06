import { msg } from "gt-react";
import { commitmentLabel, effectiveHourly, leaseMonths, termOptionKey } from "./format";
import type { Translate } from "./i18n/server";
import { spotSystem, type InstanceModel, type RegionData } from "./model";
import { platformInfo } from "./platforms";

export interface PriceSeries {
  /** `od`, `spot`, or a committed term's lease (`1yr`, `3mo`). */
  id: string;
  /** For a committed term: its index in `InstanceModel.terms`. */
  term?: number;
  /** For a committed term: 0, 1 or 2, shortest lease first, for picking its colour. */
  slot?: number;
  /** A `msg()` source; translate it where it is shown. Committed terms have none (see {@link seriesLabel}). */
  label: string;
  /** `[at, USD per hour]`, oldest first; `null` means not offered from then on. */
  points: [number, number | null][];
}

/**
 * The default reserved option: the platform's preferred one, else standard,
 * no upfront, when the platform sells it, else the first.
 */
export function defaultTermOption(m: InstanceModel): string {
  const keys = m.terms.map(termOptionKey);
  const preferred = platformInfo(m.platform)?.preferredTerm;
  if (preferred && keys.includes(preferred)) return preferred;
  return keys.includes("standard|No Upfront") ? "standard|No Upfront" : (keys[0] ?? "");
}

/**
 * The terms shown beside the on-demand price for a reserved option, shortest
 * lease first: every lease when there are at most three (AWS's 1 and 3 years,
 * RunPod's 3 and 6 months, Azure's 1, 3 and 5 years), else the shortest, 1
 * year and 3 years (Alibaba subscriptions run from 1 month to 5 years, some
 * Azure reservations to 10). The rest are in the table of
 * every term.
 */
export function headlineTerms(m: Pick<InstanceModel, "terms">, termOption: string): number[] {
  const terms = m.terms
    .map((t, i) => ({ i, months: leaseMonths(t.lease) ?? Infinity, key: termOptionKey(t) }))
    .filter((t) => t.key === termOption)
    .sort((a, b) => a.months - b.months);
  if (terms.length <= 3) return terms.map((t) => t.i);
  return terms.filter((t, n) => n === 0 || t.months === 12 || t.months === 36).map((t) => t.i);
}

/** A series' name in the reader's language. */
export function seriesLabel(m: InstanceModel, s: PriceSeries, tr: Translate): string {
  return s.term === undefined ? tr(s.label) : commitmentLabel(m.terms[s.term]!, tr);
}

/**
 * On-demand, the headline committed terms (effective hourly: upfront spread
 * over the term; see {@link headlineTerms}) and, for EC2 variants spot applies
 * to, spot price history for one variant in one region.
 */
export function priceHistory(
  m: InstanceModel,
  data: RegionData,
  variant: number,
  termOption: string,
): PriceSeries[] {
  const out: PriceSeries[] = [
    {
      id: "od",
      label: m.billedMonthly ? msg("Monthly rent") : msg("On demand"),
      points: data.onDemand[variant] ?? [],
    },
  ];
  headlineTerms(m, termOption).forEach((term, slot) => {
    const rows = data.reserved[`${variant}:${term}`];
    if (!rows) return;
    out.push({
      id: m.terms[term]!.lease,
      term,
      slot,
      label: "",
      points: rows.map(([at, hourly, upfront]) => [
        at,
        hourly === null ? null : effectiveHourly(m.terms[term]!, hourly, upfront ?? 0),
      ]),
    });
  });
  const system = spotSystem(m, variant);
  const spot = system < 0 ? undefined : data.spot?.[system];
  if (spot) out.push({ id: "spot", label: msg("Spot"), points: spot });
  return out;
}
