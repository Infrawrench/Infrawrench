/**
 * Grid carbon intensity, datacentre efficiency and processor power
 * coefficients.
 *
 * **These are published third-party figures, reproduced; not measured, and
 * not ours.** They are kept in one file, with their provenance beside them, so
 * nobody downstream has to wonder where a number came from and refreshing them
 * is one reviewable diff. Plugins declare *how to read* a resource (which field
 * is the region, which is the size); they never carry a coefficient.
 *
 * Units are **grams CO2e per kWh** throughout. Upstream files use metric tons
 * per kWh; the conversion happens once, here.
 *
 * A region absent from these tables produces **no estimate**, never a default.
 * A carbon figure computed against a guessed grid is worse than no figure: it
 * is a number somebody will put in a report.
 *
 * Two bases are in use, and every figure says which (`GridFigure.basis`):
 *
 * - `ccf`: the Cloud Carbon Footprint project's per-region tables for AWS, GCP
 *   and Azure (Apache-2.0), read from cloud-carbon-footprint at its April 2026
 *   HEAD. CCF sources US regions from EPA eGRID2023 at NERC-region level,
 *   Google's own published region figures for GCP, and carbonfootprint.com /
 *   EEA factors elsewhere. Reproduced verbatim, including its quirks (Zurich
 *   reads Germany's figure, Calgary the Canadian average).
 * - `ember-2024`: Ember's Yearly Electricity Data (2026 release), 2024
 *   lifecycle intensity of generation per country, as republished in Our World
 *   in Data's energy dataset (`carbon_intensity_elec`). Used for every
 *   provider CCF does not cover and for Azure regions CCF has no row for.
 *   Lifecycle figures run a little higher than CCF's combustion-only ones on
 *   hydro and nuclear grids; the difference is far smaller than the
 *   utilisation assumption.
 *
 * US locations outside the hyperscaler tables use CCF's own NERC-region
 * figures (`US_NERC`), so a Hetzner server in Ashburn and an EC2 instance in
 * us-east-1 read the same grid.
 *
 * Grid intensity is **location-based**: what the local grid emits, not what a
 * provider's renewable contracts offset. That is the CCF stance and the one a
 * like-for-like comparison across providers needs; several providers here
 * (Hetzner, OVHcloud, Scaleway) buy renewable power, and their market-based
 * figures would be lower.
 */

export type GridBasis = "ccf" | "ember-2024";

export interface GridFigure {
  /** Grams CO2e per kWh. */
  gPerKwh: number;
  basis: GridBasis;
  /** The grid the figure describes, as a reader would name it ("Germany"). */
  zone: string;
}

