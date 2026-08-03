import { describe, expect, it } from "vitest";
import {
  DEFAULT_RIGHTSIZING_THRESHOLDS,
  computeSizeRecommendation,
  resolveUtilisation,
  type RightsizingSizeOption,
  type SeriesQuantiles,
} from "../rightsizing";

const MIN_SAMPLES = DEFAULT_RIGHTSIZING_THRESHOLDS.minCoverageMinutes;

function q(label: string, q95: number, opts: Partial<SeriesQuantiles> = {}): SeriesQuantiles {
  return {
    label,
    q05: opts.q05 ?? q95,
    q95,
    max: opts.max ?? q95,
    samples: opts.samples ?? MIN_SAMPLES,
  };
}

/** Hetzner-shaped catalog: shared x86 family plus an arm family, EUR prices. */
const catalog: RightsizingSizeOption[] = [
  { id: "cx22", label: "CX22", vcpus: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 3.79 },
  { id: "cx32", label: "CX32", vcpus: 4, memoryMb: 8192, diskGb: 80, priceMonthly: 6.8 },
  { id: "cx42", label: "CX42", vcpus: 8, memoryMb: 16384, diskGb: 160, priceMonthly: 16.4 },
  { id: "cax11", label: "CAX11", vcpus: 2, memoryMb: 4096, diskGb: 40, priceMonthly: 3.29 },
];

describe("resolveUtilisation", () => {
  it("reads a percent CPU series directly", () => {
    const u = resolveUtilisation(
      { cpuMetric: { seriesLabel: "CPU Utilization" } },
      [q("CPU Utilization", 12.5)],
      null,
    );
    expect(u.cpuP95).toBe(12.5);
    expect(u.memoryMeasured).toBe(false);
    expect(u.memoryP95).toBeNull();
  });

  it("scales a fraction CPU series to percent (GCE)", () => {
    const u = resolveUtilisation(
      { cpuMetric: { seriesLabel: "CPU Utilization", scale: "fraction" } },
      [q("CPU Utilization", 0.08)],
      null,
    );
    expect(u.cpuP95).toBeCloseTo(8);
  });

  it("returns null CPU when the declared series was never stored", () => {
    const u = resolveUtilisation(
      { cpuMetric: { seriesLabel: "CPU Utilization" } },
      [q("Network In", 4000)],
      4096,
    );
    expect(u.cpuP95).toBeNull();
    expect(u.cpuSamples).toBe(0);
  });

  it("derives used% from an available-bytes series via the LOW quantile", () => {
    // 4 GB box: busiest minute had 1 GiB available (q05) → p95 used = 75%.
    const capacity = 4096 * 1024 * 1024;
    const u = resolveUtilisation(
      {
        cpuMetric: { seriesLabel: "CPU Utilization" },
        memoryMetric: { seriesLabel: "Memory Available", interpretation: "available-bytes" },
      },
      [q("CPU Utilization", 10), q("Memory Available", capacity * 0.9, { q05: capacity * 0.25 })],
      4096,
    );
    expect(u.memoryMeasured).toBe(true);
    expect(u.memoryP95).toBeCloseTo(75);
  });

  it("reads used-bytes and percent interpretations", () => {
    const capacity = 8192 * 1024 * 1024;
    const used = resolveUtilisation(
      {
        cpuMetric: { seriesLabel: "CPU" },
        memoryMetric: { seriesLabel: "Memory Used", interpretation: "used-bytes" },
      },
      [q("CPU", 5), q("Memory Used", capacity / 4)],
      8192,
    );
    expect(used.memoryP95).toBeCloseTo(25);

    const pct = resolveUtilisation(
      {
        cpuMetric: { seriesLabel: "CPU" },
        memoryMetric: { seriesLabel: "Memory Used", interpretation: "percent" },
      },
      [q("CPU", 5), q("Memory Used", 33)],
      null,
    );
    expect(pct.memoryP95).toBe(33);
  });

  it("treats byte series without a known capacity as unmeasured, never a guess", () => {
    const u = resolveUtilisation(
      {
        cpuMetric: { seriesLabel: "CPU" },
        memoryMetric: { seriesLabel: "Memory Available", interpretation: "available-bytes" },
      },
      [q("CPU", 5), q("Memory Available", 1024)],
      null,
    );
    expect(u.memoryMeasured).toBe(false);
    expect(u.memoryP95).toBeNull();
  });

  it("clamps out-of-range values into 0–100", () => {
    const u = resolveUtilisation(
      {
        cpuMetric: { seriesLabel: "CPU" },
        memoryMetric: { seriesLabel: "Mem", interpretation: "percent" },
      },
      [q("CPU", 130), q("Mem", -4)],
      null,
    );
    expect(u.cpuP95).toBe(100);
    expect(u.memoryP95).toBe(0);
  });
});

