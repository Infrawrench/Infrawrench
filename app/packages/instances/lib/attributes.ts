import { msg } from "gt-react";

/**
 * Labels and grouping for the attributes on price list products: AWS's,
 * Alibaba Cloud's instance type definitions (`CpuCoreCount`, dotted keys for
 * nested fields) and RunPod's GPU and CPU pod fields. Anything not listed here
 * still shows, under "Other", with its key spelled out, so a field a provider
 * adds later is never hidden.
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
      // Alibaba Cloud
      CpuCoreCount: msg("vCPUs"),
      MemorySize: msg("Memory (GiB)"),
      CpuArchitecture: msg("Architecture"),
      PhysicalProcessorModel: msg("Processor"),
      CpuSpeedFrequency: msg("Clock speed (GHz)"),
      CpuTurboFrequency: msg("Turbo clock speed (GHz)"),
      "CpuOptions.Core": msg("Physical cores"),
      "CpuOptions.ThreadsPerCore": msg("Threads per core"),
      "CpuOptions.CoreFactor": msg("Core factor"),
      "CpuOptions.HyperThreadingAdjustable": msg("Adjustable hyper-threading"),
      "CpuOptions.SupportedTopologyTypes.SupportedTopologyType": msg("CPU topologies"),
      GPUAmount: msg("GPUs"),
      GPUSpec: msg("GPU model"),
      GPUMemorySize: msg("Memory per GPU (GiB)"),
      // RunPod
      displayName: msg("Name"),
      manufacturer: msg("Manufacturer"),
      memoryInGb: msg("Memory (GB)"),
      cudaCores: msg("CUDA cores"),
      vcpuBurstable: msg("Burstable vCPUs"),
      ramMultiplier: msg("GB of memory per vCPU"),
    },
  },
  {
    slug: "pods",
    name: msg("Pods"),
    keys: {
      minPodGpuCount: msg("Fewest GPUs per pod"),
      maxGpuCountSecureCloud: msg("Most GPUs per pod in Secure Cloud"),
      maxGpuCountCommunityCloud: msg("Most GPUs per pod in Community Cloud"),
      nodeGroupGpuSizes: msg("GPUs per node"),
      secureCloud: msg("Secure Cloud"),
      communityCloud: msg("Community Cloud"),
      dataCenters: msg("Data centers"),
      diskLimitPerVcpu: msg("Disk per vCPU (GB)"),
      priceUnit: msg("Price unit"),
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
      InstanceTypeFamily: msg("Instance type family"),
      InstanceCategory: msg("Category"),
      InstanceFamilyLevel: msg("Family level"),
      Generation: msg("Generation"),
      flavor: msg("Flavor"),
      groupId: msg("Group"),
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
      InstanceBandwidthRx: msg("Inbound bandwidth (Kbit/s)"),
      InstanceBandwidthTx: msg("Outbound bandwidth (Kbit/s)"),
      InstancePpsRx: msg("Inbound packets per second"),
      InstancePpsTx: msg("Outbound packets per second"),
      EniQuantity: msg("Network interfaces"),
      EniTotalQuantity: msg("Network interfaces, including trunked"),
      EniPrivateIpAddressQuantity: msg("Private IPv4 addresses per interface"),
      EniIpv6AddressQuantity: msg("IPv6 addresses per interface"),
      EniTrunkSupported: msg("Interface trunking"),
      EriQuantity: msg("Elastic RDMA interfaces"),
      QueuePairNumber: msg("RDMA queue pairs"),
      PrimaryEniQueueNumber: msg("Queues on the primary interface"),
      SecondaryEniQueueNumber: msg("Queues per secondary interface"),
      TotalEniQueueQuantity: msg("Interface queues in total"),
      MaximumQueueNumberPerEni: msg("Most queues per interface"),
      NetworkEncryptionSupport: msg("Network encryption"),
      JumboFrameSupport: msg("Jumbo frames"),
      "EnhancedNetwork.RssSupport": msg("RSS"),
      "EnhancedNetwork.SriovSupport": msg("SR-IOV"),
      "EnhancedNetwork.VfQueueNumberPerEni": msg("VF queues per interface"),
      NetworkCardQuantity: msg("Network cards"),
      "NetworkCards.NetworkCardInfo": msg("Network card details"),
      "Clock.PtpSupport": msg("PTP clock"),
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
      DiskQuantity: msg("Most data disks"),
      LocalStorageAmount: msg("Local disks"),
      LocalStorageCapacity: msg("Local disk size (GiB)"),
      LocalStorageCategory: msg("Local disk type"),
      NvmeSupport: msg("NVMe"),
      "SupportedBootModes.SupportedBootMode": msg("Boot modes"),
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

/** Whether these are a RunPod GPU type's attributes, priced per GPU, whose `memoryInGb` is the GPU's. */
export function isGpuType(attrs: Readonly<Record<string, string>>): boolean {
  return attrs.productFamily === "GPU" && attrs.priceUnit === "GPU-Hour";
}

/**
 * vCPUs and memory, under whichever keys the platform uses (SageMaker's
 * `vCpu`, OpenSearch's `memoryGib`, Alibaba's `CpuCoreCount` and `MemorySize`,
 * RunPod CPU pods' `memoryInGb`). A RunPod GPU type has neither: its
 * `memoryInGb` is GPU memory.
 */
export function specs(attrs: Readonly<Record<string, string>>): { vcpu?: string; memory?: string } {
  const vcpu = attrs.vcpu ?? attrs.vCpu ?? attrs.CpuCoreCount;
  const gib = attrs.memoryGib ?? (attrs.MemorySize ? String(Number(attrs.MemorySize)) : undefined);
  const memory =
    attrs.memory ??
    (gib ? `${gib} GiB` : undefined) ??
    (attrs.memoryInGb && !isGpuType(attrs) ? `${attrs.memoryInGb} GB` : undefined);
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
  networkType: msg("Network"),
  cloudType: msg("Cloud"),
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
