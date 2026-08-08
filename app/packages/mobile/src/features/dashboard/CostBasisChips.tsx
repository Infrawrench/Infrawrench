import { COST_BASES, COST_BASIS_LABELS, type CostBasis } from "@infrawrench/client-core";
import { ChipSelect } from "@/components/form";
import { useCostStatus } from "./useCostStatus";

/**
 * The cash/amortized choice, as chips — mobile's counterpart of web's "Cost
 * basis" select, over the same `CostBasis` the API validates.
 *
 * Rendered only when some connected account's plugin reports amortized cost.
 * Showing it otherwise would offer two chips that draw the identical number:
 * every provider that reports no amortized amount falls back to its cash one,
 * so on such an org the choice is real in the contract and imaginary on screen.
 * A widget already saved as amortized keeps the control regardless (`force`),
 * so a setting can never be lost to a status call that happened to fail.
 */
const BASIS_OPTIONS = COST_BASES.map((b) => ({ value: b, label: COST_BASIS_LABELS[b] }));

export function CostBasisChips({
  value,
  onChange,
}: {
  value: CostBasis | undefined;
  onChange: (basis: CostBasis) => void;
}) {
  const status = useCostStatus();
  const available =
    value === "amortized" || (status.data ?? []).some((s) => s.supportsCosts && s.amortization);
  if (!available) return null;

  return (
    <ChipSelect
      label="Cost basis"
      hint="Amortized spreads a commitment's up-front fee across the term it buys. Providers that don't report one fall back to what they charged."
      options={BASIS_OPTIONS}
      value={value ?? "cash"}
      onChange={onChange}
    />
  );
}
