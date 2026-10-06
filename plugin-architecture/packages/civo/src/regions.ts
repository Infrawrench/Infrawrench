/**
 * Regions. The live list is `GET /v2/regions` (each with `features` such as
 * `kubernetes`, `dbaas`, `object_store`, `loadbalancer`); listers fan out
 * across it, because almost every Civo resource is regional. The static
 * table is the offline fallback, captured from Civo's docs and status page
 * (2026-10).
 */

import type { RegionOption } from "@infrawrench/plugin-base";
import type { CivoApi } from "./api.js";
import type { CivoRegion } from "./types.js";

export const KNOWN_REGIONS: Array<{ code: string; name: string; country: string }> = [
  { code: "LON1", name: "London", country: "GB" },
  { code: "FRA1", name: "Frankfurt", country: "DE" },
  { code: "NYC1", name: "New York", country: "US" },
  { code: "PHX1", name: "Phoenix", country: "US" },
  { code: "MUM1", name: "Mumbai", country: "IN" },
];

export function countryFlag(country: string | undefined): string | undefined {
  const cc = (country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export type RegionFeature =
  "iaas" | "kubernetes" | "object_store" | "loadbalancer" | "dbaas" | "volume";

/** Caches the account's regions for the life of a client. */
export class RegionCache {
  private pending: Promise<CivoRegion[]> | null = null;
  constructor(private readonly api: CivoApi) {}

  all(): Promise<CivoRegion[]> {
    if (!this.pending) {
      this.pending = this.api
        .get<CivoRegion[]>("/regions")
        .then((r) => (Array.isArray(r) && r.length ? r : fallback()))
        .catch(() => {
          this.pending = null;
          return fallback();
        });
    }
    return this.pending;
  }

  async codes(feature?: RegionFeature): Promise<string[]> {
    const regions = await this.all();
    return regions.filter((r) => !feature || r.features?.[feature] !== false).map((r) => r.code);
  }

  async options(feature?: RegionFeature): Promise<RegionOption[]> {
    const regions = await this.all();
    return regions
      .filter((r) => !feature || r.features?.[feature] !== false)
      .map((r) => regionOption(r));
  }
}

function fallback(): CivoRegion[] {
  return KNOWN_REGIONS.map((r) => ({ code: r.code, name: r.name, country: r.country }));
}

export function regionOption(r: CivoRegion): RegionOption {
  const known = KNOWN_REGIONS.find((k) => k.code.toLowerCase() === r.code.toLowerCase());
  const flag = countryFlag(r.country ?? known?.country);
  return {
    id: r.code,
    label: r.country_name
      ? `${r.name ?? known?.name ?? r.code}`
      : (known?.name ?? r.name ?? r.code),
    location: r.code,
    ...(flag ? { flag } : {}),
  };
}

export function regionLabel(code: string | undefined | null): string {
  if (!code) return "";
  return KNOWN_REGIONS.find((r) => r.code.toLowerCase() === code.toLowerCase())?.name ?? code;
}

export const REGION_IDS = KNOWN_REGIONS.map((r) => r.code.toLowerCase());
