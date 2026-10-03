import type { RegionOption } from "@infrawrench/plugin-base";

/**
 * Static region metadata: the location label and flag the region picker
 * shows. The live list comes from `GET /v1/platform/regions`; this table is
 * the fallback when that call fails and the source of the flag emoji, which
 * the API does not return.
 */
export const REGION_INFO: Record<string, { location: string; flag: string }> = {
  ams: { location: "Amsterdam, Netherlands", flag: "\u{1F1F3}\u{1F1F1}" },
  arn: { location: "Stockholm, Sweden", flag: "\u{1F1F8}\u{1F1EA}" },
  atl: { location: "Atlanta, Georgia (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  bog: { location: "Bogotá, Colombia", flag: "\u{1F1E8}\u{1F1F4}" },
  bom: { location: "Mumbai, India", flag: "\u{1F1EE}\u{1F1F3}" },
  bos: { location: "Boston, Massachusetts (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  cdg: { location: "Paris, France", flag: "\u{1F1EB}\u{1F1F7}" },
  den: { location: "Denver, Colorado (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  dfw: { location: "Dallas, Texas (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  ewr: { location: "Secaucus, NJ (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  eze: { location: "Buenos Aires, Argentina", flag: "\u{1F1E6}\u{1F1F7}" },
  fra: { location: "Frankfurt, Germany", flag: "\u{1F1E9}\u{1F1EA}" },
  gdl: { location: "Guadalajara, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
  gig: { location: "Rio de Janeiro, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
  gru: { location: "São Paulo, Brazil", flag: "\u{1F1E7}\u{1F1F7}" },
  hkg: { location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
  iad: { location: "Ashburn, Virginia (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  jnb: { location: "Johannesburg, South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
  lax: { location: "Los Angeles, California (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  lhr: { location: "London, United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
  mad: { location: "Madrid, Spain", flag: "\u{1F1EA}\u{1F1F8}" },
  mia: { location: "Miami, Florida (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  nrt: { location: "Tokyo, Japan", flag: "\u{1F1EF}\u{1F1F5}" },
  ord: { location: "Chicago, Illinois (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  otp: { location: "Bucharest, Romania", flag: "\u{1F1F7}\u{1F1F4}" },
  phx: { location: "Phoenix, Arizona (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  qro: { location: "Querétaro, Mexico", flag: "\u{1F1F2}\u{1F1FD}" },
  scl: { location: "Santiago, Chile", flag: "\u{1F1E8}\u{1F1F1}" },
  sea: { location: "Seattle, Washington (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  sin: { location: "Singapore", flag: "\u{1F1F8}\u{1F1EC}" },
  sjc: { location: "San Jose, California (US)", flag: "\u{1F1FA}\u{1F1F8}" },
  syd: { location: "Sydney, Australia", flag: "\u{1F1E6}\u{1F1FA}" },
  waw: { location: "Warsaw, Poland", flag: "\u{1F1F5}\u{1F1F1}" },
  yul: { location: "Montreal, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
  yyz: { location: "Toronto, Canada", flag: "\u{1F1E8}\u{1F1E6}" },
};

/** One row of `GET /v1/platform/regions` (`main.regionRow` in the spec). */
export interface FlyPlatformRegion {
  code: string;
  name?: string;
  deprecated?: boolean;
  gateway_available?: boolean;
  geo_region?: string;
  mpg_available?: boolean;
  requires_paid_plan?: boolean;
}

export function formatRegion(code: string): string {
  const info = REGION_INFO[code];
  if (!info) return code;
  return `${code} (${info.location})`;
}

export function staticRegionOptions(): RegionOption[] {
  return Object.entries(REGION_INFO).map(([code, info]) => ({
    id: code,
    label: code.toUpperCase(),
    location: info.location,
    flag: info.flag,
  }));
}

/**
 * Build region-picker options from the live platform list. Deprecated
 * regions are dropped (Fly stops placing new Machines there);
 * `requireMpg` narrows to regions that can host Managed Postgres.
 */
export function regionOptionsFrom(
  rows: FlyPlatformRegion[],
  opts: { requireMpg?: boolean } = {},
): RegionOption[] {
  return rows
    .filter((r) => r.code && !r.deprecated && (!opts.requireMpg || r.mpg_available))
    .map((r) => {
      const known = REGION_INFO[r.code];
      const location = r.name || known?.location || r.code;
      const option: RegionOption = {
        id: r.code,
        label: r.code.toUpperCase(),
        location: r.requires_paid_plan ? `${location} (paid plans)` : location,
      };
      if (known) option.flag = known.flag;
      return option;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
