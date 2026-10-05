import {
  COST_BASES,
  COST_BASIS_DESCRIPTIONS,
  COST_BASIS_LABELS,
  type CostBasis,
} from "@infrawrench/client-core";
import { ChipSelect } from "@/components/form";
import { useCostStatus } from "./useCostStatus";

/**
 * The cash/amortized/blended choice, as chips: mobile's counterpart of web's
 * "Cost basis" select, over the same `CostBasis` the API validates.
 *
 * Rendered only when some connected account's plugin reports amortized cost.
 * Showing it otherwise would offer two chips that draw the identical number:
 * every provider that reports no amortized amount falls back to its cash one,
 * so on such an org the choice is real in the contract and imaginary on screen.
 * The blended chip follows the same rule on `blending`. A widget already saved
 * on a basis keeps that chip regardless, so a setting can never be lost to a
 * status call that happened to fail.
 *
 * The hint names the selected basis, standing in for the web select's
 * tooltip (a phone has no hover).
 */
export function CostBasisChips({
  value,
  onChange,
}: {
  value: CostBasis | undefined;
  onChange: (basis: CostBasis) => void;
}) {
  const status = useCostStatus();
  const costed = (status.data ?? []).filter((s) => s.supportsCosts);
  const blendingAvailable = value === "blended" || costed.some((s) => s.blending === true);
  const available =
    value === "amortized" || blendingAvailable || costed.some((s) => s.amortization);
  if (!available) return null;

  const selected = value ?? "cash";
  const options = COST_BASES.filter((b) => b !== "blended" || blendingAvailable).map((b) => ({
    value: b,
    label: COST_BASIS_LABELS[b],
  }));

  return (
    <ChipSelect
      label="Cost basis"
      hint={
        selected === "cash"
          ? COST_BASIS_DESCRIPTIONS.cash
          : `${COST_BASIS_DESCRIPTIONS[selected]} Providers that don't report it fall back to ${
              selected === "blended" ? "amortized" : "what they charged"
            }.`
      }
      options={options}
      value={selected}
      onChange={onChange}
    />
  );
}