/** CCF's per-region tables, grams CO2e per kWh, verbatim. */
export const CCF_GRID_G_PER_KWH: Record<"aws" | "gcp" | "azure", Record<string, number>> = {
  aws: {
    "us-east-1": 365.1,
    "us-east-2": 376.1,
    "us-west-1": 298.7,
    "us-west-2": 298.7,
    "us-gov-east-1": 365.1,
    "us-gov-west-1": 298.7,
    "af-south-1": 757.4,
    "ap-east-1": 673.5,
    "ap-east-2": 641.4,
    "ap-south-1": 951.8,
    "ap-south-2": 951.8,
    "ap-northeast-1": 439.8,
    "ap-northeast-2": 477.4,
    "ap-northeast-3": 439.8,
    "ap-southeast-1": 494.5,
    "ap-southeast-2": 580.2,
    "ap-southeast-3": 717.7,
    "ap-southeast-4": 580.2,
    "ap-southeast-5": 620.5,
    "ap-southeast-6": 79.4,
    "ap-southeast-7": 508.2,
    "ca-central-1": 115.4,
    "ca-west-1": 115.4,
    "cn-north-1": 537.4,
    "cn-northwest-1": 537.4,
    "eu-central-1": 368.0,
    "eu-central-2": 368.0,
    "eu-west-1": 305.0,
    "eu-west-2": 305.0,
    "eu-west-3": 74.0,
    "eu-south-1": 297.0,
    "eu-south-2": 178.0,
    "eu-north-1": 8.0,
    "il-central-1": 539.8,
    "me-south-1": 505.5,
    "me-central-1": 365.2,
    "mx-central-1": 419.0,
    "sa-east-1": 64.0,
  },
  gcp: {
    "us-central1": 413.0,
    "us-central2": 372.0,
    "us-east1": 576.0,
    "us-east4": 323.0,
    "us-east5": 323.0,
    "us-west1": 79.0,
    "us-west2": 169.0,
    "us-west3": 555.0,
    "us-west4": 357.0,
    "us-south1": 303.0,
    "asia-east1": 439.0,
    "asia-east2": 505.0,
    "asia-northeast1": 453.0,
    "asia-northeast2": 296.0,
    "asia-northeast3": 357.0,
    "asia-south1": 679.0,
    "asia-south2": 532.0,
    "asia-southeast1": 367.0,
    "asia-southeast2": 561.0,
    "australia-southeast1": 498.0,
    "australia-southeast2": 454.0,
    "europe-central2": 643.0,
    "europe-north1": 39.0,
    "europe-southwest1": 89.0,
    "europe-west1": 103.0,
    "europe-west2": 106.0,
    "europe-west3": 276.0,
    "europe-west4": 209.0,
    "europe-west6": 15.0,
    "europe-west8": 202.0,
    "europe-west9": 16.0,
    "europe-west10": 276.0,
    "europe-west12": 202.0,
    "northamerica-northeast1": 5.0,
    "northamerica-northeast2": 59.0,
    "southamerica-east1": 67.0,
    "southamerica-west1": 238.0,
    "africa-south1": 657.0,
    "europe-north2": 3.0,
    "me-central1": 366.0,
    "me-central2": 382.0,
    "me-west1": 434.0,
    "northamerica-south1": 305.0,
    "us-east2": 340.0,
  },
  azure: {
    southafrica: 900.6,
    southafricanorth: 900.6,
    southafricawest: 900.6,
    australia: 790.0,
    australiacentral: 790.0,
    australiacentral2: 790.0,
    australiaeast: 790.0,
    australiasoutheast: 960.0,
    apeast: 710.0,
    apsoutheast: 408.0,
    japaneast: 465.8,
    japanwest: 465.8,
    japan: 465.8,
    korea: 415.6,
    koreacentral: 415.6,
    koreasouth: 415.6,
    asia: 564.7,
    asiapacific: 564.7,
    eastasia: 710.0,
    southeastasia: 408.0,
    india: 708.2,
    centralindia: 708.2,
    jioindiacentral: 708.2,
    jioindiawest: 708.2,
    southindia: 708.2,
    westindia: 708.2,
    northeurope: 278.6,
    westeurope: 328.4,
    francecentral: 51.3,
    francesouth: 51.3,
    france: 51.3,
    swedencentral: 5.7,
    switzerland: 11.5,
    switzerlandnorth: 11.5,
    switzerlandwest: 11.5,
    uksouth: 225.0,
    ukwest: 225.0,
    uk: 225.0,
    germany: 338.7,
    germanynorth: 338.7,
    germanywestcentral: 338.7,
    norway: 7.6,
    norwayeast: 7.6,
    norwaywest: 7.6,
    uae: 404.1,
    uaecentral: 404.1,
    uaenorth: 404.1,
    canada: 120.0,
    canadacentral: 120.0,
    canadaeast: 120.0,
    centralus: 391.0,
    unitedstates: 391.0,
    eastus: 365.1,
    eastus2: 365.1,
    eastus3: 365.1,
    usnorth: 376.1,
    northcentralus: 376.1,
    southcentralus: 334.2,
    westcentralus: 298.7,
    westus: 298.7,
    westus2: 298.7,
    westus3: 298.7,
    brazil: 61.7,
    brazilsouth: 61.7,
    brazilsoutheast: 61.7,
  },
};

/**
 * CCF's US NERC-region figures (EPA eGRID2023), grams CO2e per kWh. These are
 * the values CCF's AWS and Azure US regions resolve to.
 */
const US_NERC: Record<string, number> = {
  RFC: 376.1,
  SERC: 365.1,
  WECC: 298.7,
  TRE: 334.2,
  MRO: 391.0,
};

