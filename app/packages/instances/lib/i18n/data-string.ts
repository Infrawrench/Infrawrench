import { useGT } from "gt-react";

/**
 * Translation for strings that arrive as values rather than literals: the
 * attribute, variant and section labels in `lib/attributes.ts`, declared with
 * `msg("…")` (which the gt CLI extracts and returns unchanged). Same lookup as
 * `useGT()`'s `gt()`, under a name the CLI does not scan, because it rejects
 * non-literal arguments to the functions it recognizes. Mirrors
 * `useDataString` in `@infrawrench/ui`. An unknown value renders as-is.
 */
export function useDataString(): (value: string) => string {
  return useGT();
}
