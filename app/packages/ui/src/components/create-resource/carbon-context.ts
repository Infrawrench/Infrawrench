import { createContext, useContext } from "react";
import type { CreateCarbonHint } from "@infrawrench/plugin-base";
import { monthlyCarbonForSize } from "@infrawrench/client-core";

/**
 * What a size card needs to show its own carbon figure: the form's carbon
 * hint and the region currently picked. Provided by `CreateResourceModal`, so
 * the hosts' field renderers stay unchanged; a picker rendered outside a
 * create form (an edit form, a test) simply shows no figure.
 */
export const CreateCarbonContext = createContext<{
  hint: CreateCarbonHint | undefined;
  region: string | null;
} | null>(null);

/** Monthly kg CO2e of a size in the picked region, or null. */
export function useSizeCarbon(vcpus: number): number | null {
  const ctx = useContext(CreateCarbonContext);
  if (!ctx) return null;
  return monthlyCarbonForSize(ctx.hint, ctx.region, vcpus);
}
