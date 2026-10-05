/**
 * GPUs and other accelerators: what a node has, what a pod asks for, and what
 * fraction of a physical device one unit of an extended resource represents.
 *
 * Pure: plain objects in, plain objects out. `cluster-cost.ts` feeds it node
 * labels and capacities straight off `/api/v1/nodes`, and the cost model reads
 * the result in GPU-equivalents (1.0 = one whole physical device), which is the
 * only unit in which a MIG slice, a time-sliced replica and a whole card can be
 * added together.
 *
 * The resource names and labels below come from the components that create
 * them, not from convention:
 *
 *  - NVIDIA device plugin: `nvidia.com/gpu` for a whole GPU. With MIG's
 *    `mixed` strategy each profile is its own resource,
 *    `nvidia.com/mig-<g>g.<mem>gb`. The device plugin turns a profile's `+` into
 *    a `.`, so the media-extension `1g.10gb+me` is advertised as
 *    `nvidia.com/mig-1g.10gb.me`, and Blackwell adds `-me` / `.gfx` forms. With
 *    the `single` strategy every MIG device is still advertised as
 *    `nvidia.com/gpu`, and only the node labels say it is a slice
 *    (`nvidia.com/mig.strategy=single`, and GPU feature discovery appends
 *    `-MIG-<g>g.<mem>gb` to `nvidia.com/gpu.product`).
 *  - Sharing (time-slicing or MPS): the device plugin advertises `replicas`
 *    units per physical GPU, so capacity reads 4 on a node with one card and
 *    `replicas: 4`. GPU feature discovery records the factor in
 *    `nvidia.com/gpu.replicas` and the strategy in
 *    `nvidia.com/gpu.sharing-strategy`; with `renameByDefault` the resource is
 *    `nvidia.com/gpu.shared` instead. GKE's own GPU sharing reports the same
 *    facts as `cloud.google.com/gke-max-shared-clients-per-gpu` and
 *    `cloud.google.com/gke-gpu-sharing-strategy`, and its MIG partitions as
 *    `cloud.google.com/gke-gpu-partition-size`.
 *  - AMD: `amd.com/gpu`. Intel: `gpu.intel.com/i915` and `gpu.intel.com/xe`.
 *    Habana Gaudi, AWS Neuron and Cloud TPU are accelerators of the same shape
 *    (one unit, one device or core) and are treated like whole GPUs.
 */

/** Resource names that are whole accelerators, one unit per device or core. */
const WHOLE_DEVICE_RESOURCES = new Set([
  "nvidia.com/gpu",
  "nvidia.com/gpu.shared",
  "amd.com/gpu",
  "gpu.intel.com/i915",
  "gpu.intel.com/xe",
  "habana.ai/gaudi",
  "aws.amazon.com/neuron",
  "aws.amazon.com/neurondevice",
  "aws.amazon.com/neuroncore",
  "google.com/tpu",
]);

/** `nvidia.com/mig-3g.20gb`, `nvidia.com/mig-1g.10gb.me`, `nvidia.com/mig-1g.23gb-me`. */
const MIG_RESOURCE_RE = /^nvidia\.com\/mig-(\d+)g\.(\d+)gb(?:[.+-][a-z.]+)?$/;
/** A MIG profile wherever it appears: a product label suffix or a GKE label. */
const MIG_PROFILE_RE = /(\d+)g\.(\d+)gb/i;

/** True for any extended resource this module treats as an accelerator. */
export function isAcceleratorResource(name: string): boolean {
  return WHOLE_DEVICE_RESOURCES.has(name) || MIG_RESOURCE_RE.test(name);
}

/** The vendor a resource name belongs to, for labelling only. */
function vendorOf(name: string): string {
  const domain = name.split("/")[0] ?? "";
  if (domain.startsWith("nvidia.com")) return "NVIDIA";
  if (domain === "amd.com") return "AMD";
  if (domain === "gpu.intel.com") return "Intel";
  if (domain === "habana.ai") return "Habana";
  if (domain === "aws.amazon.com") return "AWS Neuron";
  if (domain === "google.com") return "Google TPU";
  return domain;
}

