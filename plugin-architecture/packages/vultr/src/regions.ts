/**
 * Region display data. The authoritative list is live (`GET /v2/regions`,
 * public, with each region's `options` such as `kubernetes`,
 * `load_balancers`, `block_storage_high_perf`); this table backs the region
 * enum on fields and the offline fallback. Captured from `GET /v2/regions` on
 * 2026-10-06 (33 regions).
 */

import type { RegionOption } from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";
import type { VultrRegion } from "./types.js";

export const KNOWN_REGIONS: Array<{ id: string; city: string; country: string }> = [
  { id: "ams", city: "Amsterdam", country: "NL" },
  { id: "atl", city: "Atlanta", country: "US" },
  { id: "blr", city: "Bangalore", country: "IN" },
  { id: "bom", city: "Mumbai", country: "IN" },
  { id: "cdg", city: "Paris", country: "FR" },
  { id: "del", city: "Delhi NCR", country: "IN" },
  { id: "dfw", city: "Dallas", country: "US" },
  { id: "ewr", city: "New Jersey", country: "US" },
  { id: "fra", city: "Frankfurt", country: "DE" },
  { id: "hnl", city: "Honolulu", country: "US" },
  { id: "icn", city: "Seoul", country: "KR" },
  { id: "itm", city: "Osaka", country: "JP" },
  { id: "jnb", city: "Johannesburg", country: "ZA" },
  { id: "lax", city: "Los Angeles", country: "US" },
  { id: "lhr", city: "London", country: "GB" },
  { id: "mad", city: "Madrid", country: "ES" },
  { id: "man", city: "Manchester", country: "GB" },
  { id: "mel", city: "Melbourne", country: "AU" },
  { id: "mex", city: "Mexico City", country: "MX" },
  { id: "mia", city: "Miami", country: "US" },
  { id: "mxp", city: "Milan", country: "IT" },
  { id: "nrt", city: "Tokyo", country: "JP" },
  { id: "ord", city: "Chicago", country: "US" },
  { id: "sao", city: "São Paulo", country: "BR" },
  { id: "scl", city: "Santiago", country: "CL" },
  { id: "sea", city: "Seattle", country: "US" },
  { id: "sgp", city: "Singapore", country: "SG" },
  { id: "sjc", city: "Silicon Valley", country: "US" },
  { id: "sto", city: "Stockholm", country: "SE" },
  { id: "syd", city: "Sydney", country: "AU" },
  { id: "tlv", city: "Tel Aviv", country: "IL" },
  { id: "waw", city: "Warsaw", country: "PL" },
  { id: "yto", city: "Toronto", country: "CA" },
];

export const REGION_IDS = KNOWN_REGIONS.map((r) => r.id);

/** Emoji flag from an ISO 3166 alpha-2 country code. */
export function countryFlag(country: string | undefined): string | undefined {
  const cc = (country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Region options a region must list in `options` to host a product. */
export type RegionCapability =
  | "kubernetes"
  | "load_balancers"
  | "block_storage_high_perf"
  | "block_storage_storage_opt"
  | "ddos_protection";

export function regionOption(r: { id: string; city?: string; country?: string }): RegionOption {
  const known = KNOWN_REGIONS.find((k) => k.id === r.id);
  const city = r.city ?? known?.city;
  const flag = countryFlag(r.country ?? known?.country);
  return {
    id: r.id,
    label: city ?? r.id,
    location: r.id,
    ...(flag ? { flag } : {}),
  };
}

/** Live regions (optionally filtered by capability), falling back to the static table. */
export async function regionOptions(
  api: VultrApi,
  capability?: RegionCapability,
): Promise<RegionOption[]> {
  try {
    const regions = await api.all<VultrRegion>("/regions", "regions");
    const usable = capability
      ? regions.filter((r) => (r.options ?? []).includes(capability))
      : regions;
    if (usable.length > 0) return usable.map(regionOption);
  } catch {
    // fall through
  }
  return KNOWN_REGIONS.map(regionOption);
}

export function regionLabel(id: string | undefined | null): string {
  if (!id) return "";
  const known = KNOWN_REGIONS.find((r) => r.id === id);
  return known ? known.city : id;
}
