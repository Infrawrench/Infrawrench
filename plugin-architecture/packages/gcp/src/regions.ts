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

export const GCP_REGIONS: RegionOption[] = [
  { id: "us-central1", label: "us-central1", location: "Iowa, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  {
    id: "us-east1",
    label: "us-east1",
    location: "S. Carolina, USA",
    flag: "\u{1F1FA}\u{1F1F8}",
  },
  {
    id: "us-east4",
    label: "us-east4",
    location: "N. Virginia, USA",
    flag: "\u{1F1FA}\u{1F1F8}",
  },
  { id: "us-west1", label: "us-west1", location: "Oregon, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "us-west2", label: "us-west2", location: "Los Angeles, USA", flag: "\u{1F1FA}\u{1F1F8}" },
  {
    id: "northamerica-northeast1",
    label: "northamerica-northeast1",
    location: "Montréal, Canada",
    flag: "\u{1F1E8}\u{1F1E6}",
  },
  {
    id: "southamerica-east1",
    label: "southamerica-east1",
    location: "São Paulo, Brazil",
    flag: "\u{1F1E7}\u{1F1F7}",
  },
  {
    id: "europe-west1",
    label: "europe-west1",
    location: "St. Ghislain, Belgium",
    flag: "\u{1F1E7}\u{1F1EA}",
  },
  {
    id: "europe-west2",
    label: "europe-west2",
    location: "London, UK",
    flag: "\u{1F1EC}\u{1F1E7}",
  },
  {
    id: "europe-west3",
    label: "europe-west3",
    location: "Frankfurt, Germany",
    flag: "\u{1F1E9}\u{1F1EA}",
  },
  {
    id: "europe-west4",
    label: "europe-west4",
    location: "Eemshaven, Netherlands",
    flag: "\u{1F1F3}\u{1F1F1}",
  },
  {
    id: "europe-west6",
    label: "europe-west6",
    location: "Zurich, Switzerland",
    flag: "\u{1F1E8}\u{1F1ED}",
  },
  {
    id: "europe-north1",
    label: "europe-north1",
    location: "Hamina, Finland",
    flag: "\u{1F1EB}\u{1F1EE}",
  },
  { id: "asia-east1", label: "asia-east1", location: "Taiwan", flag: "\u{1F1F9}\u{1F1FC}" },
  { id: "asia-east2", label: "asia-east2", location: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}" },
  {
    id: "asia-northeast1",
    label: "asia-northeast1",
    location: "Tokyo, Japan",
    flag: "\u{1F1EF}\u{1F1F5}",
  },
  {
    id: "asia-northeast2",
    label: "asia-northeast2",
    location: "Osaka, Japan",
    flag: "\u{1F1EF}\u{1F1F5}",
  },
  {
    id: "asia-northeast3",
    label: "asia-northeast3",
    location: "Seoul, South Korea",
    flag: "\u{1F1F0}\u{1F1F7}",
  },
  {
    id: "asia-south1",
    label: "asia-south1",
    location: "Mumbai, India",
    flag: "\u{1F1EE}\u{1F1F3}",
  },
  {
    id: "asia-southeast1",
    label: "asia-southeast1",
    location: "Singapore",
    flag: "\u{1F1F8}\u{1F1EC}",
  },
  {
    id: "asia-southeast2",
    label: "asia-southeast2",
    location: "Jakarta, Indonesia",
    flag: "\u{1F1EE}\u{1F1E9}",
  },
  {
    id: "australia-southeast1",
    label: "australia-southeast1",
    location: "Sydney, Australia",
    flag: "\u{1F1E6}\u{1F1FA}",
  },
];

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
  "northamerica-south1": { location: "Dallas, Texas, USA", flag: "🇺🇸" },
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
  "australia-southeast1": { location: "Sydney, Australia", flag: "🇦🇺" },
  "australia-southeast2": { location: "Melbourne, Australia", flag: "🇦🇺" },
  "me-west1": { location: "Tel Aviv, Israel", flag: "🇮🇱" },
  "me-central1": { location: "Doha, Qatar", flag: "🇶🇦" },
  "me-central2": { location: "Dammam, Saudi Arabia", flag: "🇸🇦" },
  "africa-south1": { location: "Johannesburg, South Africa", flag: "🇿🇦" },
};

export function regionOption(id: string, label?: string): RegionOption {
  const regionSlug = id.replace(/-[a-z]$/, "");
  const info = REGION_INFO[regionSlug];
  return {
    id,
    label: label ?? id,
    ...(info ? { location: info.location, flag: info.flag } : {}),
  };
}

// Curated public image families — no API call needed, GCP resolves to latest
export const PUBLIC_IMAGES: ImageOption[] = [
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