describe("computeSizeRecommendation", () => {
  const idle = { cpuP95: 6, cpuSamples: MIN_SAMPLES, memoryP95: 10, memoryMeasured: true };

  it("recommends the cheapest same-family size that clears headroom", () => {
    // Disk was kept at 40 GB across earlier upsizes, so small types stay legal.
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: idle,
      sizeFamilyPattern: "^([a-z]+)",
      currentDiskGb: 40,
    });
    expect(rec).not.toBeNull();
    // cax11 is cheaper than cx22 but a different family; cx22 wins.
    expect(rec!.recommended.id).toBe("cx22");
    expect(rec!.monthlySaving).toBeCloseTo(16.4 - 3.79);
    // 6% of 8 vCPU projected onto 2 vCPU = 24%.
    expect(rec!.projectedCpuP95).toBeCloseTo(24);
    // 10% of 16 GB = 1.6 GB on a 4 GB box = 40% ≤ 70% headroom.
    expect(rec!.projectedMemoryP95).toBeCloseTo(40, 0);
  });

  it("applies the memory headroom rule when memory is measured", () => {
    // 30% of 16 GB = 4.8 GB used. cx22 (4 GB) can't hold it at all; cx32
    // (8 GB) holds it at 60%, inside the 70% headroom.
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: { cpuP95: 6, cpuSamples: MIN_SAMPLES, memoryP95: 30, memoryMeasured: true },
      sizeFamilyPattern: "^([a-z]+)",
      currentDiskGb: 40,
    });
    expect(rec?.recommended.id).toBe("cx32");
    expect(rec?.projectedMemoryP95).toBeCloseTo(60, 0);
  });

  it("returns null when p95 CPU is at or above the threshold", () => {
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: { ...idle, cpuP95: 20 },
    });
    expect(rec).toBeNull();
  });

  it("returns null when measured memory is at or above its threshold", () => {
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: { ...idle, memoryP95: 40 },
    });
    expect(rec).toBeNull();
  });

  it("returns null on thin metric coverage", () => {
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: { ...idle, cpuSamples: MIN_SAMPLES - 1 },
    });
    expect(rec).toBeNull();
  });

  it("returns null when the current size isn't in the catalog", () => {
    const rec = computeSizeRecommendation({
      currentSizeId: "cx99-retired",
      sizes: catalog,
      utilisation: idle,
    });
    expect(rec).toBeNull();
  });

  it("never recommends across the family pattern's capture groups", () => {
    const rec = computeSizeRecommendation({
      currentSizeId: "cax11",
      sizes: catalog,
      utilisation: idle,
      sizeFamilyPattern: "^([a-z]+)",
    });
    // cax11 is already the smallest arm size — nothing to shrink to.
    expect(rec).toBeNull();
  });

  it("applies the unmeasured-memory floor instead of the memory gate", () => {
    const unmeasured = {
      cpuP95: 4,
      cpuSamples: MIN_SAMPLES,
      memoryP95: null,
      memoryMeasured: false,
    };
    const rec = computeSizeRecommendation({
      currentSizeId: "cx42",
      sizes: catalog,
      utilisation: unmeasured,
      sizeFamilyPattern: "^([a-z]+)",
      currentDiskGb: 40,
    });
    // Floor is 50% of 16 GB = 8 GB → cx22 (4 GB) is off the table, cx32 fits.
    expect(rec?.recommended.id).toBe("cx32");
    expect(rec?.projectedMemoryP95).toBeNull();
    expect(rec?.monthlySaving).toBeCloseTo(16.4 - 6.8);
  });

  it("skips candidates whose included disk is smaller than the current one", () => {
    const withBigDisk: RightsizingSizeOption[] = [
      { id: "big", label: "Big", vcpus: 4, memoryMb: 8192, diskGb: 320, priceMonthly: 20 },
      { id: "small", label: "Small", vcpus: 2, memoryMb: 8192, diskGb: 80, priceMonthly: 10 },
      {
        id: "small-fat-disk",
        label: "SmallFat",
        vcpus: 2,
        memoryMb: 8192,
        diskGb: 320,
        priceMonthly: 12,
      },
    ];
    const rec = computeSizeRecommendation({
      currentSizeId: "big",
      sizes: withBigDisk,
      utilisation: { cpuP95: 5, cpuSamples: MIN_SAMPLES, memoryP95: 10, memoryMeasured: true },
    });
    expect(rec?.recommended.id).toBe("small-fat-disk");
  });

  it("skips candidates not available in the resource's region", () => {
    const regional: RightsizingSizeOption[] = [
      { id: "cur", label: "Cur", vcpus: 4, memoryMb: 8192, priceMonthly: 40 },
      {
        id: "cheap",
        label: "Cheap",
        vcpus: 2,
        memoryMb: 4096,
        priceMonthly: 10,
        availableFor: ["nyc1"],
      },
      { id: "ok", label: "Ok", vcpus: 2, memoryMb: 4096, priceMonthly: 12, availableFor: ["fra1"] },
    ];
    const rec = computeSizeRecommendation({
      currentSizeId: "cur",
      sizes: regional,
      utilisation: { cpuP95: 5, cpuSamples: MIN_SAMPLES, memoryP95: 10, memoryMeasured: true },
      region: "fra1",
    });
    expect(rec?.recommended.id).toBe("ok");
  });

  it("never recommends an unpriced or non-cheaper candidate", () => {
    const odd: RightsizingSizeOption[] = [
      { id: "cur", label: "Cur", vcpus: 4, memoryMb: 8192, priceMonthly: 10 },
      { id: "unpriced", label: "U", vcpus: 2, memoryMb: 4096 },
      { id: "same-price", label: "S", vcpus: 2, memoryMb: 4096, priceMonthly: 10 },
    ];
    const rec = computeSizeRecommendation({
      currentSizeId: "cur",
      sizes: odd,
      utilisation: { cpuP95: 5, cpuSamples: MIN_SAMPLES, memoryP95: 10, memoryMeasured: true },
    });
    expect(rec).toBeNull();
  });

  it("never grows either axis, even when cheaper", () => {
    const odd: RightsizingSizeOption[] = [
      { id: "cur", label: "Cur", vcpus: 4, memoryMb: 8192, priceMonthly: 30 },
      { id: "wide", label: "W", vcpus: 8, memoryMb: 4096, priceMonthly: 5 },
      { id: "tall", label: "T", vcpus: 2, memoryMb: 16384, priceMonthly: 5 },
    ];
    const rec = computeSizeRecommendation({
      currentSizeId: "cur",
      sizes: odd,
      utilisation: { cpuP95: 5, cpuSamples: MIN_SAMPLES, memoryP95: 10, memoryMeasured: true },
    });
    expect(rec).toBeNull();
  });
});
