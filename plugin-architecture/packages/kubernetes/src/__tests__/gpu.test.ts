import { describe, it, expect } from "vitest";

import {
  canonicalGpuModel,
  gpuEquivalents,
  isAcceleratorResource,
  modelFromInstanceType,
  podAcceleratorRequests,
  readNodeGpus,
  GPU_REFERENCE_HOURLY_USD,
  REFERENCE_GIB_HOURLY_USD,
  REFERENCE_VCPU_HOURLY_USD,
  splitGpuNodeRate,
  suggestMigProfile,
} from "../gpu.js";

describe("isAcceleratorResource", () => {
  it("knows whole devices, MIG profiles and their media-extension spellings", () => {
    for (const name of [
      "nvidia.com/gpu",
      "nvidia.com/gpu.shared",
      "nvidia.com/mig-1g.5gb",
      "nvidia.com/mig-3g.40gb",
      "nvidia.com/mig-1g.10gb.me",
      "nvidia.com/mig-1g.23gb-me",
      "amd.com/gpu",
      "gpu.intel.com/i915",
      "gpu.intel.com/xe",
      "aws.amazon.com/neuron",
    ]) {
      expect(isAcceleratorResource(name), name).toBe(true);
    }
    for (const name of ["cpu", "memory", "hugepages-2Mi", "ephemeral-storage", "example.com/foo"]) {
      expect(isAcceleratorResource(name), name).toBe(false);
    }
  });
});

describe("canonicalGpuModel", () => {
  it("collapses every spelling of a model to one key", () => {
    expect(canonicalGpuModel("NVIDIA-A100-SXM4-80GB")).toBe("a100-80gb");
    expect(canonicalGpuModel("nvidia-a100-80gb")).toBe("a100-80gb");
    expect(canonicalGpuModel("nvidia-tesla-a100")).toBe("a100-40gb");
    expect(canonicalGpuModel("A100-SXM4-40GB-MIG-1g.5gb")).toBe("a100-40gb");
    expect(canonicalGpuModel("Tesla-T4-SHARED")).toBe("t4");
    expect(canonicalGpuModel("nvidia-l4")).toBe("l4");
    expect(canonicalGpuModel("NVIDIA-H100-80GB-HBM3")).toBe("h100-80gb");
  });

  it("uses the memory label when the name leaves the size out (Karpenter, EKS Auto Mode)", () => {
    expect(canonicalGpuModel("a100", 81920)).toBe("a100-80gb");
    expect(canonicalGpuModel("a100", 40960)).toBe("a100-40gb");
  });

  it("keeps a slug for unknown models so an override can still match", () => {
    expect(canonicalGpuModel("Radeon-Pro-V520")).toBe("radeon-pro-v520");
  });
});

describe("modelFromInstanceType", () => {
  it("maps fixed-GPU instance families", () => {
    expect(modelFromInstanceType("p4d.24xlarge")).toBe("a100-40gb");
    expect(modelFromInstanceType("g5.xlarge")).toBe("a10g");
    expect(modelFromInstanceType("Standard_NC24ads_A100_v4")).toBe("a100-80gb");
    expect(modelFromInstanceType("a2-highgpu-1g")).toBe("a100-40gb");
    expect(modelFromInstanceType("gpu-h100x1-80gb")).toBe("h100-80gb");
    expect(modelFromInstanceType("gd-8xh100ib-i128")).toBe("h100-80gb");
    expect(modelFromInstanceType("gb200-4x")).toBe("gb200");
    expect(modelFromInstanceType("m5.large")).toBe("");
  });
});

