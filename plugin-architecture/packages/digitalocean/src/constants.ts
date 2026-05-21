export const SPACES_REGIONS: string[] = ["nyc3", "sfo3", "ams3", "fra1", "sgp1", "syd1"];

/**
 * Static lookup for known DO datacenter slugs. Covers DO's 14 currently-listable
 * regions plus the two legacy datacenters (ams2, sfo1) that can still show up
 * for older accounts. Source: https://docs.digitalocean.com/platform/regional-availability/
 * Use `regionDisplay()` rather than indexing this map directly — it falls back
 * on slug-prefix heuristics so brand-new regions DO adds (always slug-prefixed
 * by city: e.g. a future `mad1`) still get a flag without a code change.
 */
export const REGION_INFO: Record<string, { location: string; flag: string }> = {
  nyc1: { location: "New York City, USA", flag: "🇺🇸" },
  nyc2: { location: "New York City, USA", flag: "🇺🇸" },
  nyc3: { location: "New York City, USA", flag: "🇺🇸" },
  sfo1: { location: "San Francisco, USA", flag: "🇺🇸" },
  sfo2: { location: "San Francisco, USA", flag: "🇺🇸" },
  sfo3: { location: "San Francisco, USA", flag: "🇺🇸" },
  atl1: { location: "Atlanta, USA", flag: "🇺🇸" },
  ric1: { location: "Richmond, USA", flag: "🇺🇸" },
  ams2: { location: "Amsterdam, Netherlands", flag: "🇳🇱" },
  ams3: { location: "Amsterdam, Netherlands", flag: "🇳🇱" },
  fra1: { location: "Frankfurt, Germany", flag: "🇩🇪" },
  lon1: { location: "London, UK", flag: "🇬🇧" },
  tor1: { location: "Toronto, Canada", flag: "🇨🇦" },
  blr1: { location: "Bangalore, India", flag: "🇮🇳" },
  sgp1: { location: "Singapore", flag: "🇸🇬" },
  syd1: { location: "Sydney, Australia", flag: "🇦🇺" },
};

/**
 * Fallback flags keyed by the three-letter city prefix of a region slug.
 * Used by `regionDisplay()` for slugs that aren't in REGION_INFO yet —
 * lets us show a reasonable flag for any new DO datacenter without a
 * blocking code change.
 */
const REGION_PREFIX_FALLBACK: Record<string, { location: string; flag: string }> = {
  nyc: { location: "New York City, USA", flag: "🇺🇸" },
  sfo: { location: "San Francisco, USA", flag: "🇺🇸" },
  atl: { location: "Atlanta, USA", flag: "🇺🇸" },
  ric: { location: "Richmond, USA", flag: "🇺🇸" },
  ams: { location: "Amsterdam, Netherlands", flag: "🇳🇱" },
  fra: { location: "Frankfurt, Germany", flag: "🇩🇪" },
  lon: { location: "London, UK", flag: "🇬🇧" },
  tor: { location: "Toronto, Canada", flag: "🇨🇦" },
  blr: { location: "Bangalore, India", flag: "🇮🇳" },
  sgp: { location: "Singapore", flag: "🇸🇬" },
  syd: { location: "Sydney, Australia", flag: "🇦🇺" },
};

/**
 * Resolve location + flag for a DO region slug. Prefers the exact-match
 * entry in REGION_INFO; falls back to the slug's three-letter city prefix
 * so unfamiliar slugs (e.g. a hypothetical `nyc4` or a brand-new city DO
 * spins up) still get a reasonable label. Returns undefined only when the
 * slug doesn't match any known prefix — callers should treat that as
 * "show the raw slug, no flag".
 */
export function regionDisplay(slug: string): { location: string; flag: string } | undefined {
  return REGION_INFO[slug] ?? REGION_PREFIX_FALLBACK[slug.slice(0, 3)];
}
