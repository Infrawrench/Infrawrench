import { describe, expect, it } from "vitest";

import { ciGpuKey, ciGpuMatches, parseCiGpu } from "../ci-gpu.js";

describe("CI GPU requests", () => {
  it("reads a type and a count", () => {
    expect(parseCiGpu("H100")).toEqual({ type: "H100", count: 1 });
    expect(parseCiGpu(" a100-80gb:2 ")).toEqual({ type: "a100-80gb", count: 2 });
    expect(() => parseCiGpu(":2")).toThrow("no GPU type");
    expect(() => parseCiGpu("h100:0")).toThrow("from 1 to 64");
    expect(() => parseCiGpu("h100:two")).toThrow("from 1 to 64");
  });

  it("matches provider names word by word", () => {
    expect(ciGpuKey("NVIDIA H100 80GB HBM3")).toBe("h10080gbhbm3");
    expect(ciGpuMatches("h100", "NVIDIA H100 80GB HBM3")).toBe(true);
    expect(ciGpuMatches("H100", "H100 SXM")).toBe(true);
    expect(ciGpuMatches("a100-80gb", "NVIDIA A100 80GB PCIe")).toBe(true);
    expect(ciGpuMatches("rtxa6000", "NVIDIA RTX A6000")).toBe(true);
    expect(ciGpuMatches("RTX 4090", "NVIDIA GeForce RTX 4090")).toBe(true);
    expect(ciGpuMatches("a10", "NVIDIA A100 80GB PCIe")).toBe(false);
    expect(ciGpuMatches("h100", "H1000")).toBe(false);
    expect(ciGpuMatches("", "H100")).toBe(false);
  });
});