/** How the node's devices are carved up, which decides what one unit is worth. */
export type GpuSharing = "exclusive" | "mig-mixed" | "mig-single" | "time-slicing" | "mps";

/** A MIG profile, parsed: compute slices and memory in GB. */
export interface MigProfile {
  name: string;
  computeSlices: number;
  memoryGb: number;
}

export function parseMigProfile(text: string | undefined): MigProfile | null {
  if (!text) return null;
  const match = MIG_PROFILE_RE.exec(text);
  if (!match) return null;
  const computeSlices = Number(match[1]);
  const memoryGb = Number(match[2]);
  if (!(computeSlices > 0) || !(memoryGb > 0)) return null;
  return { name: `${computeSlices}g.${memoryGb}gb`, computeSlices, memoryGb };
}

/** A node's accelerators, in GPU-equivalents. `null` on a node with none. */
export interface NodeGpuInventory {
  /** Canonical model key (see {@link canonicalGpuModel}), or "" when unknown. */
  model: string;
  /** The label value the model came from, verbatim, for display. */
  modelLabel: string;
  vendor: string;
  sharing: GpuSharing;
  /** Physical devices on the node. What the invoice pays for. */
  physicalCount: number;
  /** Devices the scheduler may hand out, in GPU-equivalents (<= physical). */
  allocatable: number;
  /**
   * resource name → GPU-equivalents one unit of it is worth on this node.
   * `nvidia.com/gpu` is 1 on an exclusive node, 1/replicas on a shared one, and
   * the slice fraction under MIG's single strategy.
   */
  unitFraction: Record<string, number>;
  /** Replicas per GPU when shared, else 1. */
  replicas: number;
  /** MIG profile under the single strategy (or GKE partitioning). */
  migProfile: MigProfile | null;
  /** Total memory of one physical device in MiB, when a label says so. */
  memoryMiBPerDevice: number | null;
  /** Compute slices one physical device divides into (7, or 4 on an A30). */
  computeSlicesPerDevice: number;
}

