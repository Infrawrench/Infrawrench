/**
 * Grid carbon intensity and datacentre efficiency coefficients.
 *
 * **These are published third-party figures, reproduced — not measured, and not
 * ours.** Every number here comes from the Cloud Carbon Footprint coefficients
 * project (Apache-2.0), which in turn sources them from government and
 * grid-operator publications. They are kept in one file, with their provenance
 * beside them, precisely so that nobody downstream has to wonder where a number
 * came from, and so that refreshing them is one reviewable diff.
 *
 * Source: https://github.com/cloud-carbon-footprint/cloud-carbon-coefficients
 * Vintage: the 2024 coefficient set, read August 2026.
 *
 * Units are **grams CO2e per kWh** throughout. The upstream files use metric
 * tons per kWh for AWS and GCP and kilograms per kWh for Azure; the conversion
 * was done once, here, rather than at three call sites.
 *
 * A region absent from these tables produces **no estimate**, never a default.
 * A carbon figure computed against a guessed grid is worse than no figure: it
 * is a number somebody will put in a report.
 */

/** Grams CO2e per kWh, by provider region. */
export const GRID_INTENSITY_G_PER_KWH: Record<string, Record<string, number>> = {
  aws: {
    "us-east-1": 415.8,
    "us-east-2": 440.2,
    "us-west-1": 350.9,
    "us-west-2": 350.9,
    "us-gov-east-1": 415.8,
    "us-gov-west-1": 350.9,
    "af-south-1": 928.0,
    "ap-east-1": 810.0,
    "ap-south-1": 708.0,
    "ap-northeast-1": 506.0,
    "ap-northeast-2": 500.0,
    "ap-northeast-3": 506.0,
    "ap-southeast-1": 408.5,
    "ap-southeast-2": 790.0,
    "ca-central-1": 130.0,
    "cn-north-1": 555.0,
    "cn-northwest-1": 555.0,
    "eu-central-1": 338.0,
    "eu-west-1": 316.0,
    "eu-west-2": 228.0,
    "eu-west-3": 52.0,
    "eu-south-1": 233.0,
    "eu-north-1": 8.0,
    "me-south-1": 732.0,
    "sa-east-1": 74.0,
  },
  gcp: {
    "us-central1": 479.0,
    "us-east1": 500.0,
    "us-east4": 383.0,
    "us-west1": 117.0,
    "us-west2": 248.0,
    "us-west3": 561.0,
    "us-west4": 491.0,
    "asia-east1": 541.0,
    "asia-east2": 626.0,
    "asia-northeast1": 524.0,
    "asia-northeast2": 524.0,
    "asia-northeast3": 540.0,
    "asia-south1": 723.0,
    "asia-southeast1": 493.0,
    "asia-southeast2": 772.0,
    "australia-southeast1": 725.0,
    "europe-north1": 181.0,
    "europe-west1": 196.0,
    "europe-west2": 257.0,
    "europe-west3": 319.0,
    "europe-west4": 474.0,
    "europe-west6": 29.0,
    "northamerica-northeast1": 143.0,
    "southamerica-east1": 109.0,
  },
  azure: {
    centralus: 472.2,
    eastus: 415.8,
    eastus2: 415.8,
    northcentralus: 440.2,
    southcentralus: 396.3,
    westcentralus: 350.9,
    westus: 350.9,
    westus2: 350.9,
    westus3: 350.9,
    eastasia: 810.0,
    southeastasia: 408.5,
    northeurope: 316.0,
    westeurope: 390.0,
    centralindia: 708.0,
    southindia: 708.0,
    westindia: 708.0,
    uksouth: 228.0,
    ukwest: 228.0,
    francecentral: 67.0,
    germanywestcentral: 402.0,
    swedencentral: 9.0,
  },
};

/**
 * Power Usage Effectiveness — how much total datacentre power is drawn per watt
 * delivered to a server. Published by each provider; 1.0 would be a datacentre
 * with no cooling or distribution losses at all, which does not exist.
 */
export const PROVIDER_PUE: Record<string, number> = {
  aws: 1.135,
  gcp: 1.1,
  azure: 1.185,
};

/**
 * Watts per vCPU at idle and at full load, when the processor's
 * microarchitecture is unknown — which it always is here, because the inventory
 * records an instance type and not a CPU model.
 *
 * These are the provider-level averages the upstream project falls back to for
 * exactly that case, which is the honest coefficient to use rather than
 * pretending to know the silicon.
 */
export const VCPU_WATTS: Record<string, { min: number; max: number }> = {
  aws: { min: 0.74, max: 3.5 },
  gcp: { min: 0.71, max: 4.26 },
  azure: { min: 0.78, max: 3.76 },
};

/**
 * Assumed average CPU utilisation, as a fraction.
 *
 * This is the single largest source of error in the estimate and it is a
 * **constant**, because the product does not collect per-resource CPU history
 * for every provider and a figure derived from the few that do report it would
 * be quietly inconsistent across an estate. 50% is the upstream project's own
 * default for the same reason.
 *
 * It is surfaced in the response rather than buried, so a reader can see what
 * the number rests on.
 */
export const ASSUMED_CPU_UTILIZATION = 0.5;

/** Providers this module can estimate for at all. */
export const CARBON_SUPPORTED_PLUGINS = Object.keys(PROVIDER_PUE);

/**
 * Normalize a provider region string for lookup.
 *
 * Azure reports regions both as `East US` and as `eastus` depending on the API;
 * the table is keyed on the compact form, so the display form has to be folded
 * onto it. AWS and GCP are already lower-case hyphenated and pass through.
 */
export function normalizeCarbonRegion(pluginId: string, region: string): string {
  const trimmed = region.trim();
  if (pluginId === "azure") return trimmed.toLowerCase().replace(/[\s_-]/g, "");
  return trimmed.toLowerCase();
}

/** Grams CO2e per kWh for a region, or null when it is not in the table. */
export function gridIntensityFor(pluginId: string, region: string | null): number | null {
  if (!region) return null;
  const table = GRID_INTENSITY_G_PER_KWH[pluginId];
  if (!table) return null;
  return table[normalizeCarbonRegion(pluginId, region)] ?? null;
}