/** Ember 2024 lifecycle intensity of generation by country, g CO2e/kWh. */
const EMBER_2024: Record<string, { gPerKwh: number; name: string }> = {
  AE: { gPerKwh: 467.5, name: "United Arab Emirates" },
  AR: { gPerKwh: 344.8, name: "Argentina" },
  AU: { gPerKwh: 553.8, name: "Australia" },
  BR: { gPerKwh: 106.1, name: "Brazil" },
  CA: { gPerKwh: 185.4, name: "Canada" },
  CL: { gPerKwh: 259.9, name: "Chile" },
  CO: { gPerKwh: 298.3, name: "Colombia" },
  DE: { gPerKwh: 336.4, name: "Germany" },
  ES: { gPerKwh: 146.2, name: "Spain" },
  FI: { gPerKwh: 66.6, name: "Finland" },
  FR: { gPerKwh: 40.5, name: "France" },
  GB: { gPerKwh: 216.5, name: "United Kingdom" },
  HK: { gPerKwh: 675.5, name: "Hong Kong" },
  IL: { gPerKwh: 540.6, name: "Israel" },
  IN: { gPerKwh: 705.4, name: "India" },
  IT: { gPerKwh: 281.4, name: "Italy" },
  JP: { gPerKwh: 483.4, name: "Japan" },
  MX: { gPerKwh: 483.1, name: "Mexico" },
  NL: { gPerKwh: 250.7, name: "Netherlands" },
  NZ: { gPerKwh: 112.0, name: "New Zealand" },
  PL: { gPerKwh: 608.2, name: "Poland" },
  QA: { gPerKwh: 581.7, name: "Qatar" },
  RO: { gPerKwh: 251.3, name: "Romania" },
  SE: { gPerKwh: 34.9, name: "Sweden" },
  SG: { gPerKwh: 498.7, name: "Singapore" },
  ZA: { gPerKwh: 717.4, name: "South Africa" },
};

/**
 * A location outside the hyperscaler tables: an Ember country code, or
 * `US-<NERC>` for a US site.
 */
type Zone = keyof typeof EMBER_2024 | `US-${keyof typeof US_NERC & string}`;

/**
 * Provider location → grid zone, for providers CCF does not cover.
 *
 * Mapped from where the datacentre physically is, not what the region is
 * called: DigitalOcean's `nyc1` and `nyc3` are in North Bergen and Clifton,
 * New Jersey (RFC), and OVHcloud's `DE1` is in Limburg. A code whose site we
 * could not place (DigitalOcean `nyc2`, in Manhattan, whose NPCC grid has no
 * CCF figure) is left out and produces no estimate.
 */
