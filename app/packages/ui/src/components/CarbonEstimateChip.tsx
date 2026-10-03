import { useId, useState } from "react";
import { useGT } from "gt-react";
import {
  ASSUMED_CPU_UTILIZATION,
  formatCo2e,
  formatMonthlyCo2eDelta,
  type CarbonFootprint,
} from "@infrawrench/client-core";

export interface CarbonEstimateChipProps {
  /** The monthly footprint to show. */
  footprint: CarbonFootprint;
  /** Overrides the "Estimated carbon" caption. */
  caption?: string;
  /**
   * The footprint before an edit, when this chip quotes a proposed change:
   * the face then shows the delta, the way the cost chip does.
   */
  previous?: CarbonFootprint | null | undefined;
  /** A cluster whose machines are counted in their own right. */
  aggregate?: boolean;
}

/**
 * The estimated-carbon badge, beside the cost badge on every surface that
 * quotes a monthly price: the create form, the resource detail header and the
 * edit modal.
 *
 * Like the cost chip it is a disclosure, not a bare number, and for a
 * stronger reason: nothing in it is measured. One click shows what it rests
 * on (vCPUs, the grid figure and whose it is, PUE, the assumed utilisation),
 * so the figure cannot be read without its basis.
 */
export function CarbonEstimateChip({
  footprint,
  caption,
  previous,
  aggregate,
}: CarbonEstimateChipProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const face =
    previous != null
      ? formatMonthlyCo2eDelta(footprint.kgCo2e - previous.kgCo2e)
      : gt("~{amount} CO2e/mo", { amount: formatCo2e(footprint.kgCo2e) });
  // Dataset names, not prose: they stay in English in every locale.
  const basis = footprint.gridBasis === "ccf" ? "Cloud Carbon Footprint" : "Ember 2024";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-right px-3 py-1.5 rounded-lg border border-border bg-surface-overlay/50 hover:bg-surface-overlay transition-colors"
      >
        <p className="text-[10px] uppercase tracking-wide text-on-surface-faint">
          {caption ?? gt("Estimated carbon")}
        </p>
        <p className="text-sm font-semibold text-on-surface-secondary tabular-nums">{face}</p>
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-border-strong bg-surface-raised p-3 text-xs shadow-2xl space-y-1.5 text-on-surface-tertiary"
        >
          <p className="text-on-surface">
            {footprint.count === 1
              ? gt("{vcpus} vCPU in {zone}", { vcpus: footprint.vcpus, zone: footprint.gridZone })
              : gt("{count} × {vcpus} vCPU in {zone}", {
                  count: footprint.count,
                  vcpus: footprint.vcpus,
                  zone: footprint.gridZone,
                })}
          </p>
          <p>
            {gt("Grid: {grams} g CO2e/kWh ({source})", {
              grams: Math.round(footprint.gridIntensity),
              source: basis,
            })}
          </p>
          <p>{gt("Datacentre overhead (PUE): {pue}", { pue: footprint.pue })}</p>
          <p>
            {gt("Assumed average CPU utilisation: {percent}%", {
              percent: Math.round(ASSUMED_CPU_UTILIZATION * 100),
            })}
          </p>
          <p>{gt("{kwh} kWh a month", { kwh: footprint.kwh.toFixed(1) })}</p>
          {aggregate && (
            <p>
              {gt(
                "Its machines are listed in their own right, so the Costs page counts them there rather than here.",
              )}
            </p>
          )}
          <p className="text-on-surface-faint">
            {gt(
              "An estimate of processor power only: no storage, memory, network or manufacturing emissions.",
            )}
          </p>
        </div>
      )}
    </div>
  );
}