function num(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The labels that name a node's GPU model, most specific first. GPU feature
 * discovery's `nvidia.com/gpu.product` is the device's own report; the cloud
 * labels are what the node was provisioned as. AKS's
 * `kubernetes.azure.com/accelerator` names only the vendor (`nvidia`), so it
 * is not in this list: on AKS the model comes from the VM size instead.
 */
const MODEL_LABELS = [
  "nvidia.com/gpu.product",
  "cloud.google.com/gke-accelerator",
  "karpenter.k8s.aws/instance-gpu-name",
  "eks.amazonaws.com/instance-gpu-name",
  "amd.com/gpu.product-name",
  "beta.amd.com/gpu.product-name",
];

/** Per-device memory in MiB, from whichever component labelled it. */
const MEMORY_LABELS = [
  "nvidia.com/gpu.memory",
  "karpenter.k8s.aws/instance-gpu-memory",
  "eks.amazonaws.com/instance-gpu-memory",
];

/** Physical device count, from whichever component labelled it. */
const COUNT_LABELS = [
  "nvidia.com/gpu.count",
  "cloud.google.com/gke-accelerator-count",
  "karpenter.k8s.aws/instance-gpu-count",
  "eks.amazonaws.com/instance-gpu-count",
];

/**
 * Reduce any GPU model spelling to one key: `NVIDIA-A100-SXM4-80GB`,
 * `nvidia-a100-80gb` and `a100 80gb` all become `a100-80gb`.
 *
 * `memoryMiB` disambiguates the spellings that leave the size out (Karpenter
 * and EKS Auto Mode say just `a100` or `h100`, with the size in a separate
 * label). Only the families with a reference price or a MIG table are named;
 * anything else keeps a slug of its own spelling, so an override typed as
 * `gpu/<label value>=…` still matches it.
 */
export function canonicalGpuModel(raw: string, memoryMiB?: number | null): string {
  const text = raw.toLowerCase();
  const has = (re: RegExp) => re.test(text);
  const mem = memoryMiB ?? 0;
  if (has(/\bgb300\b/)) return "gb300";
  if (has(/\bgb200\b/)) return "gb200";
  if (has(/\bgh200\b/)) return "gh200";
  if (has(/\bb300\b/)) return "b300";
  if (has(/\bb200\b/)) return "b200";
  if (has(/\bh200\b/)) return "h200";
  if (has(/\bh100\b/)) return has(/\b94gb\b|nvl/) || mem > 90_000 ? "h100-94gb" : "h100-80gb";
  if (has(/\bh800\b/)) return "h800";
  if (has(/\ba100\b/)) return has(/\b80gb\b/) || mem > 60_000 ? "a100-80gb" : "a100-40gb";
  if (has(/\ba30\b/)) return "a30";
  if (has(/\ba10g\b/)) return "a10g";
  if (has(/\ba10\b/)) return "a10";
  if (has(/\bl40s\b/)) return "l40s";
  if (has(/\bl40\b/)) return "l40";
  if (has(/\bl4\b/)) return "l4";
  if (has(/\bt4g?\b/)) return "t4";
  if (has(/\bv100\b/)) return "v100";
  if (has(/\bp100\b/)) return "p100";
  if (has(/\bp4\b/)) return "p4";
  if (has(/\bk80\b/)) return "k80";
  if (has(/\bmi300x\b/)) return "mi300x";
  if (has(/\bmi250x?\b/)) return "mi250";
  return text
    .replace(/-mig-.*$/, "")
    .replace(/-shared$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The GPU model implied by an instance type, for nodes no GPU component has
 * labelled (an AKS GPU pool, or EKS managed node groups without GPU feature
 * discovery). Only families whose GPU is fixed by the name are listed.
 */
const INSTANCE_FAMILY_MODELS: Array<[RegExp, string]> = [
  // AWS
  [/^p6-b200\./, "b200"],
  [/^p5en?\./, "h200"],
  [/^p5\./, "h100-80gb"],
  [/^p4de\./, "a100-80gb"],
  [/^p4d\./, "a100-40gb"],
  [/^p3(dn)?\./, "v100"],
  [/^g6e\./, "l40s"],
  [/^g6\./, "l4"],
  [/^g5\./, "a10g"],
  [/^g4dn\./, "t4"],
  // Google Cloud
  [/^a4-highgpu-/, "b200"],
  [/^a3-ultragpu-/, "h200"],
  [/^a3-(high|mega|edge)gpu-/, "h100-80gb"],
  [/^a2-ultragpu-/, "a100-80gb"],
  [/^a2-(high|mega)gpu-/, "a100-40gb"],
  [/^g2-standard-/, "l4"],
  // Azure (armSkuName, which is what the instance-type label carries)
  [/^standard_nc\d+as_t4_v3$/i, "t4"],
  [/^standard_nc\d+s_v3$/i, "v100"],
  [/^standard_nd\d+asr_v4$/i, "a100-40gb"],
  [/^standard_nd\d+amsr_a100_v4$/i, "a100-80gb"],
  [/^standard_nc\d+ads_a100_v4$/i, "a100-80gb"],
  [/^standard_nd\d+isr_h100_v5$/i, "h100-80gb"],
  [/^standard_nc\d+ads_h100_v5$/i, "h100-94gb"],
  [/^standard_nd\d+isr_h200_v5$/i, "h200"],
  [/^standard_nv\d+ads_a10_v5$/i, "a10"],
  // CoreWeave (CKS nodes carry the instance id the CoreWeave plugin prices).
  [/^gd-\d+xh200/i, "h200"],
  [/^gd-\d+xh100/i, "h100-80gb"],
  [/^gd-\d+xgh200/i, "gh200"],
  [/^gd-\d+xl40s/i, "l40s"],
  [/^gd-\d+xl40-/i, "l40"],
  [/^gd-\d+xa100/i, "a100-80gb"],
  [/^gb300-/i, "gb300"],
  [/^gb200-/i, "gb200"],
  [/^b300-/i, "b300"],
  [/^b200-/i, "b200"],
  // DigitalOcean GPU Droplets name the card in the slug: `gpu-h100x1-80gb`.
  [/^gpu-h200x/i, "h200"],
  [/^gpu-h100x/i, "h100-80gb"],
  [/^gpu-l40sx/i, "l40s"],
  [/^gpu-mi300x/i, "mi300x"],
];

export function modelFromInstanceType(instanceType: string): string {
  const type = instanceType.trim();
  for (const [re, model] of INSTANCE_FAMILY_MODELS) if (re.test(type)) return model;
  return "";
}

/** Compute slices per device by model. Everything MIG-capable is 7 except A30. */
function computeSlicesFor(model: string): number {
  return model === "a30" ? 4 : 7;
}

/**
 * Read a node's accelerators off its labels and extended-resource capacity.
 *
 * Returns `null` when the node advertises no accelerator resource at all: a
 * CPU node, or a GPU node whose device plugin is not running (in which case
 * the GPUs cannot be scheduled and there is nothing to apportion by).
 */
export function readNodeGpus(
  labels: Record<string, string>,
  capacity: Record<string, string> | undefined,
  allocatable: Record<string, string> | undefined,
  instanceType = "",
): NodeGpuInventory | null {
  const capacityEntries = Object.entries(capacity ?? {}).filter(([name]) =>
    isAcceleratorResource(name),
  );
  const capacityOf = (name: string) => num(capacity?.[name]) ?? 0;
  const allocatableOf = (name: string) => num(allocatable?.[name]) ?? capacityOf(name);
  const advertised = capacityEntries.filter(([name]) => capacityOf(name) > 0);
  if (advertised.length === 0) return null;

  const memoryKey = MEMORY_LABELS.find((key) => num(labels[key]) != null);
  const memoryMiB = memoryKey ? num(labels[memoryKey]) : null;
  const modelLabelKey = MODEL_LABELS.find((key) => labels[key]);
  const fromInstance = modelLabelKey ? "" : modelFromInstanceType(instanceType);
  const modelLabel = modelLabelKey ? labels[modelLabelKey]! : fromInstance ? instanceType : "";
  const model = modelLabelKey ? canonicalGpuModel(labels[modelLabelKey]!, memoryMiB) : fromInstance;
  const vendor = vendorOf(advertised[0]![0]);
  const slices = computeSlicesFor(model);

  const strategy = (labels["nvidia.com/gpu.sharing-strategy"] ?? "").toLowerCase();
  const gkeStrategy = (labels["cloud.google.com/gke-gpu-sharing-strategy"] ?? "").toLowerCase();
  const replicas = Math.max(
    1,
    Math.floor(
      num(labels["nvidia.com/gpu.replicas"]) ??
        num(labels["cloud.google.com/gke-max-shared-clients-per-gpu"]) ??
        1,
    ),
  );

  const migSingle =
    labels["nvidia.com/mig.strategy"] === "single" ||
    Boolean(labels["cloud.google.com/gke-gpu-partition-size"]);
  const migProfile = migSingle
    ? (parseMigProfile(labels["cloud.google.com/gke-gpu-partition-size"]) ??
      parseMigProfile(/-MIG-(.+)$/i.exec(labels["nvidia.com/gpu.product"] ?? "")?.[1]))
    : null;
  const anyMigResource = advertised.some(([name]) => MIG_RESOURCE_RE.test(name));

  const sharing: GpuSharing = anyMigResource
    ? "mig-mixed"
    : migProfile
      ? "mig-single"
      : replicas > 1 || advertised.some(([name]) => name === "nvidia.com/gpu.shared")
        ? strategy === "mps" || gkeStrategy === "mps"
          ? "mps"
          : "time-slicing"
        : "exclusive";

  const unitFraction: Record<string, number> = {};
  for (const [name] of advertised) {
    const mig = MIG_RESOURCE_RE.exec(name);
    if (mig) {
      unitFraction[name] = Math.min(1, Number(mig[1]) / slices);
    } else if (name === "nvidia.com/gpu" || name === "nvidia.com/gpu.shared") {
      unitFraction[name] = migProfile
        ? Math.min(1, migProfile.computeSlices / slices)
        : 1 / replicas;
    } else {
      unitFraction[name] = 1;
    }
  }

  const equivalents = (pick: (name: string) => number) =>
    advertised.reduce((acc, [name]) => acc + pick(name) * (unitFraction[name] ?? 1), 0);
  const capacityEquivalents = equivalents(capacityOf);
  // GPU feature discovery's count is physical devices, which is exactly what is
  // billed. Without it, the advertised units converted to equivalents and
  // rounded up: a MIG layout that leaves a slice unconfigured is still a whole
  // card on the invoice.
  const countKey = COUNT_LABELS.find((key) => (num(labels[key]) ?? 0) > 0);
  const labelledCount = countKey ? num(labels[countKey]) : null;
  const physicalCount =
    labelledCount != null && labelledCount > 0
      ? labelledCount
      : Math.max(1, Math.ceil(capacityEquivalents - 1e-9));
  const allocatableEquivalents = Math.min(physicalCount, equivalents(allocatableOf));

  return {
    model,
    modelLabel,
    vendor,
    sharing,
    physicalCount,
    allocatable: allocatableEquivalents,
    unitFraction,
    replicas,
    migProfile,
    memoryMiBPerDevice: memoryMiB != null && memoryMiB > 0 ? memoryMiB : null,
    computeSlicesPerDevice: slices,
  };
}

/**
 * A pod's accelerator requests, by resource name, following the scheduler's
 * rules for extended resources: a container that sets only a limit gets an
 * equal request, init containers peak rather than add, and sidecars count in
 * both the init peak and the steady state (the same KEP-753 arithmetic as
 * `pod-resources.ts`, applied to every accelerator name independently).
 * Pod-level `spec.resources` does not cover extended resources, so it is not
 * consulted.
 */
export function podAcceleratorRequests(spec: {
  containers?: Array<{
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  }>;
  initContainers?: Array<{
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    restartPolicy?: string;
  }>;
}): Record<string, number> {
  const own = (container: {
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  }): Record<string, number> => {
    const out: Record<string, number> = {};
    const names = new Set([
      ...Object.keys(container.resources?.requests ?? {}),
      ...Object.keys(container.resources?.limits ?? {}),
    ]);
    for (const name of names) {
      if (!isAcceleratorResource(name)) continue;
      const value =
        num(container.resources?.requests?.[name]) ?? num(container.resources?.limits?.[name]);
      if (value != null && value > 0) out[name] = value;
    }
    return out;
  };
  const addInto = (a: Record<string, number>, b: Record<string, number>) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const maxInto = (a: Record<string, number>, b: Record<string, number>) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
    return out;
  };

  let steady: Record<string, number> = {};
  for (const container of spec.containers ?? []) steady = addInto(steady, own(container));
  let sidecars: Record<string, number> = {};
  let initPeak: Record<string, number> = {};
  for (const container of spec.initContainers ?? []) {
    const mine = own(container);
    if (container.restartPolicy === "Always") {
      sidecars = addInto(sidecars, mine);
      steady = addInto(steady, mine);
      initPeak = maxInto(initPeak, sidecars);
    } else {
      initPeak = maxInto(initPeak, addInto(sidecars, mine));
    }
  }
  return maxInto(initPeak, steady);
}

/** GPU-equivalents a pod's requests are worth on one node. */
export function gpuEquivalents(
  requests: Record<string, number> | undefined,
  node: NodeGpuInventory | null | undefined,
): number {
  if (!requests || !node) return 0;
  let total = 0;
  for (const [name, qty] of Object.entries(requests)) {
    const fraction = node.unitFraction[name];
    if (fraction != null) total += qty * fraction;
  }
  return total;
}

/**
 * On-demand price of one GPU, per hour, used only to work out what *share* of
 * a GPU node's price is the GPU.
 *
 * WHY A REFERENCE TABLE AND WHY THESE NUMBERS: AWS, Azure and DigitalOcean sell
 * a GPU node as one price for the whole machine. Google Cloud publishes the
 * GPU separately from the vCPUs and memory, so it is the only public source
 * for the ratio between them. Like the 65/35 CPU/memory split these are
 * applied as a *ratio* to whatever the node really costs, so a list-price
 * difference between clouds cancels out; they never become a price on their
 * own.
 *
 * All figures are Compute Engine on-demand, Iowa (us-central1), read from
 * https://cloud.google.com/products/compute/pricing/accelerator-optimized
 * (checked 2026-10-04). Two kinds:
 *
 *  - **Listed per GPU** (the attachable N1 GPUs): the page's own per-GPU price.
 *  - **Bundled in the machine price** (L4 on G2, A100 on A2, H100 and H200 on
 *    A3): the machine's on-demand price minus its vCPUs and memory at the N2
 *    component rates below, divided by its GPUs. Same subtraction the
 *    `remainder` basis does at run time, done once against the published
 *    machine so the result can be checked: it recovers A100 40GB's
 *    long-standing $2.933908 per-GPU figure to the sixth decimal.
 */
export const GPU_REFERENCE_HOURLY_USD: Record<string, number> = {
  // Listed per GPU in the page's GPU table: T4 $0.35, P4 $0.60, P100 $1.46, V100 $2.48.
  t4: 0.35,
  p4: 0.6,
  p100: 1.46,
  v100: 2.48,
  // g2-standard-4 (1 GPU, 4 vCPU, 16 GiB) $0.706832276 − 4×0.031611 − 16×0.004237.
  l4: 0.512596,
  // a2-highgpu-1g (1 GPU, 12 vCPU, 85 GiB) $3.673385 − 12×0.031611 − 85×0.004237.
  "a100-40gb": 2.933908,
  // a2-ultragpu-1g (1 GPU, 12 vCPU, 170 GB) $5.06879789 − 12×0.031611 − 170×0.004237.
  // Its bundled 275 GiB local SSD stays in, so this slightly overstates the GPU.
  "a100-80gb": 3.969176,
  // a3-highgpu-8g (8 GPUs, 208 vCPU, 1,871 GB) ($88.490000119 − 208×0.031611 − 1871×0.004237) / 8.
  "h100-80gb": 9.248436,
  // a3-ultragpu-8g (8 GPUs, 224 vCPU, 2,952 GB) ($84.806908493 − 224×0.031611 − 2952×0.004237) / 8.
  h200: 8.152303,
};

/**
 * Compute Engine N2 on-demand component prices in us-central1, the same source
 * as {@link DEFAULT_CPU_COST_SHARE}'s derivation: $0.031611 per vCPU-hour and
 * $0.004237 per GiB-hour. Checked against
 * https://cloud.google.com/products/compute/pricing/general-purpose on
 * 2026-10-04: n2-standard-4 (4 vCPU, 16 GiB) is listed at $0.194236, exactly
 * 4×0.031611 + 16×0.004237.
 */
export const REFERENCE_VCPU_HOURLY_USD = 0.031611;
export const REFERENCE_GIB_HOURLY_USD = 0.004237;

/** How the GPU share of a node's price was arrived at. Always surfaced. */
export type GpuPriceBasis = "per-gpu-price" | "reference" | "remainder";

/**
 * Split a node's hourly rate into its GPU pool and the CPU+memory remainder.
 *
 *  - With an explicit per-GPU hourly price (from the cloud plugin, or typed on
 *    the account as `gpu/<model>=<price>`), the GPU pool is that price times
 *    the physical device count, capped at the node's own rate.
 *  - For a model with a published reference price, the pool is the node's
 *    rate times the GPU's share of a reference machine built from published
 *    component prices: devices at their reference price, plus vCPUs and GiB at
 *    the N2 component rates. A ratio, so it holds at any price level (list,
 *    billed, discounted).
 *  - For a model with none (an A10G, an L40S, an AMD Instinct, a Gaudi), the
 *    machine's vCPUs and GiB are priced at those component rates in absolute
 *    terms and everything else the node costs is the accelerator. CPU and
 *    memory prices are similar across clouds; GPU prices are not, which is
 *    why the unknown side is the one left to fall out as the remainder.
 */
export function splitGpuNodeRate(
  nodeRate: number,
  gpus: NodeGpuInventory,
  cpuCores: number,
  memoryGiB: number,
  perGpuHourly: number | undefined,
): { gpuPool: number; basis: GpuPriceBasis } {
  if (perGpuHourly != null && Number.isFinite(perGpuHourly) && perGpuHourly >= 0) {
    return {
      gpuPool: Math.min(nodeRate, perGpuHourly * gpus.physicalCount),
      basis: "per-gpu-price",
    };
  }
  const rest = cpuCores * REFERENCE_VCPU_HOURLY_USD + memoryGiB * REFERENCE_GIB_HOURLY_USD;
  const known = GPU_REFERENCE_HOURLY_USD[gpus.model];
  if (known == null) {
    return { gpuPool: Math.max(0, nodeRate - rest), basis: "remainder" };
  }
  const gpuRef = known * gpus.physicalCount;
  const share = gpuRef + rest > 0 ? gpuRef / (gpuRef + rest) : 0;
  return { gpuPool: nodeRate * share, basis: "reference" };
}

/**
 * MIG profiles per model, smallest first, without the media-extension
 * variants (a right-sizing suggestion should name the general-purpose
 * profile). Compute slices are out of 7 (4 on the A30); memory is the
 * profile's own figure in GB, as in its name.
 */
export const MIG_PROFILES: Record<string, string[]> = {
  a30: ["1g.6gb", "2g.12gb", "4g.24gb"],
  "a100-40gb": ["1g.5gb", "1g.10gb", "2g.10gb", "3g.20gb", "4g.20gb", "7g.40gb"],
  "a100-80gb": ["1g.10gb", "1g.20gb", "2g.20gb", "3g.40gb", "4g.40gb", "7g.80gb"],
  "h100-80gb": ["1g.10gb", "1g.20gb", "2g.20gb", "3g.40gb", "4g.40gb", "7g.80gb"],
  "h100-94gb": ["1g.12gb", "1g.24gb", "2g.24gb", "3g.47gb", "4g.47gb", "7g.94gb"],
  h200: ["1g.18gb", "1g.35gb", "2g.35gb", "3g.71gb", "4g.71gb", "7g.141gb"],
  b200: ["1g.23gb", "1g.45gb", "2g.45gb", "3g.90gb", "4g.90gb", "7g.180gb"],
};

/** Headroom over the observed peak a suggested profile must leave. */
export const MIG_HEADROOM = 1.25;

/**
 * The smallest MIG profile that still fits a workload's observed peak, with
 * {@link MIG_HEADROOM} on both compute and memory. `null` when the model is not
 * MIG-capable or nothing smaller than the whole device fits.
 *
 * `p95Utilization` is a fraction of the *whole* device (0..1); `peakMemoryMiB`
 * is framebuffer used at peak.
 */
export function suggestMigProfile(
  model: string,
  p95Utilization: number,
  peakMemoryMiB: number,
): MigProfile | null {
  const names = MIG_PROFILES[model];
  if (!names) return null;
  const slices = computeSlicesFor(model);
  const needCompute = p95Utilization * MIG_HEADROOM;
  const needMemoryGb = (peakMemoryMiB / 1024) * MIG_HEADROOM;
  for (const name of names) {
    const profile = parseMigProfile(name);
    if (!profile) continue;
    if (profile.computeSlices >= slices) return null;
    if (profile.computeSlices / slices >= needCompute && profile.memoryGb >= needMemoryGb) {
      return profile;
    }
  }
  return null;
}

/** `2 × A100 80GB (MIG 1g.10gb)`, for tables and pills. */
export function describeNodeGpus(gpus: NodeGpuInventory): string {
  const name = gpus.modelLabel || gpus.vendor || "GPU";
  const base = `${gpus.physicalCount} × ${name}`;
  switch (gpus.sharing) {
    case "mig-mixed":
      return `${base} (MIG, mixed)`;
    case "mig-single":
      return `${base} (MIG ${gpus.migProfile?.name ?? ""})`.replace(" )", ")");
    case "time-slicing":
      return `${base} (time-sliced ×${gpus.replicas})`;
    case "mps":
      return `${base} (MPS ×${gpus.replicas})`;
    default:
      return base;
  }
}

/** `0.5 GPU` / `2 GPU`: GPU-equivalents, short. */
export function formatGpus(equivalents: number): string {
  if (equivalents === 0) return "0";
  const rounded = equivalents >= 10 ? Math.round(equivalents) : Number(equivalents.toFixed(2));
  return `${rounded} GPU`;
}
