import { describe, expect, it } from "vitest";
import { RESTORE_ANNOTATION, parsePrefixes } from "../mappers.js";
import {
  buildNodePoolSpec,
  restorePatch,
  scaleToZeroPatch,
  validatePoolName,
  validatePoolSize,
  wholeNumber,
} from "../node-pools.js";
import { instanceHourRate, nodeHourlyRatesJson, parseNegotiatedRates } from "../rates.js";

describe("negotiated rates", () => {
  it("parses instance, per-plan and non-compute rates", () => {
    const r = parseNegotiatedRates(
      "gd-8xh100ib-i128=35.5, spot/gd-8xh100ib-i128=$20\nstorage=0.05, objectStorage=0.04, ip=3, junk",
    );
    expect(r.instance["gd-8xh100ib-i128"]).toBe(35.5);
    expect(r.byPlan.spot["gd-8xh100ib-i128"]).toBe(20);
    expect(r.storageGbMonth).toBe(0.05);
    expect(r.objectGbMonth).toBe(0.04);
    expect(r.ipMonth).toBe(3);
  });

  it("prefers a plan rate, then a flat rate, then the list price", () => {
    const r = parseNegotiatedRates("gd-8xh100ib-i128=35, spot/gd-8xh100ib-i128=20");
    expect(instanceHourRate(r, "gd-8xh100ib-i128", "spot")).toEqual({
      rate: 20,
      source: "negotiated",
    });
    expect(instanceHourRate(r, "gd-8xh100ib-i128", "reserved")).toEqual({
      rate: 35,
      source: "negotiated",
    });
    expect(instanceHourRate(r, "gd-8xa100-i128", "on-demand")).toEqual({
      rate: 21.6,
      source: "list",
    });
    expect(instanceHourRate(r, "gb300-4x").source).toBe("unpriced");
  });

  it("emits a node rate table the Kubernetes peer can read", () => {
    const json = JSON.parse(
      nodeHourlyRatesJson(parseNegotiatedRates(""), ["gd-8xh100ib-i128", "gb300-4x"]),
    ) as { source: string; byInstanceType: Record<string, number> };
    expect(json.source).toBe("list-price");
    expect(json.byInstanceType).toEqual({ "gd-8xh100ib-i128": 49.24 });
    const manual = JSON.parse(
      nodeHourlyRatesJson(parseNegotiatedRates("gd-8xh100ib-i128=30"), ["gd-8xh100ib-i128"]),
    ) as { source: string };
    expect(manual.source).toBe("manual");
  });
});

describe("Node Pool sizing", () => {
  it("requires whole racks of 18 for NVL72 types and refuses autoscaling on them", () => {
    expect(() =>
      validatePoolSize({ instanceType: "gb200-4x", targetNodes: 20, autoscaling: false }),
    ).toThrow(/multiple of 18/);
    expect(() =>
      validatePoolSize({ instanceType: "gb200-4x", targetNodes: 36, autoscaling: false }),
    ).not.toThrow();
    expect(() =>
      validatePoolSize({
        instanceType: "gb300-4x",
        targetNodes: 18,
        autoscaling: true,
        minNodes: 18,
        maxNodes: 36,
      }),
    ).toThrow(/does not autoscale/);
  });

  it("keeps the target inside the autoscaler bounds", () => {
    const base = { instanceType: "gd-8xh100ib-i128", autoscaling: true };
    expect(() => validatePoolSize({ ...base, targetNodes: 5, minNodes: 1, maxNodes: 4 })).toThrow(
      /between/,
    );
    expect(() => validatePoolSize({ ...base, targetNodes: 2, minNodes: 3, maxNodes: 1 })).toThrow(
      /minimum/,
    );
    expect(() => validatePoolSize({ ...base, targetNodes: 2 })).toThrow(/minimum and maximum/);
    expect(() =>
      validatePoolSize({ ...base, targetNodes: 2, minNodes: 1, maxNodes: 4 }),
    ).not.toThrow();
    expect(() =>
      validatePoolSize({ instanceType: "gd-8xh100ib-i128", autoscaling: false }),
    ).toThrow(/Target Nodes/);
  });

  it("rejects negative and fractional sizes", () => {
    expect(() => wholeNumber("Target Nodes", "-1")).toThrow(/whole number/);
    expect(() => wholeNumber("Target Nodes", "1.5")).toThrow(/whole number/);
    expect(wholeNumber("Target Nodes", "")).toBeUndefined();
    expect(wholeNumber("Target Nodes", "3")).toBe(3);
  });

  it("builds a spot spec with autoscaler bounds", () => {
    expect(
      buildNodePoolSpec(
        {
          instanceType: "gd-8xh100ib-i128",
          autoscaling: true,
          minNodes: 1,
          maxNodes: 4,
          computeClass: "spot",
        },
        "570",
      ),
    ).toEqual({
      computeClass: "spot",
      instanceType: "gd-8xh100ib-i128",
      targetNodes: 1,
      autoscaling: true,
      minNodes: 1,
      maxNodes: 4,
      gpu: { version: "570" },
    });
  });

  it("validates pool names", () => {
    expect(validatePoolName("h100-pool")).toBeNull();
    expect(validatePoolName("H100_Pool")).not.toBeNull();
  });

  it("scales to zero and restores the remembered size", () => {
    const pool = {
      metadata: { name: "p" },
      spec: {
        instanceType: "gd-8xh100ib-i128",
        targetNodes: 3,
        autoscaling: true,
        minNodes: 1,
        maxNodes: 5,
      },
    };
    const down = scaleToZeroPatch(pool) as {
      metadata: { annotations: Record<string, string> };
      spec: Record<string, unknown>;
    };
    expect(down.spec).toEqual({ targetNodes: 0, autoscaling: false, minNodes: 0 });
    const scaled = {
      metadata: { name: "p", annotations: down.metadata.annotations },
      spec: { instanceType: "gd-8xh100ib-i128", targetNodes: 0, autoscaling: false },
    };
    expect(restorePatch(scaled)).toEqual({
      metadata: { annotations: { [RESTORE_ANNOTATION]: null } },
      spec: { targetNodes: 3, autoscaling: true, minNodes: 1, maxNodes: 5 },
    });
    expect(() => restorePatch({ spec: { targetNodes: 0 } })).toThrow(/no size to restore/);
  });
});

describe("VPC prefixes", () => {
  it("parses name=CIDR lists and rejects malformed entries", () => {
    expect(parsePrefixes("pod cidr=10.0.0.0/13, service cidr=10.16.0.0/22")).toEqual([
      { name: "pod cidr", value: "10.0.0.0/13" },
      { name: "service cidr", value: "10.16.0.0/22" },
    ]);
    expect(() => parsePrefixes("pods")).toThrow(/name=CIDR/);
    expect(() => parsePrefixes("pods=10.0.0.0")).toThrow(/CIDR/);
  });
});
