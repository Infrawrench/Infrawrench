import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * Public commercial regions, from Alibaba's per-product endpoint metadata
 * (`api.alibabacloud.com/meta/v1/products/{Product}/endpoints.json`, 2026-10).
 * Finance, government and dedicated-industry clouds are left out (they need
 * a separate contract), as are Sydney (`ap-southeast-2`) and Mumbai
 * (`ap-south-1`), which the metadata marks closed. `label` is the English name
 * the international console and the status page use.
 */
export interface AliRegion {
  id: string;
  label: string;
  location: string;
  flag: string;
}

export const ALI_REGIONS: AliRegion[] = [
  { id: "cn-hangzhou", label: "China (Hangzhou)", location: "Hangzhou, China", flag: "🇨🇳" },
  { id: "cn-shanghai", label: "China (Shanghai)", location: "Shanghai, China", flag: "🇨🇳" },
  {
    id: "cn-nanjing",
    label: "China (Nanjing - Local Region)",
    location: "Nanjing, China",
    flag: "🇨🇳",
  },
  {
    id: "cn-fuzhou",
    label: "China (Fuzhou - Local Region)",
    location: "Fuzhou, China",
    flag: "🇨🇳",
  },
  {
    id: "cn-wuhan-lr",
    label: "China (Wuhan - Local Region)",
    location: "Wuhan, China",
    flag: "🇨🇳",
  },
  { id: "cn-qingdao", label: "China (Qingdao)", location: "Qingdao, China", flag: "🇨🇳" },
  { id: "cn-beijing", label: "China (Beijing)", location: "Beijing, China", flag: "🇨🇳" },
  {
    id: "cn-zhangjiakou",
    label: "China (Zhangjiakou)",
    location: "Zhangjiakou, China",
    flag: "🇨🇳",
  },
  { id: "cn-huhehaote", label: "China (Hohhot)", location: "Hohhot, China", flag: "🇨🇳" },
  { id: "cn-wulanchabu", label: "China (Ulanqab)", location: "Ulanqab, China", flag: "🇨🇳" },
  { id: "cn-shenzhen", label: "China (Shenzhen)", location: "Shenzhen, China", flag: "🇨🇳" },
  { id: "cn-heyuan", label: "China (Heyuan)", location: "Heyuan, China", flag: "🇨🇳" },
  { id: "cn-guangzhou", label: "China (Guangzhou)", location: "Guangzhou, China", flag: "🇨🇳" },
  { id: "cn-chengdu", label: "China (Chengdu)", location: "Chengdu, China", flag: "🇨🇳" },
  { id: "cn-zhongwei", label: "China (Zhongwei)", location: "Zhongwei, China", flag: "🇨🇳" },
  { id: "cn-hongkong", label: "China (Hong Kong)", location: "Hong Kong", flag: "🇭🇰" },
  { id: "ap-northeast-1", label: "Japan (Tokyo)", location: "Tokyo, Japan", flag: "🇯🇵" },
  {
    id: "ap-northeast-2",
    label: "South Korea (Seoul)",
    location: "Seoul, South Korea",
    flag: "🇰🇷",
  },
  { id: "ap-southeast-1", label: "Singapore", location: "Singapore", flag: "🇸🇬" },
  {
    id: "ap-southeast-3",
    label: "Malaysia (Kuala Lumpur)",
    location: "Kuala Lumpur, Malaysia",
    flag: "🇲🇾",
  },
  { id: "ap-southeast-8", label: "Malaysia (Johor)", location: "Johor, Malaysia", flag: "🇲🇾" },
  {
    id: "ap-southeast-5",
    label: "Indonesia (Jakarta)",
    location: "Jakarta, Indonesia",
    flag: "🇮🇩",
  },
  {
    id: "ap-southeast-6",
    label: "Philippines (Manila)",
    location: "Manila, Philippines",
    flag: "🇵🇭",
  },
  { id: "ap-southeast-7", label: "Thailand (Bangkok)", location: "Bangkok, Thailand", flag: "🇹🇭" },
  { id: "us-east-1", label: "US (Virginia)", location: "Virginia, USA", flag: "🇺🇸" },
  { id: "us-west-1", label: "US (Silicon Valley)", location: "Silicon Valley, USA", flag: "🇺🇸" },
  { id: "us-southeast-1", label: "US (Atlanta)", location: "Atlanta, USA", flag: "🇺🇸" },
  { id: "na-south-1", label: "Mexico", location: "Querétaro, Mexico", flag: "🇲🇽" },
  { id: "sa-east-1", label: "Brazil (Sao Paulo)", location: "São Paulo, Brazil", flag: "🇧🇷" },
  { id: "eu-west-1", label: "UK (London)", location: "London, UK", flag: "🇬🇧" },
  { id: "eu-central-1", label: "Germany (Frankfurt)", location: "Frankfurt, Germany", flag: "🇩🇪" },
  { id: "eu-west-2", label: "France (Paris)", location: "Paris, France", flag: "🇫🇷" },
  {
    id: "eu-west-3",
    label: "Netherlands (Amsterdam)",
    location: "Amsterdam, Netherlands",
    flag: "🇳🇱",
  },
  { id: "me-east-1", label: "UAE (Dubai)", location: "Dubai, UAE", flag: "🇦🇪" },
  {
    id: "me-central-1",
    label: "Saudi Arabia (Riyadh)",
    location: "Riyadh, Saudi Arabia",
    flag: "🇸🇦",
  },
];

