import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * OCI commercial (oc1) regions, from Oracle's region table
 * (https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm,
 * 2026-10) plus the regions OCI's own status page reports
 * (https://ocistatus.oraclecloud.com/api/v2/components.json). `label` is the display name OCI itself uses (the status page and
 * the Console write "US East (Ashburn)"), which is what the status feed's
 * incident titles carry and so what maps an incident back to a region id.
 */
export interface OciRegion {
  id: string;
  label: string;
  location: string;
  flag: string;
}

export const OCI_REGIONS: OciRegion[] = [
  { id: "us-ashburn-1", label: "US East (Ashburn)", location: "Ashburn, VA, USA", flag: "🇺🇸" },
  { id: "us-chicago-1", label: "US Midwest (Chicago)", location: "Chicago, IL, USA", flag: "🇺🇸" },
  { id: "us-phoenix-1", label: "US West (Phoenix)", location: "Phoenix, AZ, USA", flag: "🇺🇸" },
  { id: "us-sanjose-1", label: "US West (San Jose)", location: "San Jose, CA, USA", flag: "🇺🇸" },
  { id: "us-boardman-1", label: "US West (Boardman)", location: "Boardman, OR, USA", flag: "🇺🇸" },
  {
    id: "us-columbus-1",
    label: "US Central (Columbus)",
    location: "Columbus, OH, USA",
    flag: "🇺🇸",
  },
  { id: "us-shawnee-1", label: "US Mid West (Shawnee)", location: "Shawnee, KS, USA", flag: "🇺🇸" },
  {
    id: "ca-montreal-1",
    label: "Canada Southeast (Montreal)",
    location: "Montreal, Canada",
    flag: "🇨🇦",
  },
  {
    id: "ca-toronto-1",
    label: "Canada Southeast (Toronto)",
    location: "Toronto, Canada",
    flag: "🇨🇦",
  },
  {
    id: "mx-queretaro-1",
    label: "Mexico Central (Queretaro)",
    location: "Queretaro, Mexico",
    flag: "🇲🇽",
  },
  {
    id: "mx-monterrey-1",
    label: "Mexico Northeast (Monterrey)",
    location: "Monterrey, Mexico",
    flag: "🇲🇽",
  },
  {
    id: "sa-saopaulo-1",
    label: "Brazil East (Sao Paulo)",
    location: "Sao Paulo, Brazil",
    flag: "🇧🇷",
  },
  {
    id: "sa-vinhedo-1",
    label: "Brazil Southeast (Vinhedo)",
    location: "Vinhedo, Brazil",
    flag: "🇧🇷",
  },
  {
    id: "sa-riodejaneiro-2",
    label: "Brazil East (Rio de Janeiro)",
    location: "Rio de Janeiro, Brazil",
    flag: "🇧🇷",
  },
  {
    id: "sa-santiago-1",
    label: "Chile Central (Santiago)",
    location: "Santiago, Chile",
    flag: "🇨🇱",
  },
  {
    id: "sa-valparaiso-1",
    label: "Chile West (Valparaiso)",
    location: "Valparaiso, Chile",
    flag: "🇨🇱",
  },
  {
    id: "sa-bogota-1",
    label: "Colombia Central (Bogota)",
    location: "Bogota, Colombia",
    flag: "🇨🇴",
  },
  { id: "uk-london-1", label: "UK South (London)", location: "London, United Kingdom", flag: "🇬🇧" },
  {
    id: "uk-cardiff-1",
    label: "UK West (Newport)",
    location: "Newport, United Kingdom",
    flag: "🇬🇧",
  },
  { id: "eu-dublin-3", label: "Ireland East (Dublin)", location: "Dublin, Ireland", flag: "🇮🇪" },
  {
    id: "eu-amsterdam-1",
    label: "Netherlands Northwest (Amsterdam)",
    location: "Amsterdam, Netherlands",
    flag: "🇳🇱",
  },
  {
    id: "eu-frankfurt-1",
    label: "Germany Central (Frankfurt)",
    location: "Frankfurt, Germany",
    flag: "🇩🇪",
  },
  {
    id: "eu-frankfurt-2",
    label: "EU Sovereign Central (Frankfurt)",
    location: "Frankfurt, Germany",
    flag: "🇪🇺",
  },
  { id: "eu-paris-1", label: "France Central (Paris)", location: "Paris, France", flag: "🇫🇷" },
  {
    id: "eu-marseille-1",
    label: "France South (Marseille)",
    location: "Marseille, France",
    flag: "🇫🇷",
  },
  { id: "eu-madrid-1", label: "Spain Central (Madrid)", location: "Madrid, Spain", flag: "🇪🇸" },
  { id: "eu-madrid-3", label: "Spain Central (Madrid 3)", location: "Madrid, Spain", flag: "🇪🇸" },
  {
    id: "eu-madrid-2",
    label: "EU Sovereign South (Madrid)",
    location: "Madrid, Spain",
    flag: "🇪🇺",
  },
  { id: "eu-milan-1", label: "Italy Northwest (Milan)", location: "Milan, Italy", flag: "🇮🇹" },
  { id: "eu-turin-1", label: "Italy North (Turin)", location: "Turin, Italy", flag: "🇮🇹" },
  {
    id: "eu-stockholm-1",
    label: "Sweden Central (Stockholm)",
    location: "Stockholm, Sweden",
    flag: "🇸🇪",
  },
  {
    id: "eu-zurich-1",
    label: "Switzerland North (Zurich)",
    location: "Zurich, Switzerland",
    flag: "🇨🇭",
  },
  {
    id: "eu-jovanovac-1",
    label: "Serbia Central (Jovanovac)",
    location: "Jovanovac, Serbia",
    flag: "🇷🇸",
  },
  {
    id: "il-jerusalem-1",
    label: "Israel Central (Jerusalem)",
    location: "Jerusalem, Israel",
    flag: "🇮🇱",
  },
  { id: "me-abudhabi-1", label: "UAE Central (Abu Dhabi)", location: "Abu Dhabi, UAE", flag: "🇦🇪" },
  { id: "me-dubai-1", label: "UAE East (Dubai)", location: "Dubai, UAE", flag: "🇦🇪" },
  {
    id: "me-jeddah-1",
    label: "Saudi Arabia West (Jeddah)",
    location: "Jeddah, Saudi Arabia",
    flag: "🇸🇦",
  },
  {
    id: "me-riyadh-1",
    label: "Saudi Arabia Central (Riyadh)",
    location: "Riyadh, Saudi Arabia",
    flag: "🇸🇦",
  },
  {
    id: "af-johannesburg-1",
    label: "South Africa Central (Johannesburg)",
    location: "Johannesburg, South Africa",
    flag: "🇿🇦",
  },
  {
    id: "af-casablanca-1",
    label: "Morocco West (Casablanca)",
    location: "Casablanca, Morocco",
    flag: "🇲🇦",
  },
  { id: "ap-mumbai-1", label: "India West (Mumbai)", location: "Mumbai, India", flag: "🇮🇳" },
  {
    id: "ap-hyderabad-1",
    label: "India South (Hyderabad)",
    location: "Hyderabad, India",
    flag: "🇮🇳",
  },
  { id: "ap-singapore-1", label: "Singapore (Singapore)", location: "Singapore", flag: "🇸🇬" },
  { id: "ap-singapore-2", label: "Singapore West (Singapore)", location: "Singapore", flag: "🇸🇬" },
  { id: "ap-batam-1", label: "Indonesia North (Batam)", location: "Batam, Indonesia", flag: "🇮🇩" },
  { id: "ap-kulai-2", label: "Malaysia West 2 (Kulai)", location: "Kulai, Malaysia", flag: "🇲🇾" },
  { id: "ap-tokyo-1", label: "Japan East (Tokyo)", location: "Tokyo, Japan", flag: "🇯🇵" },
  { id: "ap-osaka-1", label: "Japan Central (Osaka)", location: "Osaka, Japan", flag: "🇯🇵" },
  {
    id: "ap-seoul-1",
    label: "South Korea Central (Seoul)",
    location: "Seoul, South Korea",
    flag: "🇰🇷",
  },
  {
    id: "ap-chuncheon-1",
    label: "South Korea North (Chuncheon)",
    location: "Chuncheon, South Korea",
    flag: "🇰🇷",
  },
  {
    id: "ap-sydney-1",
    label: "Australia East (Sydney)",
    location: "Sydney, Australia",
    flag: "🇦🇺",
  },
  {
    id: "ap-melbourne-1",
    label: "Australia Southeast (Melbourne)",
    location: "Melbourne, Australia",
    flag: "🇦🇺",
  },
];

