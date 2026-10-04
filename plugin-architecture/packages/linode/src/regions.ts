/**
 * Region display data. The authoritative list is live (`GET /regions`, which
 * is public and carries each region's `capabilities`); this table only adds a
 * flag and a city name for the picker and backs the region enum on fields.
 * Captured from `GET /v4/regions` on 2026-10-04 (33 core regions).
 */

import type { RegionOption } from "@infrawrench/plugin-base";
import type { LinodeApi } from "./api.js";
import type { LinodeRegion } from "./types.js";

const FLAGS: Record<string, string> = {
  us: "🇺🇸",
  ca: "🇨🇦",
  gb: "🇬🇧",
  de: "🇩🇪",
  fr: "🇫🇷",
  se: "🇸🇪",
  es: "🇪🇸",
  it: "🇮🇹",
  nl: "🇳🇱",
  sg: "🇸🇬",
  jp: "🇯🇵",
  in: "🇮🇳",
  au: "🇦🇺",
  id: "🇮🇩",
  br: "🇧🇷",
};

export const KNOWN_REGIONS: Array<{ id: string; label: string; country: string }> = [
  { id: "us-east", label: "Newark, NJ", country: "us" },
  { id: "us-central", label: "Dallas, TX", country: "us" },
  { id: "us-west", label: "Fremont, CA", country: "us" },
  { id: "us-southeast", label: "Atlanta, GA", country: "us" },
  { id: "us-iad", label: "Washington, DC", country: "us" },
  { id: "us-iad-2", label: "Washington 2, DC", country: "us" },
  { id: "us-ord", label: "Chicago, IL", country: "us" },
  { id: "us-sea", label: "Seattle, WA", country: "us" },
  { id: "us-mia", label: "Miami, FL", country: "us" },
  { id: "us-lax", label: "Los Angeles, CA", country: "us" },
  { id: "ca-central", label: "Toronto, CA", country: "ca" },
  { id: "eu-west", label: "London, UK", country: "gb" },
  { id: "gb-lon", label: "London 2, UK", country: "gb" },
  { id: "eu-central", label: "Frankfurt, DE", country: "de" },
  { id: "de-fra-2", label: "Frankfurt 2, DE", country: "de" },
  { id: "fr-par", label: "Paris, FR", country: "fr" },
  { id: "fr-par-2", label: "Paris 2, FR", country: "fr" },
  { id: "se-sto", label: "Stockholm, SE", country: "se" },
  { id: "es-mad", label: "Madrid, ES", country: "es" },
  { id: "it-mil", label: "Milan, IT", country: "it" },
  { id: "nl-ams", label: "Amsterdam, NL", country: "nl" },
  { id: "ap-south", label: "Singapore, SG", country: "sg" },
  { id: "sg-sin-2", label: "Singapore 2, SG", country: "sg" },
  { id: "ap-northeast", label: "Tokyo 2, JP", country: "jp" },
  { id: "jp-tyo-3", label: "Tokyo 3, JP", country: "jp" },
  { id: "jp-osa", label: "Osaka, JP", country: "jp" },
  { id: "ap-west", label: "Mumbai, IN", country: "in" },
  { id: "in-bom-2", label: "Mumbai 2, IN", country: "in" },
  { id: "in-maa", label: "Chennai, IN", country: "in" },
  { id: "ap-southeast", label: "Sydney, AU", country: "au" },
  { id: "au-mel", label: "Melbourne, AU", country: "au" },
  { id: "id-cgk", label: "Jakarta, ID", country: "id" },
  { id: "br-gru", label: "Sao Paulo, BR", country: "br" },
];

export const REGION_IDS = KNOWN_REGIONS.map((r) => r.id);

/**
 * Capability names as `GET /regions` spells them. Used to filter the picker
 * to regions that can actually host the thing being created.
 */
export type RegionCapability =
  | "Linodes"
  | "Block Storage"
  | "NodeBalancers"
  | "Kubernetes"
  | "Object Storage"
  | "Managed Databases"
  | "VPCs"
  | "Cloud Firewall";

export function regionOption(r: { id: string; label?: string; country?: string }): RegionOption {
  const known = KNOWN_REGIONS.find((k) => k.id === r.id);
  const country = (r.country ?? known?.country ?? "").toLowerCase();
  const flag = FLAGS[country];
  return {
    id: r.id,
    label: r.label ?? known?.label ?? r.id,
    location: r.id,
    ...(flag ? { flag } : {}),
  };
}

/**
 * Live regions that list `capability`, as picker options. Falls back to the
 * static table when the live call fails, so a form still opens offline.
 */
export async function regionOptions(
  api: LinodeApi,
  capability: RegionCapability,
): Promise<RegionOption[]> {
  try {
    const regions = await api.all<LinodeRegion>("/regions");
    const usable = regions.filter(
      (r) => (r.capabilities ?? []).includes(capability) && (r.status ?? "ok") === "ok",
    );
    if (usable.length > 0) return usable.map(regionOption);
  } catch {
    // fall through to the static table
  }
  return KNOWN_REGIONS.map(regionOption);
}

export function regionLabel(id: string | undefined | null): string {
  if (!id) return "";
  return KNOWN_REGIONS.find((r) => r.id === id)?.label ?? id;
}