export const DEFAULT_REGION = "ap-southeast-1";

export const HOME_REGION_OPTIONS: CredentialFieldRegion[] = ALI_REGIONS.map((r) => ({
  id: r.id,
  label: r.label,
  location: r.location,
  flag: r.flag,
}));

export function regionInfo(id: string): AliRegion | undefined {
  return ALI_REGIONS.find((r) => r.id === id);
}

/**
 * Map a display name ("Indonesia (Jakarta)", "Singapore", "China (Hangzhou)")
 * found in status-page titles or bill rows back to a region id.
 */
export function regionIdForLabel(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (ALI_REGIONS.some((r) => r.id === lower)) return lower;
  // Longest label first so "Malaysia (Kuala Lumpur)" wins over a bare city.
  const sorted = [...ALI_REGIONS].sort((a, b) => b.label.length - a.label.length);
  for (const r of sorted) {
    if (lower.includes(r.label.toLowerCase())) return r.id;
  }
  for (const r of sorted) {
    const city = /\(([^)]+)\)/.exec(r.label)?.[1];
    if (city && lower.includes(city.toLowerCase())) return r.id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Products and their endpoints

export type AliProduct =
  | "ecs"
  | "vpc"
  | "slb"
  | "alb"
  | "rds"
  | "redis"
  | "cs"
  | "fc"
  | "cms"
  | "sts"
  | "alidns"
  | "bss"
  | "ram"
  | "quotas";

export const API_VERSIONS: Record<AliProduct, string> = {
  ecs: "2014-05-26",
  vpc: "2016-04-28",
  slb: "2014-05-15",
  alb: "2020-06-16",
  rds: "2014-08-15",
  redis: "2015-01-01",
  cs: "2015-12-15",
  fc: "2023-03-30",
  cms: "2019-01-01",
  sts: "2015-04-01",
  alidns: "2015-01-09",
  bss: "2017-12-14",
  ram: "2015-05-01",
  quotas: "2020-05-10",
};

const PUBLIC = ALI_REGIONS.map((r) => r.id);
const without = (...ids: string[]) => new Set(PUBLIC.filter((r) => !ids.includes(r)));

/**
 * Which public regions each regional product is served in, per the endpoint
 * metadata. A region missing here is skipped by the listers rather than
 * resolved to a host that does not exist.
 */
const PRODUCT_REGIONS: Partial<Record<AliProduct, Set<string>>> = {
  ecs: new Set(PUBLIC),
  vpc: new Set(PUBLIC),
  slb: without("sa-east-1", "eu-west-3"),
  alb: without("cn-huhehaote", "eu-west-3"),
  rds: without("sa-east-1", "eu-west-3"),
  redis: without("sa-east-1", "eu-west-3", "eu-west-2", "ap-southeast-8", "cn-zhongwei"),
  cs: without("ap-southeast-6", "sa-east-1", "eu-west-3"),
  fc: new Set([
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-southeast-1",
    "ap-southeast-3",
    "ap-southeast-5",
    "ap-southeast-7",
    "cn-beijing",
    "cn-chengdu",
    "cn-hangzhou",
    "cn-hongkong",
    "cn-huhehaote",
    "cn-qingdao",
    "cn-shanghai",
    "cn-shenzhen",
    "cn-wulanchabu",
    "cn-zhangjiakou",
    "eu-central-1",
    "eu-west-1",
    "me-central-1",
    "us-east-1",
    "us-west-1",
  ]),
  cms: without("sa-east-1", "eu-west-3"),
  sts: without("ap-southeast-6", "us-southeast-1", "eu-west-3"),
};

export function productInRegion(product: AliProduct, region: string): boolean {
  const set = PRODUCT_REGIONS[product];
  return set ? set.has(region) : true;
}

/** OSS regions (public), from the OSS endpoint metadata. */
export const OSS_REGIONS = new Set(
  PUBLIC.filter(
    (r) =>
      ![
        "cn-zhongwei",
        "ap-southeast-8",
        "us-southeast-1",
        "na-south-1",
        "sa-east-1",
        "eu-west-2",
        "eu-west-3",
        "me-central-1",
      ].includes(r),
  ),
);

/** The API host for a product in a region. */
export function endpointFor(product: AliProduct, region: string): string {
  switch (product) {
    case "alidns":
      return "alidns.aliyuncs.com";
    case "bss":
      // The international site's BSS OpenAPI lives in Singapore for every region.
      return "business.ap-southeast-1.aliyuncs.com";
    case "ram":
      return "ram.aliyuncs.com";
    case "quotas":
      return "quotas.aliyuncs.com";
    case "redis":
      return `r-kvstore.${region}.aliyuncs.com`;
    case "cms":
      return `metrics.${region}.aliyuncs.com`;
    case "fc":
      return region === "me-central-1"
        ? "me-central-1.fc.aliyuncs.com"
        : `fcv3.${region}.aliyuncs.com`;
    default:
      return `${product}.${region}.aliyuncs.com`;
  }
}

/** OSS endpoint for a region (`oss-<region>.aliyuncs.com`). */
export function ossEndpoint(region: string): string {
  return `oss-${region}.aliyuncs.com`;
}