export const PROVIDER_REGION_ZONES: Record<string, Record<string, Zone>> = {
  digitalocean: {
    nyc1: "US-RFC",
    nyc3: "US-RFC",
    sfo1: "US-WECC",
    sfo2: "US-WECC",
    sfo3: "US-WECC",
    atl1: "US-SERC",
    ric1: "US-SERC",
    tor1: "CA",
    ams2: "NL",
    ams3: "NL",
    lon1: "GB",
    fra1: "DE",
    sgp1: "SG",
    blr1: "IN",
    syd1: "AU",
  },
  hetzner: {
    fsn1: "DE",
    nbg1: "DE",
    hel1: "FI",
    ash: "US-SERC",
    hil: "US-WECC",
    sin: "SG",
  },
  // Fly consolidated to 18 regions in September 2025; the retired codes stay
  // mapped so a machine synced before the move still resolves.
  fly: {
    iad: "US-SERC",
    ewr: "US-RFC",
    ord: "US-RFC",
    dfw: "US-TRE",
    lax: "US-WECC",
    sjc: "US-WECC",
    sea: "US-WECC",
    den: "US-WECC",
    phx: "US-WECC",
    atl: "US-SERC",
    mia: "US-SERC",
    yyz: "CA",
    yul: "CA",
    gru: "BR",
    gig: "BR",
    scl: "CL",
    eze: "AR",
    bog: "CO",
    gdl: "MX",
    qro: "MX",
    ams: "NL",
    cdg: "FR",
    fra: "DE",
    lhr: "GB",
    arn: "SE",
    waw: "PL",
    mad: "ES",
    otp: "RO",
    jnb: "ZA",
    bom: "IN",
    sin: "SG",
    hkg: "HK",
    nrt: "JP",
    syd: "AU",
  },
  scaleway: {
    "fr-par": "FR",
    "nl-ams": "NL",
    "pl-waw": "PL",
    "it-mil": "IT",
  },
  // Akamai Cloud (Linode) core regions, placed by the city each region id
  // names in `GET /v4/regions` (2026-10). `us-iad`/`us-iad-2` are the
  // Washington DC metro (Ashburn, SERC, matching DigitalOcean `ric1` and
  // Hetzner `ash`); `us-east` is Newark, New Jersey (RFC). Jakarta (`id-cgk`)
  // is left out: Indonesia has no Ember 2024 figure in this table.
  linode: {
    "us-east": "US-RFC",
    "us-central": "US-TRE",
    "us-west": "US-WECC",
    "us-southeast": "US-SERC",
    "us-iad": "US-SERC",
    "us-iad-2": "US-SERC",
    "us-ord": "US-RFC",
    "us-sea": "US-WECC",
    "us-mia": "US-SERC",
    "us-lax": "US-WECC",
    "ca-central": "CA",
    "eu-west": "GB",
    "gb-lon": "GB",
    "eu-central": "DE",
    "de-fra-2": "DE",
    "fr-par": "FR",
    "fr-par-2": "FR",
    "se-sto": "SE",
    "es-mad": "ES",
    "it-mil": "IT",
    "nl-ams": "NL",
    "ap-south": "SG",
    "sg-sin-2": "SG",
    "ap-northeast": "JP",
    "jp-tyo-3": "JP",
    "jp-osa": "JP",
    "ap-west": "IN",
    "in-bom-2": "IN",
    "in-maa": "IN",
    "ap-southeast": "AU",
    "au-mel": "AU",
    "br-gru": "BR",
  },
  // Keyed on the site prefix; `normalizeCarbonRegion` folds GRA11 → gra.
  ovh: {
    gra: "FR",
    sbg: "FR",
    rbx: "FR",
    "eu-west-par": "FR",
    de: "DE",
    uk: "GB",
    waw: "PL",
    bhs: "CA",
    "us-east-va": "US-SERC",
    "us-west-or": "US-WECC",
    sgp: "SG",
    syd: "AU",
    ynm: "IN",
    "eu-south-mil": "IT",
  },
};

/**
 * Azure regions CCF has no row for, filled from Ember by country rather than
 * left to CCF's "unknown" average (which this module never uses).
 */
const AZURE_EMBER_FILL: Record<string, Zone> = {
  polandcentral: "PL",
  italynorth: "IT",
  qatarcentral: "QA",
  israelcentral: "IL",
  spaincentral: "ES",
  mexicocentral: "MX",
  newzealandnorth: "NZ",
};

const ZONE_NAMES: Record<string, string> = {
  "US-RFC": "US (RFC)",
  "US-SERC": "US (SERC)",
  "US-WECC": "US (WECC)",
  "US-TRE": "US (Texas)",
  "US-MRO": "US (MRO)",
};

function zoneFigure(zone: Zone): GridFigure {
  if (zone.startsWith("US-")) {
    // CCF's NERC figures are what its own AWS/Azure US rows resolve to.
    return { gPerKwh: US_NERC[zone.slice(3)]!, basis: "ccf", zone: ZONE_NAMES[zone] ?? zone };
  }
  const country = EMBER_2024[zone as keyof typeof EMBER_2024]!;
  return { gPerKwh: country.gPerKwh, basis: "ember-2024", zone: country.name };
}

/** Every grid zone a provider table can resolve to, for the plausibility test. */
export function allGridFigures(): GridFigure[] {
  const out: GridFigure[] = [];
  for (const [grid, table] of Object.entries(CCF_GRID_G_PER_KWH)) {
    for (const [region, gPerKwh] of Object.entries(table)) {
      out.push({ gPerKwh, basis: "ccf", zone: `${grid} ${region}` });
    }
  }
  for (const table of [...Object.values(PROVIDER_REGION_ZONES), AZURE_EMBER_FILL]) {
    for (const zone of Object.values(table)) out.push(zoneFigure(zone));
  }
  return out;
}

