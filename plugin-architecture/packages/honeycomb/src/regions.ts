import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * Honeycomb's two regions. Each has its own API host, and keys only work in
 * the region they were created in. The ids (`us1`, `eu1`) are the names the
 * status page puts in its component names ("ui.eu1.honeycomb.io - EU1
 * Querying"), which is what lets incidents correlate with resources.
 */
export interface HoneycombRegion {
  id: string;
  label: string;
  apiUrl: string;
  uiUrl: string;
}

export const HONEYCOMB_REGIONS: HoneycombRegion[] = [
  {
    id: "us1",
    label: "US",
    apiUrl: "https://api.honeycomb.io",
    uiUrl: "https://ui.honeycomb.io",
  },
  {
    id: "eu1",
    label: "EU",
    apiUrl: "https://api.eu1.honeycomb.io",
    uiUrl: "https://ui.eu1.honeycomb.io",
  },
];

export const DEFAULT_REGION_ID = "us1";

export const REGION_PICKER: CredentialFieldRegion[] = [
  { id: "us1", label: "US", location: "ui.honeycomb.io", flag: "🇺🇸" },
  { id: "eu1", label: "EU", location: "ui.eu1.honeycomb.io", flag: "🇪🇺" },
];

/** Accepts the picker id, the label, or a pasted API or UI host. */
export function resolveRegion(raw: string | undefined): HoneycombRegion {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return HONEYCOMB_REGIONS[0] as HoneycombRegion;
  const found = HONEYCOMB_REGIONS.find(
    (r) =>
      r.id === value ||
      r.label.toLowerCase() === value ||
      value.includes(new URL(r.apiUrl).host) ||
      value.includes(new URL(r.uiUrl).host),
  );
  if (found) return found;
  if (value === "eu" || value.includes("eu1")) return HONEYCOMB_REGIONS[1] as HoneycombRegion;
  throw new Error(`Honeycomb plugin: unknown region "${raw}"`);
}
