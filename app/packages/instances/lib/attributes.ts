import { msg } from "gt-react";

/**
 * Labels and grouping for the attributes AWS puts on price list products.
 * Anything not listed here still shows, under "Other", with its key spelled
 * out, so a field AWS adds later is never hidden.
 *
 * Every label is a `msg()` source: the English text, which the gt CLI
 * extracts. Render sites translate it with `useDataString()` (or a server
 * `Translate`); a spelled-out key has no catalog entry and stays English.
 */

export interface Section {
  slug: string;
  name: string;
  keys: Readonly<Record<string, string>>;
}

const SECTIONS: readonly Section[] = [
  {
    slug: "compute",
    name: msg("Compute"),
    keys: {
      vcpu: msg("vCPUs"),
      vCpu: msg("vCPUs"),
      memory: msg("Memory"),
      memoryGib: msg("Memory (GiB)"),
      ecu: msg("ECU"),
      physicalProcessor: msg("Processor"),
      physicalCpu: msg("Processor"),
      clockSpeed: msg("Clock speed"),
      processorArchitecture: msg("Architecture"),
      processorFeatures: msg("Processor features"),
      intelAvxAvailable: msg("Intel AVX"),
      intelAvx2Available: msg("Intel AVX2"),
      intelTurboAvailable: msg("Intel Turbo"),
      gpu: msg("GPUs"),
      gpuMemory: msg("GPU memory"),
      physicalGpu: msg("GPU model"),
      computeType: msg("Compute type"),
      normalizationSizeFactor: msg("Normalization size factor"),
    },
  },
  {
    slug: "family",
    name: msg("Family"),
    keys: {
      instanceFamily: msg("Instance family"),
      instanceFamilyCategory: msg("Family category"),
      instanceTypeFamily: msg("Instance type family"),
      usageFamily: msg("Usage family"),
      currentGeneration: msg("Current generation"),
      productFamily: msg("Product family"),
    },
  },
  {
    slug: "networking",
    name: msg("Networking"),
    keys: {
      networkPerformance: msg("Network performance"),
      enhancedNetworkingSupported: msg("Enhanced networking"),
      vpcnetworkingsupport: msg("VPC networking"),
      classicnetworkingsupport: msg("EC2-Classic networking"),
    },
  },
  {
    slug: "storage",
    name: msg("Storage"),
    keys: {
      storage: msg("Instance storage"),
      instanceStorage: msg("Instance storage"),
      instanceStorageGb: msg("Instance storage (GB)"),
      volumeoptimization: msg("Volume optimization"),
      io: msg("Storage I/O"),
      storageMedia: msg("Storage media"),
      dedicatedEbsThroughput: msg("Dedicated EBS throughput"),
      dedicatedEbsThroughputDescription: msg("Dedicated EBS throughput (baseline)"),
      ebsOptimized: msg("EBS optimized"),
    },
  },
];

const KNOWN: Readonly<Record<string, string>> = {
  availabilityzone: msg("Availability zone"),
  marketoption: msg("Market option"),
  pricingUnit: msg("Pricing unit"),
  unbundledLicensing: msg("Unbundled licensing"),
  abdInstanceClass: msg("ABD instance class"),
  instanceName: msg("Instance name"),
  databaseEngine: msg("Database engine"),
  engineCode: msg("Engine code"),
  deploymentOption: msg("Deployment"),
  licenseModel: msg("License"),
};

/** vCPUs and memory, under whichever keys the platform uses (SageMaker's `vCpu`, OpenSearch's `memoryGib`). */
export function specs(attrs: Readonly<Record<string, string>>): { vcpu?: string; memory?: string } {
  const vcpu = attrs.vcpu ?? attrs.vCpu;
  const memory = attrs.memory ?? (attrs.memoryGib ? `${attrs.memoryGib} GiB` : undefined);
  const known = (v: string | undefined) => v !== undefined && v !== "" && v !== "NA";
  return {
    ...(known(vcpu) ? { vcpu: vcpu! } : {}),
    ...(known(memory) ? { memory: /^[\d.]+$/.test(memory!) ? `${memory} GiB` : memory! } : {}),
  };
}

/** Variant fields: the product fields that pick a price. */
const VARIANT_LABELS: Readonly<Record<string, string>> = {
  operatingSystem: msg("Operating system"),
  tenancy: msg("Tenancy"),
  licenseModel: msg("License"),
  preInstalledSw: msg("Pre-installed software"),
  capacitystatus: msg("Capacity"),
  databaseEngine: msg("Engine"),
  databaseEdition: msg("Edition"),
  deploymentOption: msg("Deployment"),
  deploymentModel: msg("Deployment model"),
  engineMediaType: msg("Engine media"),
  engineCode: msg("Engine code"),
  usagetype: msg("Usage"),
  cacheEngine: msg("Engine"),
  engine: msg("Engine"),
  component: msg("Component"),
  platoinstancetype: msg("SageMaker instance type"),
  softwareType: msg("Software"),
  isSpotInstance: msg("Spot"),
  operation: msg("Operation"),
  "m-ncu": msg("NCU"),
  mncu: msg("NCU"),
};

/** `dedicatedEbsThroughput` to `Dedicated ebs throughput`. */
function spellOut(key: string): string {
  const words = key
    .replace(/[-_]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function attributeLabel(key: string): string {
  for (const s of SECTIONS) if (Object.hasOwn(s.keys, key)) return s.keys[key]!;
  return KNOWN[key] ?? spellOut(key);
}

export function variantLabel(key: string): string {
  return VARIANT_LABELS[key] ?? spellOut(key);
}

/** How a variant field's value reads in a picker; AWS writes "not applicable" as `NA` or an empty string. */
export function variantValueLabel(value: string): string {
  if (value === "" || value === "NA") return msg("None");
  return value;
}

/** The attributes grouped into sections, in section order, with leftovers under "Other". */
export function groupAttributes(
  attrs: Readonly<Record<string, string>>,
): { section: Section; keys: string[] }[] {
  const used = new Set<string>();
  const groups = SECTIONS.map((section) => {
    const keys = Object.keys(section.keys).filter((k) => Object.hasOwn(attrs, k));
    for (const k of keys) used.add(k);
    return { section, keys };
  });
  const other = Object.keys(attrs)
    .filter((k) => !used.has(k))
    .sort((a, b) => attributeLabel(a).localeCompare(attributeLabel(b)));
  groups.push({ section: { slug: "other", name: msg("Other"), keys: {} }, keys: other });
  return groups.filter((g) => g.keys.length > 0);
}
