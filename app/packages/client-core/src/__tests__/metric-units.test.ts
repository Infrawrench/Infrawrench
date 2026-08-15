import { describe, expect, it } from "vitest";
import { createMetricValueFormatter } from "../metric-units";

describe("createMetricValueFormatter", () => {
  it("humanizes bytes into a single scale chosen from the axis max", () => {
    // The reported bug: a droplet memory axis topping out around 8 GiB
    // rendered raw byte counts like "8589934592bytes" in a 50px gutter.
    const maxBytes = 8 * 1024 ** 3;
    const format = createMetricValueFormatter("bytes", maxBytes);
    expect(format(maxBytes)).toBe("8.00 GiB");
    expect(format(4 * 1024 ** 3)).toBe("4.00 GiB");
    expect(format(0)).toBe("0.00 GiB");
  });

  it("keeps every tick in the same unit instead of rescaling per value", () => {
    const format = createMetricValueFormatter("bytes", 3 * 1024 ** 3);
    // A small tick near zero must not fall back to KiB/MiB just because it's
    // small in isolation — the whole axis reads in GiB.
    expect(format(1024)).toBe("0.00 GiB");
    expect(format(1.5 * 1024 ** 3)).toBe("1.50 GiB");
  });

  it("suffixes a rate unit without treating it as a different scale", () => {
    const maxBps = 50 * 1024 * 1024; // 50 MiB/s
    const format = createMetricValueFormatter("bytes/s", maxBps);
    expect(format(maxBps)).toBe("50.0 MiB/s");
    expect(format(0)).toBe("0.00 MiB/s");
  });

  it("picks B for sub-KiB axes", () => {
    const format = createMetricValueFormatter("bytes", 512);
    expect(format(512)).toBe("512 B");
    expect(format(0)).toBe("0 B");
  });

  it("picks TiB/PiB for very large axes", () => {
    const tib = createMetricValueFormatter("bytes", 5 * 1024 ** 4);
    expect(tib(5 * 1024 ** 4)).toBe("5.00 TiB");
    const pib = createMetricValueFormatter("bytes", 2 * 1024 ** 5);
    expect(pib(2 * 1024 ** 5)).toBe("2.00 PiB");
  });

  it("leaves non-byte units formatted exactly as before (value directly against unit)", () => {
    const percent = createMetricValueFormatter("%", 100);
    expect(percent(45)).toBe("45%");
    const count = createMetricValueFormatter("connections", 42);
    expect(count(42)).toBe("42connections");
  });

  it("handles a missing unit", () => {
    const format = createMetricValueFormatter("", 10);
    expect(format(7)).toBe("7");
  });

  it("treats an all-zero axis as B rather than dividing by a zero-derived scale", () => {
    const format = createMetricValueFormatter("bytes", 0);
    expect(format(0)).toBe("0 B");
  });
});