describe("readNodeGpus", () => {
  it("returns null on a node with no accelerator resource", () => {
    expect(readNodeGpus({}, { cpu: "4", memory: "16Gi" }, undefined)).toBeNull();
  });

  it("reads an exclusive node", () => {
    const gpus = readNodeGpus(
      { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-80GB", "nvidia.com/gpu.count": "8" },
      { "nvidia.com/gpu": "8" },
      { "nvidia.com/gpu": "8" },
    )!;
    expect(gpus.sharing).toBe("exclusive");
    expect(gpus.model).toBe("a100-80gb");
    expect(gpus.physicalCount).toBe(8);
    expect(gpus.unitFraction["nvidia.com/gpu"]).toBe(1);
  });

  it("prices MIG mixed-strategy units as compute slices out of seven", () => {
    const gpus = readNodeGpus(
      { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-40GB", "nvidia.com/gpu.count": "1" },
      { "nvidia.com/mig-1g.5gb": "3", "nvidia.com/mig-4g.20gb": "1" },
      undefined,
    )!;
    expect(gpus.sharing).toBe("mig-mixed");
    expect(gpus.unitFraction["nvidia.com/mig-1g.5gb"]).toBeCloseTo(1 / 7);
    expect(gpus.unitFraction["nvidia.com/mig-4g.20gb"]).toBeCloseTo(4 / 7);
    expect(gpus.physicalCount).toBe(1);
    expect(gpus.allocatable).toBeCloseTo(1);
  });

  it("reads MIG single strategy from the product label suffix", () => {
    const gpus = readNodeGpus(
      {
        "nvidia.com/mig.strategy": "single",
        "nvidia.com/gpu.product": "A100-SXM4-40GB-MIG-1g.5gb",
        "nvidia.com/gpu.count": "1",
      },
      { "nvidia.com/gpu": "7" },
      undefined,
    )!;
    expect(gpus.sharing).toBe("mig-single");
    expect(gpus.migProfile?.name).toBe("1g.5gb");
    expect(gpus.unitFraction["nvidia.com/gpu"]).toBeCloseTo(1 / 7);
  });

  it("reads GKE GPU partitioning as single-strategy MIG", () => {
    const gpus = readNodeGpus(
      {
        "cloud.google.com/gke-accelerator": "nvidia-tesla-a100",
        "cloud.google.com/gke-gpu-partition-size": "1g.5gb",
        "cloud.google.com/gke-accelerator-count": "1",
      },
      { "nvidia.com/gpu": "7" },
      undefined,
    )!;
    expect(gpus.sharing).toBe("mig-single");
    expect(gpus.physicalCount).toBe(1);
  });

  it("splits a time-sliced GPU by replicas, without the GPU count label", () => {
    const gpus = readNodeGpus(
      { "nvidia.com/gpu.product": "Tesla-T4-SHARED", "nvidia.com/gpu.replicas": "4" },
      { "nvidia.com/gpu": "4" },
      undefined,
    )!;
    expect(gpus.sharing).toBe("time-slicing");
    expect(gpus.unitFraction["nvidia.com/gpu"]).toBe(0.25);
    expect(gpus.physicalCount).toBe(1);
  });

  it("recognises MPS and the renamed shared resource", () => {
    const gpus = readNodeGpus(
      {
        "nvidia.com/gpu.sharing-strategy": "mps",
        "nvidia.com/gpu.replicas": "2",
        "nvidia.com/gpu.count": "2",
      },
      { "nvidia.com/gpu.shared": "4", "nvidia.com/gpu": "0" },
      undefined,
    )!;
    expect(gpus.sharing).toBe("mps");
    expect(gpus.unitFraction["nvidia.com/gpu.shared"]).toBe(0.5);
    expect(gpus.physicalCount).toBe(2);
  });

  it("falls back to the instance type on AKS, whose accelerator label names only the vendor", () => {
    const gpus = readNodeGpus(
      { "kubernetes.azure.com/accelerator": "nvidia" },
      { "nvidia.com/gpu": "1" },
      undefined,
      "Standard_NC24ads_A100_v4",
    )!;
    expect(gpus.model).toBe("a100-80gb");
  });
});

describe("podAcceleratorRequests", () => {
  it("takes a limit-only GPU as the request, and sums app containers", () => {
    expect(
      podAcceleratorRequests({
        containers: [
          { resources: { limits: { "nvidia.com/gpu": "1", cpu: "2" } } },
          { resources: { requests: { "nvidia.com/mig-1g.5gb": "2" } } },
        ],
      }),
    ).toEqual({ "nvidia.com/gpu": 1, "nvidia.com/mig-1g.5gb": 2 });
  });

  it("peaks init containers rather than adding them", () => {
    expect(
      podAcceleratorRequests({
        containers: [{ resources: { limits: { "nvidia.com/gpu": "1" } } }],
        initContainers: [{ resources: { limits: { "nvidia.com/gpu": "2" } } }],
      }),
    ).toEqual({ "nvidia.com/gpu": 2 });
  });

  it("is empty for a CPU-only pod", () => {
    expect(
      podAcceleratorRequests({ containers: [{ resources: { requests: { cpu: "1" } } }] }),
    ).toEqual({});
  });
});

describe("gpuEquivalents", () => {
  it("converts requests through the node's unit fractions", () => {
    const node = readNodeGpus(
      { "nvidia.com/gpu.count": "1" },
      { "nvidia.com/mig-1g.5gb": "7" },
      undefined,
    );
    expect(gpuEquivalents({ "nvidia.com/mig-1g.5gb": 2 }, node)).toBeCloseTo(2 / 7);
    // A resource the node does not offer is worth nothing there.
    expect(gpuEquivalents({ "amd.com/gpu": 1 }, node)).toBe(0);
  });
});

describe("splitGpuNodeRate", () => {
  const a100 = readNodeGpus(
    { "nvidia.com/gpu.product": "NVIDIA-A100-SXM4-40GB", "nvidia.com/gpu.count": "8" },
    { "nvidia.com/gpu": "8" },
    undefined,
  )!;

  it("uses an explicit per-GPU price, capped at the node rate", () => {
    expect(splitGpuNodeRate(32, a100, 96, 1152, 3)).toEqual({
      gpuPool: 24,
      basis: "per-gpu-price",
    });
    expect(splitGpuNodeRate(10, a100, 96, 1152, 3).gpuPool).toBe(10);
  });

  it("applies the reference ratio for a known model, whatever the price level", () => {
    const rest = 96 * REFERENCE_VCPU_HOURLY_USD + 1152 * REFERENCE_GIB_HOURLY_USD;
    const ref = GPU_REFERENCE_HOURLY_USD["a100-40gb"]!;
    const share = (8 * ref) / (8 * ref + rest);
    const { gpuPool, basis } = splitGpuNodeRate(32, a100, 96, 1152, undefined);
    expect(basis).toBe("reference");
    expect(gpuPool).toBeCloseTo(32 * share, 6);
    expect(splitGpuNodeRate(16, a100, 96, 1152, undefined).gpuPool).toBeCloseTo(16 * share, 6);
  });

  it("leaves the GPU as the remainder for a model with no reference", () => {
    const a10g = readNodeGpus({}, { "nvidia.com/gpu": "1" }, undefined, "g5.xlarge")!;
    const rest = 4 * REFERENCE_VCPU_HOURLY_USD + 16 * REFERENCE_GIB_HOURLY_USD;
    const { gpuPool, basis } = splitGpuNodeRate(1.006, a10g, 4, 16, undefined);
    expect(basis).toBe("remainder");
    expect(gpuPool).toBeCloseTo(1.006 - rest, 6);
    // Never negative, even on a node priced below the reference rates.
    expect(splitGpuNodeRate(0.01, a10g, 4, 16, undefined).gpuPool).toBe(0);
  });
});

describe("suggestMigProfile", () => {
  it("picks the smallest profile that fits with headroom", () => {
    // 10% busy, 4 GiB used on an A100 40GB: 1g.5gb (1/7 = 14% ≥ 12.5%, 5 GB ≥ 5 GB).
    expect(suggestMigProfile("a100-40gb", 0.1, 4096)?.name).toBe("1g.5gb");
    // Memory-bound: 15 GiB needs ≥ 18.75 GB → 3g.20gb.
    expect(suggestMigProfile("a100-40gb", 0.1, 15 * 1024)?.name).toBe("3g.20gb");
  });

  it("returns null when only the whole GPU fits, or the model has no MIG", () => {
    expect(suggestMigProfile("a100-40gb", 0.7, 1024)).toBeNull();
    expect(suggestMigProfile("t4", 0.05, 512)).toBeNull();
  });
});
