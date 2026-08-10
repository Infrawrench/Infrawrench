import { describe, expect, it } from "vitest";

import {
  mapEc2ReservedInstance,
  mapRdsReservedInstance,
  mapSavingsPlan,
  normalizeAwsCommitmentState,
} from "../commitments.js";

describe("normalizeAwsCommitmentState", () => {
  it("maps the documented states", () => {
    expect(normalizeAwsCommitmentState("active")).toBe("active");
    // Still applying discounts until the return settles.
    expect(normalizeAwsCommitmentState("pending-return")).toBe("active");
    expect(normalizeAwsCommitmentState("payment-pending")).toBe("queued");
    expect(normalizeAwsCommitmentState("queued")).toBe("queued");
    expect(normalizeAwsCommitmentState("payment-failed")).toBe("expired");
    expect(normalizeAwsCommitmentState("retired")).toBe("expired");
    expect(normalizeAwsCommitmentState("queued-deleted")).toBe("expired");
    expect(normalizeAwsCommitmentState("returned")).toBe("expired");
  });

  it("understates on unknown future states", () => {
    expect(normalizeAwsCommitmentState("some-new-state")).toBe("expired");
  });
});

describe("mapEc2ReservedInstance", () => {
  it("scales per-instance prices to the whole holding", () => {
    const record = mapEc2ReservedInstance(
      {
        reservedInstancesId: "ri-123",
        instanceType: "m5.xlarge",
        start: "2026-01-01T00:00:00.000Z",
        end: "2027-01-01T00:00:00.000Z",
        duration: "31536000",
        fixedPrice: "800.0",
        usagePrice: "0",
        instanceCount: "3",
        productDescription: "Linux/UNIX",
        state: "active",
        currencyCode: "USD",
        offeringType: "Partial Upfront",
        scope: "Region",
        recurringCharges: { item: [{ frequency: "Hourly", amount: "0.05" }] },
      },
      "us-east-1",
    )!;
    // fixedPrice/usagePrice are PER INSTANCE — the record covers all three.
    expect(record.upfrontAmount).toBeCloseTo(2400);
    expect(record.recurringAmount).toBeCloseTo(0.15);
    expect(record.recurringPeriod).toBe("hour");
    expect(record.termDays).toBe(365);
    expect(record.paymentOption).toBe("partial_upfront");
    expect(record.kind).toBe("reservation");
    // No ARN in the EC2 response — the bare id IS the billing join key.
    expect(record.id).toBe("ri-123");
    expect(record.region).toBe("us-east-1");
    expect(record.scope).toBeUndefined();
  });

  it("keeps the AZ as scope for zonal reservations", () => {
    const record = mapEc2ReservedInstance(
      {
        reservedInstancesId: "ri-9",
        availabilityZone: "us-east-1b",
        start: "2026-01-01T00:00:00.000Z",
        state: "active",
      },
      "us-east-1",
    )!;
    expect(record.scope).toBe("us-east-1b");
  });

  it("omits the payment option for legacy utilization offering types", () => {
    const record = mapEc2ReservedInstance(
      {
        reservedInstancesId: "ri-old",
        start: "2026-01-01T00:00:00.000Z",
        offeringType: "Heavy Utilization",
        state: "retired",
      },
      "eu-west-1",
    )!;
    expect(record.paymentOption).toBeUndefined();
    expect(record.state).toBe("expired");
  });
});

describe("mapRdsReservedInstance", () => {
  it("prefers the ARN (the CUR's join key) and derives the end from start + duration", () => {
    const record = mapRdsReservedInstance(
      {
        ReservedDBInstanceId: "myreservation",
        ReservedDBInstanceArn: "arn:aws:rds:us-east-1:123:ri:myreservation",
        DBInstanceClass: "db.r5.large",
        StartTime: "2026-01-01T00:00:00.000Z",
        Duration: "94608000",
        FixedPrice: "1000",
        UsagePrice: "0",
        CurrencyCode: "USD",
        DBInstanceCount: "2",
        ProductDescription: "postgresql",
        OfferingType: "All Upfront",
        MultiAZ: "true",
        State: "active",
      },
      "us-east-1",
    )!;
    expect(record.id).toBe("arn:aws:rds:us-east-1:123:ri:myreservation");
    // RDS reports no end time; start + duration is exact arithmetic.
    expect(record.endDate).toBe("2028-12-31T00:00:00.000Z");
    expect(record.termDays).toBe(1095);
    expect(record.upfrontAmount).toBeCloseTo(2000);
    expect(record.paymentOption).toBe("all_upfront");
  });
});

describe("mapSavingsPlan", () => {
  const base = {
    savingsPlanId: "sp-1",
    savingsPlanArn: "arn:aws:savingsplans::123:savingsplan/sp-1",
    start: "2026-01-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z",
    termDurationInSeconds: 31536000,
    paymentOption: "No Upfront",
    currency: "USD",
    commitment: "12.50",
    upfrontPaymentAmount: "0",
    state: "active",
  };

  it("maps the hourly commitment and never a region onto a Compute plan", () => {
    const record = mapSavingsPlan({ ...base, savingsPlanType: "Compute", region: "us-east-1" })!;
    expect(record.hourlyCommitmentAmount).toBeCloseTo(12.5);
    // A Compute plan applies across regions — absent region is that state.
    expect(record.region).toBeUndefined();
    expect(record.kind).toBe("savings_plan");
    expect(record.id).toBe("arn:aws:savingsplans::123:savingsplan/sp-1");
    expect(record.termDays).toBe(365);
    expect(record.paymentOption).toBe("no_upfront");
  });

  it("keeps the region on an instance-scoped plan", () => {
    const record = mapSavingsPlan({
      ...base,
      savingsPlanType: "EC2Instance",
      region: "eu-west-1",
      ec2InstanceFamily: "m5",
    })!;
    expect(record.region).toBe("eu-west-1");
    expect(record.scope).toBe("m5");
  });

  it("never maps recurringPaymentAmount — its period is documented nowhere", () => {
    const record = mapSavingsPlan({
      ...base,
      savingsPlanType: "Compute",
      // Deliberately fed a plausible-looking field the mapper must ignore:
      // guessing hourly vs monthly is a 730× error.
      ...({ recurringPaymentAmount: "12.50" } as object),
    })!;
    expect(record.recurringAmount).toBeUndefined();
    expect(record.recurringPeriod).toBeUndefined();
  });

  it("maps retirement-shaped states to expired and returns queued plans", () => {
    expect(mapSavingsPlan({ ...base, state: "queued" })!.state).toBe("queued");
    expect(mapSavingsPlan({ ...base, state: "retired" })!.state).toBe("expired");
    expect(mapSavingsPlan({ ...base, state: "pending-return" })!.state).toBe("active");
  });
});
