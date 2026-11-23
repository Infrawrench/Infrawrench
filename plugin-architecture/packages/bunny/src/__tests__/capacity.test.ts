import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { pullZoneInstance } from "../mappers.js";
import { PullZoneResourceType } from "../resource-types.js";

const GB = 1024 ** 3;

describe("pull zone bandwidth runway", () => {
  it("measures this month's bandwidth against the zone's monthly limit", () => {
    const zone = pullZoneInstance("acct", {
      Id: 7,
      Name: "assets",
      MonthlyBandwidthUsed: 40 * GB,
      MonthlyBandwidthLimit: 100 * GB,
    } as never);
    const [decl] = capacityDeclarations(PullZoneResourceType);
    expect(decl!.valueKey).toBe("monthlyBandwidthUsed");
    expect(decl!.declaration.cycle).toEqual({ period: "monthly", anchorDay: 1 });
    expect(zone.fields["monthlyBandwidthUsed"]).toBe(40 * GB);
    expect(resolveCapacityLimit(decl!.declaration.limit, zone.fields)?.limit).toBe(100 * GB);
  });

  it("states no limit for a zone without one", () => {
    const zone = pullZoneInstance("acct", {
      Id: 7,
      Name: "assets",
      MonthlyBandwidthUsed: 40 * GB,
      MonthlyBandwidthLimit: 0,
    } as never);
    const [decl] = capacityDeclarations(PullZoneResourceType);
    expect(resolveCapacityLimit(decl!.declaration.limit, zone.fields)).toBeNull();
  });
});
