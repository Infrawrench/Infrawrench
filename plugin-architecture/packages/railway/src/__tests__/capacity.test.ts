import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapWorkspace } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import type { RwCustomer } from "../types.js";

const WORKSPACE = { id: "w1", name: "acme" };

describe("workspace usage against the hard limit", () => {
  const type = RESOURCE_TYPES.find((t) => t.id === "workspace")!;
  const decl = capacityDeclarations(type).find((d) => d.key === "currentUsage")!;

  it("stores this period's usage, the hard limit and the period bounds", () => {
    const customer = {
      id: "c1",
      creditBalance: 0,
      currentUsage: 12.345,
      billingPeriod: { start: "2026-11-05T00:00:00Z", end: "2026-12-05T00:00:00Z" },
      usageLimit: { softLimit: 20, hardLimit: 50, isOverLimit: false },
    } as RwCustomer;
    const ws = mapWorkspace(WORKSPACE, customer, "acct");
    expect(ws.fields).toMatchObject({
      currentUsage: 12.35,
      hardLimit: 50,
      billingPeriodStart: "2026-11-05T00:00:00Z",
      billingPeriodEnd: "2026-12-05T00:00:00Z",
    });
    expect(resolveCapacityLimit(decl.declaration.limit, ws.fields)?.limit).toBe(50);
    expect(decl.declaration.cycle).toMatchObject({ startField: "billingPeriodStart" });
  });

  it("states no ceiling when no hard limit is set", () => {
    const ws = mapWorkspace(
      WORKSPACE,
      { id: "c1", currentUsage: 3, usageLimit: null } as unknown as RwCustomer,
      "acct",
    );
    expect(resolveCapacityLimit(decl.declaration.limit, ws.fields)).toBeNull();
  });
});
