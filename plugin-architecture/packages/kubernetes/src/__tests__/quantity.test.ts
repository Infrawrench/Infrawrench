import { describe, it, expect } from "vitest";

import {
  BYTES_PER_GIB,
  addPairs,
  formatCores,
  formatMemory,
  maxPairs,
  parseQuantity,
  parseQuantityOrZero,
  parseResourceMap,
} from "../quantity.js";

describe("parseQuantity", () => {
  it("parses plain numbers", () => {
    expect(parseQuantity("1")).toBe(1);
    expect(parseQuantity("0")).toBe(0);
    expect(parseQuantity("1.5")).toBe(1.5);
    expect(parseQuantity(".5")).toBe(0.5);
    expect(parseQuantity("12.")).toBe(12);
  });

  it("parses signs", () => {
    expect(parseQuantity("+2")).toBe(2);
    expect(parseQuantity("-2")).toBe(-2);
    expect(parseQuantity("-500m")).toBe(-0.5);
  });

  describe("decimal SI suffixes are powers of 1000", () => {
    const cases: Array<[string, number]> = [
      ["1n", 1e-9],
      ["1u", 1e-6],
      ["1m", 1e-3],
      ["1k", 1e3],
      ["1M", 1e6],
      ["1G", 1e9],
      ["1T", 1e12],
      ["1P", 1e15],
      ["1E", 1e18],
    ];
    for (const [input, expected] of cases) {
      it(`${input} = ${expected}`, () => {
        expect(parseQuantity(input)).toBeCloseTo(expected, 12);
      });
    }
  });

  describe("binary SI suffixes are powers of 1024", () => {
    const cases: Array<[string, number]> = [
      ["1Ki", 1024],
      ["1Mi", 1024 ** 2],
      ["1Gi", 1024 ** 3],
      ["1Ti", 1024 ** 4],
      ["1Pi", 1024 ** 5],
      ["1Ei", 1024 ** 6],
    ];
    for (const [input, expected] of cases) {
      it(`${input} = ${expected}`, () => {
        expect(parseQuantity(input)).toBe(expected);
      });
    }
  });

  // The whole reason this module exists. A 1024-vs-1000 slip is invisible in
  // the output and wrong by a consistent few percent in one direction.
  it("does NOT confuse binary and decimal at the same letter", () => {
    expect(parseQuantity("512Mi")).toBe(536_870_912);
    expect(parseQuantity("512M")).toBe(512_000_000);
    expect(parseQuantity("512Mi")).not.toBe(parseQuantity("512M"));

    expect(parseQuantity("1Ki")).toBe(1024);
    expect(parseQuantity("1k")).toBe(1000);

    expect(parseQuantity("2Gi")).toBe(2 * BYTES_PER_GIB);
    expect(parseQuantity("2G")).toBe(2e9);
  });

  it("rejects uppercase K, which is not a valid decimal suffix", () => {
    // apimachinery's grammar has lowercase `k` for kilo and no `K` at all.
    // Guessing it means 1000 would quietly accept malformed manifests.
    expect(parseQuantity("1K")).toBeNull();
  });

  it("parses the decimal-exponent form", () => {
    expect(parseQuantity("1e3")).toBe(1000);
    expect(parseQuantity("1E3")).toBe(1000);
    expect(parseQuantity("1.5e3")).toBe(1500);
    expect(parseQuantity("1e-3")).toBeCloseTo(0.001, 12);
    expect(parseQuantity("2e+2")).toBe(200);
  });

  it("distinguishes the exa suffix from an exponent", () => {
    // "1E" is 1 exa; "1E3" is 1000. Same letter, different meanings, and the
    // regex ordering is what keeps them apart.
    expect(parseQuantity("1E")).toBe(1e18);
    expect(parseQuantity("1E3")).toBe(1000);
  });

  it("parses CPU millicores", () => {
    expect(parseQuantity("100m")).toBeCloseTo(0.1, 12);
    expect(parseQuantity("250m")).toBeCloseTo(0.25, 12);
    expect(parseQuantity("1500m")).toBeCloseTo(1.5, 12);
    expect(parseQuantity("2")).toBe(2);
  });

  it("parses the nano-core form metrics.k8s.io emits", () => {
    // NodeMetrics reports cpu as e.g. "487558164n".
    expect(parseQuantity("487558164n")).toBeCloseTo(0.487558164, 9);
    expect(parseQuantity("1000000000n")).toBeCloseTo(1, 9);
  });

  it("trims surrounding whitespace", () => {
    expect(parseQuantity("  512Mi  ")).toBe(536_870_912);
  });

  it("returns null rather than a guess for junk", () => {
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("   ")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("512MiB")).toBeNull();
    expect(parseQuantity("12x")).toBeNull();
    expect(parseQuantity("1.2.3")).toBeNull();
    expect(parseQuantity("Mi")).toBeNull();
    expect(parseQuantity("1e")).toBeNull();
    expect(parseQuantity(undefined)).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });

  it("passes finite numbers through and rejects non-finite ones", () => {
    expect(parseQuantity(42)).toBe(42);
    expect(parseQuantity(NaN)).toBeNull();
    expect(parseQuantity(Infinity)).toBeNull();
  });

  it("null and zero stay distinguishable, but orZero collapses them", () => {
    expect(parseQuantity("nonsense")).toBeNull();
    expect(parseQuantityOrZero("nonsense")).toBe(0);
    expect(parseQuantityOrZero("0")).toBe(0);
  });
});

describe("parseResourceMap", () => {
  it("reads cpu and memory into base units", () => {
    expect(parseResourceMap({ cpu: "250m", memory: "512Mi" })).toEqual({
      cpuCores: 0.25,
      memoryBytes: 536_870_912,
    });
  });

  it("treats a missing dimension as zero", () => {
    expect(parseResourceMap({ cpu: "1" })).toEqual({ cpuCores: 1, memoryBytes: 0 });
    expect(parseResourceMap(undefined)).toEqual({ cpuCores: 0, memoryBytes: 0 });
  });

  it("ignores dimensions it does not model", () => {
    expect(parseResourceMap({ cpu: "1", "nvidia.com/gpu": "2" })).toEqual({
      cpuCores: 1,
      memoryBytes: 0,
    });
  });
});

describe("pair arithmetic", () => {
  it("adds componentwise", () => {
    expect(addPairs({ cpuCores: 1, memoryBytes: 10 }, { cpuCores: 2, memoryBytes: 5 })).toEqual({
      cpuCores: 3,
      memoryBytes: 15,
    });
  });

  it("takes the max per dimension, not of a pair as a whole", () => {
    expect(maxPairs({ cpuCores: 1, memoryBytes: 10 }, { cpuCores: 2, memoryBytes: 5 })).toEqual({
      cpuCores: 2,
      memoryBytes: 10,
    });
  });
});

describe("formatting", () => {
  it("formats cores as millicores below 1", () => {
    expect(formatCores(0)).toBe("0");
    expect(formatCores(0.25)).toBe("250m");
    expect(formatCores(0.1)).toBe("100m");
    expect(formatCores(1)).toBe("1");
    expect(formatCores(1.5)).toBe("1.5");
    expect(formatCores(2.333)).toBe("2.33");
  });

  it("formats memory in GiB or MiB", () => {
    expect(formatMemory(0)).toBe("0");
    expect(formatMemory(536_870_912)).toBe("512Mi");
    expect(formatMemory(BYTES_PER_GIB)).toBe("1Gi");
    expect(formatMemory(2.5 * BYTES_PER_GIB)).toBe("2.5Gi");
  });
});