/**
 * Power Usage Effectiveness: total datacentre power per watt delivered to a
 * server. 1.0 would be a datacentre with no cooling or distribution losses,
 * which does not exist.
 *
 * - AWS 1.135, GCP 1.1 (fleet; per-region trailing figures below), Azure
 *   1.185: CCF's constants.
 * - Hetzner 1.13: Hetzner's published average for its own parks
 *   (Falkenstein, Nuremberg, Helsinki). Its Ashburn, Hillsboro and Singapore
 *   sites are colocation and read `COLOCATION_PUE`.
 * - OVHcloud 1.24: group average, FY2025 KPIs.
 * - Scaleway: per availability zone from Scaleway's environmental-footprint
 *   calculation reference (validated June 2025); 1.375 fleet average for a
 *   zone it does not list.
 * - DigitalOcean, Fly and Linode publish no figure and run in colocation, so
 *   they read `COLOCATION_PUE`.
 */
export const PROVIDER_PUE: Record<string, number> = {
  aws: 1.135,
  gcp: 1.1,
  azure: 1.185,
  hetzner: 1.13,
  ovh: 1.24,
  scaleway: 1.375,
  digitalocean: 1.54,
  fly: 1.54,
  linode: 1.54,
};

/**
 * Uptime Institute Global Data Center Survey 2025: average PUE 1.54, flat for
 * six years. The honest figure for a provider that runs in other people's
 * buildings and publishes none of its own.
 */
export const COLOCATION_PUE = 1.54;

const REGIONAL_PUE: Record<string, Record<string, number>> = {
  // CCF's trailing-twelve-month figures from Google's own reporting.
  gcp: {
    "us-east4": 1.08,
    "us-central1": 1.11,
    "us-central2": 1.11,
    "europe-west1": 1.09,
    "europe-west4": 1.07,
    "europe-north1": 1.09,
    "asia-east1": 1.12,
    "asia-southeast1": 1.13,
  },
  hetzner: { ash: COLOCATION_PUE, hil: COLOCATION_PUE, sin: COLOCATION_PUE },
  scaleway: {
    "fr-par-1": 1.45,
    "fr-par-2": 1.16,
    "fr-par-3": 1.44,
    "nl-ams-1": 1.38,
    "nl-ams-2": 1.4,
    "nl-ams-3": 1.2,
    "pl-waw-1": 1.5,
    "pl-waw-2": 1.24,
    "pl-waw-3": 1.5,
  },
};

/**
 * Watts per vCPU at idle and at full load, when the processor's
 * microarchitecture is unknown, which it always is here, because the inventory
 * records an instance type and not a CPU model.
 *
 * AWS, GCP and Azure are CCF's per-provider fallbacks as its code computes them
 * (GCP uses the median, the others the average). CCF has no constant for other
 * providers; its one non-hyperscaler (Alibaba) reuses the AWS average, and so
 * does every provider here.
 */
export const VCPU_WATTS: Record<string, { min: number; max: number }> = {
  aws: { min: 0.74, max: 3.5 },
  gcp: { min: 0.68, max: 4.11 },
  azure: { min: 0.74, max: 3.54 },
};
export const DEFAULT_VCPU_WATTS = { min: 0.74, max: 3.5 } as const;

/**
 * Assumed average CPU utilisation, as a fraction.
 *
 * This is the single largest source of error in the estimate and it is a
 * **constant**, because the product does not collect per-resource CPU history
 * for every provider and a figure derived from the few that do report it would
 * be quietly inconsistent across an estate. 50% is the upstream project's own
 * default for the same reason.
 */
export const ASSUMED_CPU_UTILIZATION = 0.5;

/** Grid tables this module can resolve a region against. */
export const CARBON_SUPPORTED_GRIDS = [
  ...Object.keys(CCF_GRID_G_PER_KWH),
  ...Object.keys(PROVIDER_REGION_ZONES),
];

