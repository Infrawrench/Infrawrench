import { useGT } from "gt-react";

/**
 * Translation for data-driven strings — plugin display names, resource type
 * labels and other values that arrive as data rather than as literals in the
 * component. Performs the same runtime content-hash lookup as useGT's gt(),
 * but under a name the gt CLI does not scan: the CLI rejects non-literal
 * arguments to the functions it recognizes, and these sources reach the
 * catalogs through the generated plugin-strings manifest instead of the call
 * site (see plugin-strings.gen.ts). An unknown value simply renders as-is.
 */
export function useDataString(): (value: string) => string {
  return useGT();
}
