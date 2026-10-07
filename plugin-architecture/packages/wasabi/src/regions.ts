import type { RegionOption } from "@infrawrench/plugin-base";

/** "Service URLs for Wasabi's Storage Regions", docs.wasabi.com, updated 2026-03-06. */
export const WASABI_REGIONS: Array<RegionOption & { endpoint: string }> = [
  {
    id: "us-east-1",
    label: "us-east-1",
    location: "N. Virginia, USA",
    flag: "🇺🇸",
    endpoint: "s3.us-east-1.wasabisys.com",
  },
  {
    id: "us-east-2",
    label: "us-east-2",
    location: "N. Virginia, USA",
    flag: "🇺🇸",
    endpoint: "s3.us-east-2.wasabisys.com",
  },
  {
    id: "us-central-1",
    label: "us-central-1",
    location: "Texas, USA",
    flag: "🇺🇸",
    endpoint: "s3.us-central-1.wasabisys.com",
  },
  {
    id: "us-west-1",
    label: "us-west-1",
    location: "Oregon, USA",
    flag: "🇺🇸",
    endpoint: "s3.us-west-1.wasabisys.com",
  },
  {
    id: "us-west-2",
    label: "us-west-2",
    location: "San Jose, USA",
    flag: "🇺🇸",
    endpoint: "s3.us-west-2.wasabisys.com",
  },
  {
    id: "ca-central-1",
    label: "ca-central-1",
    location: "Toronto, Canada",
    flag: "🇨🇦",
    endpoint: "s3.ca-central-1.wasabisys.com",
  },
  {
    id: "eu-central-1",
    label: "eu-central-1",
    location: "Amsterdam, Netherlands",
    flag: "🇳🇱",
    endpoint: "s3.eu-central-1.wasabisys.com",
  },
  {
    id: "eu-central-2",
    label: "eu-central-2",
    location: "Frankfurt, Germany",
    flag: "🇩🇪",
    endpoint: "s3.eu-central-2.wasabisys.com",
  },
  {
    id: "eu-west-1",
    label: "eu-west-1",
    location: "London, United Kingdom",
    flag: "🇬🇧",
    endpoint: "s3.eu-west-1.wasabisys.com",
  },
  {
    id: "eu-west-2",
    label: "eu-west-2",
    location: "Paris, France",
    flag: "🇫🇷",
    endpoint: "s3.eu-west-2.wasabisys.com",
  },
  {
    id: "eu-west-3",
    label: "eu-west-3",
    location: "London, United Kingdom",
    flag: "🇬🇧",
    endpoint: "s3.eu-west-3.wasabisys.com",
  },
  {
    id: "eu-south-1",
    label: "eu-south-1",
    location: "Milan, Italy",
    flag: "🇮🇹",
    endpoint: "s3.eu-south-1.wasabisys.com",
  },
  {
    id: "ap-northeast-1",
    label: "ap-northeast-1",
    location: "Tokyo, Japan",
    flag: "🇯🇵",
    endpoint: "s3.ap-northeast-1.wasabisys.com",
  },
  {
    id: "ap-northeast-2",
    label: "ap-northeast-2",
    location: "Osaka, Japan",
    flag: "🇯🇵",
    endpoint: "s3.ap-northeast-2.wasabisys.com",
  },
  {
    id: "ap-southeast-1",
    label: "ap-southeast-1",
    location: "Singapore",
    flag: "🇸🇬",
    endpoint: "s3.ap-southeast-1.wasabisys.com",
  },
  {
    id: "ap-southeast-2",
    label: "ap-southeast-2",
    location: "Sydney, Australia",
    flag: "🇦🇺",
    endpoint: "s3.ap-southeast-2.wasabisys.com",
  },
];

/** Endpoint for a region; unknown regions follow the same pattern. */
export function endpointFor(region: string): string {
  const r = region || "us-east-1";
  return `https://${WASABI_REGIONS.find((x) => x.id === r)?.endpoint ?? `s3.${r}.wasabisys.com`}`;
}

/** GetBucketLocation's answer → region id; Wasabi returns "" for us-east-1. */
export function regionFromLocation(location: string): string {
  return location.trim() || "us-east-1";
}