export const DEFAULT_REGION = "us-ashburn-1";

export const HOME_REGION_OPTIONS: CredentialFieldRegion[] = OCI_REGIONS.map((r) => ({
  id: r.id,
  label: r.label,
  location: r.location,
  flag: r.flag,
}));

const REGION_BY_ID = new Map(OCI_REGIONS.map((r) => [r.id, r]));
const REGION_BY_LABEL = new Map(OCI_REGIONS.map((r) => [r.label.toLowerCase(), r]));

export function regionInfo(id: string): OciRegion | undefined {
  return REGION_BY_ID.get(id);
}

/** Map an OCI display name ("US East (Ashburn)") back to its region id. */
export function regionIdForLabel(label: string): string | undefined {
  return REGION_BY_LABEL.get(label.trim().toLowerCase())?.id;
}

/**
 * Second-level domain per realm (oracle/oci-typescript-sdk `realm.ts`). A
 * region id outside oc1 (a government or sovereign region) is recognised by
 * prefix so its endpoints resolve against the right domain.
 */
export function realmDomain(region: string): string {
  if (/^us-(langley|luke)-1$/.test(region)) return "oraclegovcloud.com"; // oc2
  if (/^us-gov-/.test(region)) return "oraclegovcloud.com"; // oc3
  if (/^uk-gov-/.test(region)) return "oraclegovcloud.uk"; // oc4
  if (/^eu-(frankfurt|madrid)-2$/.test(region)) return "oraclecloud.eu"; // oc19 EU Sovereign
  if (region === "eu-jovanovac-1") return "oraclecloud20.com"; // oc20
  return "oraclecloud.com";
}

/**
 * Service hosts, from the OCI SDK's `serviceEndpointTemplate` values. Some
 * services sit under `.oci.` and some do not; getting that wrong is a DNS
 * failure, not an auth error, so it lives in exactly one place.
 */
export type OciService =
  | "identity"
  | "iaas"
  | "database"
  | "containerengine"
  | "objectstorage"
  | "telemetry"
  | "usageapi"
  | "usage"
  | "limits"
  | "query";

const UNDER_OCI = new Set<OciService>([
  "identity",
  "containerengine",
  "usageapi",
  "usage",
  "limits",
  "query",
]);

export function serviceHost(service: OciService, region: string): string {
  const domain = realmDomain(region);
  return UNDER_OCI.has(service)
    ? `${service}.${region}.oci.${domain}`
    : `${service}.${region}.${domain}`;
}

/** Console deep link for a region, used in help links. */
export function consoleUrl(path: string, region: string): string {
  return `https://cloud.oracle.com${path}${path.includes("?") ? "&" : "?"}region=${encodeURIComponent(region)}`;
}