/** Tried in order for `grid: "auto"`. Region naming schemes do not collide. */
const AUTO_GRIDS = ["aws", "gcp", "azure"] as const;

/**
 * Normalize a provider location string for lookup in `grid`'s table.
 *
 * Providers report the same place several ways: Azure `East US` and
 * `eastus`, a GCP zone `us-central1-a` for region `us-central1`, an AWS
 * availability zone `us-east-1a`, a Hetzner datacenter `fsn1-dc14`, a
 * Scaleway zone `fr-par-1` for region `fr-par`, an OVH region `GRA11` at site
 * `gra`. Each is folded onto the key its table uses.
 */
export function normalizeCarbonRegion(grid: string, region: string): string {
  const r = region.trim().toLowerCase();
  switch (grid) {
    case "azure":
      return r.replace(/[\s_-]/g, "");
    case "gcp":
      return r.replace(/^([a-z]+-[a-z]+\d+)-[a-z]$/, "$1");
    case "aws":
      return r.replace(/^([a-z]{2}(?:-gov)?-[a-z]+-\d)[a-z]$/, "$1");
    case "hetzner":
      return r.replace(/-dc\d+$/, "");
    case "scaleway":
      return r.replace(/^([a-z]{2}-[a-z]{3})-\d$/, "$1");
    case "ovh":
      return r.replace(/-?\d+$/, "");
    default:
      return r;
  }
}

function lookup(grid: string, region: string): GridFigure | null {
  const key = normalizeCarbonRegion(grid, region);
  const ccf = CCF_GRID_G_PER_KWH[grid as keyof typeof CCF_GRID_G_PER_KWH];
  if (ccf) {
    const value = ccf[key];
    if (value !== undefined) return { gPerKwh: value, basis: "ccf", zone: `${grid} ${key}` };
    if (grid === "azure" && AZURE_EMBER_FILL[key]) return zoneFigure(AZURE_EMBER_FILL[key]);
    return null;
  }
  const zone = PROVIDER_REGION_ZONES[grid]?.[key];
  return zone ? zoneFigure(zone) : null;
}

/**
 * Which table a region resolves in. `"auto"` tries the hyperscalers in turn,
 * after stripping a `aws-` / `gcp-` / `azure-` prefix (Neon's `aws-us-east-1`).
 */
export function resolveCarbonGrid(
  grid: string,
  region: string | null,
): { grid: string; figure: GridFigure } | null {
  if (!region) return null;
  if (grid !== "auto") {
    const figure = lookup(grid, region);
    return figure ? { grid, figure } : null;
  }
  const prefixed = /^(aws|gcp|azure)-(.+)$/i.exec(region.trim());
  if (prefixed) {
    const g = prefixed[1]!.toLowerCase();
    const figure = lookup(g, prefixed[2]!);
    return figure ? { grid: g, figure } : null;
  }
  for (const g of AUTO_GRIDS) {
    const figure = lookup(g, region);
    if (figure) return { grid: g, figure };
  }
  return null;
}

/** Grams CO2e per kWh for a region, or null when it is not in any table. */
export function gridIntensityFor(grid: string, region: string | null): number | null {
  return resolveCarbonGrid(grid, region)?.figure.gPerKwh ?? null;
}

/** Whether this module has any table for `grid` at all. */
export function isSupportedCarbonGrid(grid: string): boolean {
  return grid === "auto" || CARBON_SUPPORTED_GRIDS.includes(grid);
}

/** PUE for a location, falling back to the provider's fleet figure. */
export function pueFor(grid: string, region: string | null): number {
  if (region) {
    const regional = REGIONAL_PUE[grid];
    if (regional) {
      const r = region.trim().toLowerCase();
      const hit = regional[r] ?? regional[normalizeCarbonRegion(grid, r)];
      if (hit !== undefined) return hit;
    }
  }
  return PROVIDER_PUE[grid] ?? COLOCATION_PUE;
}

/** Watts per vCPU at idle and full load for a grid's provider. */
export function vcpuWattsFor(grid: string): { min: number; max: number } {
  return VCPU_WATTS[grid] ?? DEFAULT_VCPU_WATTS;
}
