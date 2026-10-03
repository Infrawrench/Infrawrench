import type { RegionOption, ImageOption } from "@infrawrench/plugin-base";

/**
 * Locations Cloud Build supports for regional triggers (and 2nd-gen
 * connections). Cloud Build's REST API has no `/locations/-/triggers`
 * aggregate listing, so listers fan out across this list in parallel.
 * Keep in sync with https://cloud.google.com/build/docs/locations.
 */
export const CLOUD_BUILD_REGIONS = [
  "global",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-west1",
  "us-west2",
  "us-south1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "asia-east1",
  "asia-northeast1",
  "asia-southeast1",
  "australia-southeast1",
] as const;

export const REGION_INFO: Record<string, { location: string; flag: string }> = {
  "us-central1": { location: "Iowa, USA", flag: "🇺🇸" },
  "us-east1": { location: "South Carolina, USA", flag: "🇺🇸" },
  "us-east4": { location: "Northern Virginia, USA", flag: "🇺🇸" },
  "us-east5": { location: "Columbus, Ohio, USA", flag: "🇺🇸" },
  "us-south1": { location: "Dallas, Texas, USA", flag: "🇺🇸" },
  "us-west1": { location: "Oregon, USA", flag: "🇺🇸" },
  "us-west2": { location: "Los Angeles, USA", flag: "🇺🇸" },
  "us-west3": { location: "Salt Lake City, USA", flag: "🇺🇸" },
  "us-west4": { location: "Las Vegas, USA", flag: "🇺🇸" },
  "northamerica-northeast1": { location: "Montréal, Canada", flag: "🇨🇦" },
  "northamerica-northeast2": { location: "Toronto, Canada", flag: "🇨🇦" },
  "northamerica-south1": { location: "Querétaro, Mexico", flag: "🇲🇽" },
  "southamerica-east1": { location: "São Paulo, Brazil", flag: "🇧🇷" },
  "southamerica-west1": { location: "Santiago, Chile", flag: "🇨🇱" },
  "europe-west1": { location: "Belgium", flag: "🇧🇪" },
  "europe-west2": { location: "London, UK", flag: "🇬🇧" },
  "europe-west3": { location: "Frankfurt, Germany", flag: "🇩🇪" },
  "europe-west4": { location: "Netherlands", flag: "🇳🇱" },
  "europe-west6": { location: "Zurich, Switzerland", flag: "🇨🇭" },
  "europe-west8": { location: "Milan, Italy", flag: "🇮🇹" },
  "europe-west9": { location: "Paris, France", flag: "🇫🇷" },
  "europe-west10": { location: "Berlin, Germany", flag: "🇩🇪" },
  "europe-west12": { location: "Turin, Italy", flag: "🇮🇹" },
  "europe-central2": { location: "Warsaw, Poland", flag: "🇵🇱" },
  "europe-north1": { location: "Finland", flag: "🇫🇮" },
  "europe-north2": { location: "Stockholm, Sweden", flag: "🇸🇪" },
  "europe-southwest1": { location: "Madrid, Spain", flag: "🇪🇸" },
  "asia-east1": { location: "Taiwan", flag: "🇹🇼" },
  "asia-east2": { location: "Hong Kong", flag: "🇭🇰" },
  "asia-northeast1": { location: "Tokyo, Japan", flag: "🇯🇵" },
  "asia-northeast2": { location: "Osaka, Japan", flag: "🇯🇵" },
  "asia-northeast3": { location: "Seoul, South Korea", flag: "🇰🇷" },
  "asia-south1": { location: "Mumbai, India", flag: "🇮🇳" },
  "asia-south2": { location: "Delhi, India", flag: "🇮🇳" },
  "asia-southeast1": { location: "Singapore", flag: "🇸🇬" },
  "asia-southeast2": { location: "Jakarta, Indonesia", flag: "🇮🇩" },
  "asia-southeast3": { location: "Bangkok, Thailand", flag: "🇹🇭" },
  "australia-southeast1": { location: "Sydney, Australia", flag: "🇦🇺" },
  "australia-southeast2": { location: "Melbourne, Australia", flag: "🇦🇺" },
  "me-west1": { location: "Tel Aviv, Israel", flag: "🇮🇱" },
  "me-central1": { location: "Doha, Qatar", flag: "🇶🇦" },
  "me-central2": { location: "Dammam, Saudi Arabia", flag: "🇸🇦" },
  "africa-south1": { location: "Johannesburg, South Africa", flag: "🇿🇦" },
};

/**
 * Every public Google Cloud region, for region pickers. Derived from
 * REGION_INFO so a new region is one entry there. Keep in sync with
 * https://cloud.google.com/about/locations; services that are not in every
 * region (Cloud Run, Memorystore, ...) reject the rest with a clear error.
 */
export const GCP_REGIONS: RegionOption[] = Object.entries(REGION_INFO).map(([id, info]) => ({
  id,
  label: id,
  location: info.location,
  flag: info.flag,
}));

export function regionOption(id: string, label?: string): RegionOption {
  const regionSlug = id.replace(/-[a-z]$/, "");
  const info = REGION_INFO[regionSlug];
  return {
    id,
    label: label ?? id,
    ...(info ? { location: info.location, flag: info.flag } : {}),
  };
}

// Curated public image families: no API call needed, GCP resolves to latest
export const PUBLIC_IMAGES: ImageOption[] = [
  {
    id: "projects/debian-cloud/global/images/family/debian-13",
    label: "Debian 13 (Trixie)",
    category: "Debian",
    family: "debian-13",
  },
  {
    id: "projects/debian-cloud/global/images/family/debian-12",
    label: "Debian 12 (Bookworm)",
    category: "Debian",
    family: "debian-12",
  },
  {
    id: "projects/debian-cloud/global/images/family/debian-11",
    label: "Debian 11 (Bullseye)",
    category: "Debian",
    family: "debian-11",
  },
  {
    id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    label: "Ubuntu 24.04 LTS",
    category: "Ubuntu",
    family: "ubuntu-2404-lts-amd64",
  },
  {
    id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts",
    label: "Ubuntu 22.04 LTS",
    category: "Ubuntu",
    family: "ubuntu-2204-lts",
  },
  {
    id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2004-lts",
    label: "Ubuntu 20.04 LTS",
    category: "Ubuntu",
    family: "ubuntu-2004-lts",
  },
  {
    id: "projects/centos-cloud/global/images/family/centos-stream-9",
    label: "CentOS Stream 9",
    category: "CentOS",
    family: "centos-stream-9",
  },
  {
    id: "projects/rocky-linux-cloud/global/images/family/rocky-linux-9",
    label: "Rocky Linux 9",
    category: "Rocky Linux",
    family: "rocky-linux-9",
  },
  {
    id: "projects/rocky-linux-cloud/global/images/family/rocky-linux-8",
    label: "Rocky Linux 8",
    category: "Rocky Linux",
    family: "rocky-linux-8",
  },
  {
    id: "projects/windows-cloud/global/images/family/windows-2022",
    label: "Windows Server 2022",
    category: "Windows",
    family: "windows-2022",
  },
  {
    id: "projects/windows-cloud/global/images/family/windows-2019",
    label: "Windows Server 2019",
    category: "Windows",
    family: "windows-2019",
  },
];
