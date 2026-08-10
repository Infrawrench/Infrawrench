import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AWS_COVERED_RECORD_TYPES,
  AWS_ON_DEMAND_RECORD_TYPES,
  AWS_USAGE_RECORD_TYPES,
  fetchAwsCostData,
  mapAwsRecordType,
} from "../cost-data.js";

const creds = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "eu-west-1" };

afterEach(() => vi.restoreAllMocks());

// ─── Helpers ────────────────────────────────────────────────────────────────

interface GroupSpec {
  keys: string[];
  unblended?: string;
  amortized?: string;
  unit?: string;
  /** Omit the `AmortizedCost` metric entirely — "CE had no opinion". */
  noAmortized?: boolean;
}

function ceResponse(
  days: Array<{ date: string; groups: GroupSpec[] }>,
  nextPageToken?: string,
): Response {
  return new Response(
    JSON.stringify({
      ResultsByTime: days.map((day) => ({
        TimePeriod: { Start: day.date, End: day.date },
        Groups: day.groups.map((g) => ({
          Keys: g.keys,
          Metrics: {
            UnblendedCost: { Amount: g.unblended ?? "0", Unit: g.unit ?? "USD" },
            ...(g.noAmortized
              ? {}
              : {
                  AmortizedCost: {
                    Amount: g.amortized ?? g.unblended ?? "0",
                    Unit: g.unit ?? "USD",
                  },
                }),
          },
        })),
      })),
      ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
    }),
    { status: 200 },
  );
}

/** Every request body global fetch was handed, parsed. */
function sentBodies(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return (spy.mock.calls as Array<[string, RequestInit]>).map(
    ([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>,
  );
}

const RANGE = { fromDate: "2026-07-01", toDate: "2026-07-02" };

// ─── The mapping table ──────────────────────────────────────────────────────

describe("mapAwsRecordType", () => {
  it("separates covered consumption from on-demand consumption", () => {
    // All three are consumption — the commitment shows up in the rate, not in
    // the row's nature — but "was this hour covered" is the only thing Cost
    // Explorer will ever say about coverage (SAVINGS_PLAN_ARN and
    // RESERVATION_ID cannot be grouped by), so the two covered record types
    // must stay distinguishable from on-demand usage.
    expect(mapAwsRecordType("Usage")).toBe("usage");
    expect(mapAwsRecordType("DiscountedUsage")).toBe("commitment_covered_usage");
    expect(mapAwsRecordType("SavingsPlanCoveredUsage")).toBe("commitment_covered_usage");
  });

  it("keeps the union of the two consumption filters as pass 2's complement", () => {
    // Pass 2 is the literal Not of AWS_USAGE_RECORD_TYPES, so splitting the
    // consumption passes must not lose or duplicate a token.
    expect(AWS_USAGE_RECORD_TYPES).toEqual([
      ...AWS_ON_DEMAND_RECORD_TYPES,
      ...AWS_COVERED_RECORD_TYPES,
    ]);
    expect(new Set(AWS_USAGE_RECORD_TYPES).size).toBe(AWS_USAGE_RECORD_TYPES.length);
  });

  it("maps commitment purchases to commitment_fee", () => {
    expect(mapAwsRecordType("RIFee")).toBe("commitment_fee");
    expect(mapAwsRecordType("Fee")).toBe("commitment_fee");
    expect(mapAwsRecordType("SavingsPlanUpfrontFee")).toBe("commitment_fee");
    expect(mapAwsRecordType("SavingsPlanRecurringFee")).toBe("commitment_fee");
  });

  it("maps only the savings-plan negation line to commitment_discount", () => {
    // AWS writes an explicit negative offset for Savings Plans. Reserved
    // Instances have no equivalent line — their discount is inside
    // DiscountedUsage's rate — so nothing else lands here.
    expect(mapAwsRecordType("SavingsPlanNegation")).toBe("commitment_discount");
  });

  it("maps the rest of the documented bill", () => {
    expect(mapAwsRecordType("Credit")).toBe("credit");
    expect(mapAwsRecordType("Refund")).toBe("refund");
    expect(mapAwsRecordType("Tax")).toBe("tax");
    expect(mapAwsRecordType("Support")).toBe("support");
  });

  it("accepts the console's labels as well as the CUR's tokens", () => {
    expect(mapAwsRecordType("Savings Plan covered usage")).toBe("commitment_covered_usage");
    expect(mapAwsRecordType("Reservation applied usage")).toBe("commitment_covered_usage");
    expect(mapAwsRecordType("Savings Plan negation")).toBe("commitment_discount");
    expect(mapAwsRecordType("Recurring reservation fee")).toBe("commitment_fee");
    expect(mapAwsRecordType("Upfront reservation fee")).toBe("commitment_fee");
    expect(mapAwsRecordType("Support fee")).toBe("support");
  });

  it("sends AWS's discount families and anything unknown to other, never usage", () => {
    // Our union has no discount member. `credit` would be a near-miss that
    // makes a negotiated rate look like spent promotional balance.
    expect(mapAwsRecordType("Discount")).toBe("other");
    expect(mapAwsRecordType("BundledDiscount")).toBe("other");
    expect(mapAwsRecordType("Distributor Discount")).toBe("other");
    expect(mapAwsRecordType("Enterprise Discount Program Discount")).toBe("other");
    // Documented, but nothing in the union describes it.
    expect(mapAwsRecordType("FlatRateSubscription")).toBe("other");
    expect(mapAwsRecordType("Other out-of-cycle charges")).toBe("other");
    // Whatever AWS invents next. Defaulting to `usage` would overstate
    // consumption, which every other reading is built on.
    expect(mapAwsRecordType("QuantumComputeRebate")).toBe("other");
    expect(mapAwsRecordType("")).toBe("other");
  });
});

// ─── Request shape ──────────────────────────────────────────────────────────

describe("fetchAwsCostData request shape", () => {
  it("issues three requests: on-demand and covered usage by region, the rest by record type", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]));

    await fetchAwsCostData(creds, RANGE);

    expect(spy).toHaveBeenCalledTimes(3);
    const [onDemand, covered, pass2] = sentBodies(spy);

    // Both metrics ride on one request — CE bills per request, not per metric.
    expect(onDemand!["Metrics"]).toEqual(["UnblendedCost", "AmortizedCost"]);
    // Both consumption passes keep the region; only their filters differ,
    // which is the whole reason they are two requests rather than one.
    for (const pass of [onDemand, covered]) {
      expect(pass!["GroupBy"]).toEqual([
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "REGION" },
      ]);
    }
    expect(onDemand!["Filter"]).toEqual({
      Dimensions: { Key: "RECORD_TYPE", Values: AWS_ON_DEMAND_RECORD_TYPES },
    });
    expect(covered!["Filter"]).toEqual({
      Dimensions: { Key: "RECORD_TYPE", Values: AWS_COVERED_RECORD_TYPES },
    });

    expect(pass2!["GroupBy"]).toEqual([
      { Type: "DIMENSION", Key: "SERVICE" },
      { Type: "DIMENSION", Key: "RECORD_TYPE" },
    ]);
    // The exact complement of the two consumption passes taken together —
    // nothing is dropped, nothing doubles.
    expect(pass2!["Filter"]).toEqual({
      Not: { Dimensions: { Key: "RECORD_TYPE", Values: AWS_USAGE_RECORD_TYPES } },
    });

    // End is exclusive; the host's toDate is inclusive.
    for (const pass of [onDemand, covered, pass2]) {
      expect(pass!["TimePeriod"]).toEqual({ Start: "2026-07-01", End: "2026-07-03" });
    }
  });

  it("paginates each pass independently, keeping its own filter across pages", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      // Pass 1, page 1 of 2.
      .mockResolvedValueOnce(
        ceResponse(
          [{ date: "2026-07-01", groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "1" }] }],
          "p1-token",
        ),
      )
      // Pass 1a, page 2.
      .mockResolvedValueOnce(
        ceResponse([
          { date: "2026-07-01", groups: [{ keys: ["AmazonS3", "us-east-1"], unblended: "2" }] },
        ]),
      )
      // Pass 1b — covered usage, one page, nothing in it.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      // Pass 2, page 1 of 2.
      .mockResolvedValueOnce(
        ceResponse(
          [{ date: "2026-07-01", groups: [{ keys: ["AmazonEC2", "Tax"], unblended: "3" }] }],
          "p2-token",
        ),
      )
      // Pass 2, page 2.
      .mockResolvedValueOnce(
        ceResponse([
          { date: "2026-07-01", groups: [{ keys: ["AmazonS3", "Credit"], unblended: "-4" }] },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    expect(spy).toHaveBeenCalledTimes(5);
    const bodies = sentBodies(spy);
    expect(bodies[0]!["NextPageToken"]).toBeUndefined();
    expect(bodies[1]!["NextPageToken"]).toBe("p1-token");
    expect(bodies[4]!["NextPageToken"]).toBe("p2-token");
    // CE rejects a paginated request whose parameters changed, so page 2 of a
    // pass must carry that pass's grouping and filter verbatim.
    expect(bodies[1]!["GroupBy"]).toEqual(bodies[0]!["GroupBy"]);
    expect(bodies[1]!["Filter"]).toEqual(bodies[0]!["Filter"]);
    expect(bodies[4]!["GroupBy"]).toEqual(bodies[3]!["GroupBy"]);
    expect(bodies[4]!["Filter"]).toEqual(bodies[3]!["Filter"]);

    expect(
      rows
        .filter((r) => r.chargeType === "usage" && r.amount !== 0)
        .map((r) => r.service)
        .sort(),
    ).toEqual(["AmazonEC2", "AmazonS3"]);
    expect(rows.find((r) => r.chargeType === "tax")?.amount).toBe(3);
    expect(rows.find((r) => r.chargeType === "credit")?.amount).toBe(-4);
  });
});

// ─── Row mapping ────────────────────────────────────────────────────────────

describe("fetchAwsCostData rows", () => {
  it("keeps the region on usage rows and normalizes CE's pseudo-regions", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [
              { keys: ["AmazonEC2", "eu-west-1"], unblended: "10.5", amortized: "10.5" },
              { keys: ["AWSDataTransfer", "NoRegion"], unblended: "1.25", amortized: "1.25" },
              { keys: ["AmazonRoute53", "global"], unblended: "0.5", amortized: "0.5" },
            ],
          },
        ]),
      )
      // Pass 1b and pass 2 are both empty here.
      .mockImplementation(async () => ceResponse([{ date: "2026-07-01", groups: [] }]));

    const { rows } = await fetchAwsCostData(creds, RANGE);

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.chargeType === "usage")).toBe(true);
    expect(rows.find((r) => r.service === "AmazonEC2")).toMatchObject({
      date: "2026-07-01",
      region: "eu-west-1",
      currency: "USD",
      amount: 10.5,
      amortizedAmount: 10.5,
    });
    expect(rows.find((r) => r.service === "AWSDataTransfer")?.region).toBe("");
    expect(rows.find((r) => r.service === "AmazonRoute53")?.region).toBe("");
  });

  it("keeps RI-covered usage, whose unblended cost is zero by design", async () => {
    // AWS: "For Amazon EC2 and Amazon RDS line items that have an RI discount
    // applied to them, the UnblendedRate is zero." Asking for UnblendedCost
    // alone and skipping zeroes dropped these rows entirely — and a coverage
    // ratio built on the cash figure would read 0% for a fully reserved fleet.
    // The amortized amount is what the hour is actually worth, and the charge
    // type is what makes it countable as covered without a commitment id.
    vi.spyOn(globalThis, "fetch")
      // Pass 1a — no on-demand consumption at all; the fleet is fully covered.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      // Pass 1b — the covered hours.
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "0", amortized: "7.2" }],
          },
        ]),
      )
      .mockImplementation(async () => ceResponse([{ date: "2026-07-01", groups: [] }]));

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const ec2 = rows.find((r) => r.service === "AmazonEC2" && r.region === "us-east-1");
    expect(ec2).toMatchObject({
      amount: 0,
      amortizedAmount: 7.2,
      chargeType: "commitment_covered_usage",
      region: "us-east-1",
    });
    // No commitment id is claimed: Cost Explorer cannot group by one.
    expect(ec2?.commitmentId).toBeUndefined();
  });

  it("keeps on-demand and covered consumption in the same cell apart", async () => {
    // A half-reserved fleet: both passes return the same (service, region),
    // and merging them would make coverage unmeasurable for exactly the estates
    // that have bought something.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "4", amortized: "4" }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "0", amortized: "6" }],
          },
        ]),
      )
      .mockImplementation(async () => ceResponse([{ date: "2026-07-01", groups: [] }]));

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const ec2 = rows.filter((r) => r.service === "AmazonEC2" && r.region === "us-east-1");
    expect(ec2).toHaveLength(2);
    expect(ec2.find((r) => r.chargeType === "usage")).toMatchObject({
      amount: 4,
      amortizedAmount: 4,
    });
    expect(ec2.find((r) => r.chargeType === "commitment_covered_usage")).toMatchObject({
      amount: 0,
      amortizedAmount: 6,
    });
    // Amortized coverage of this cell is 6/10 — a number cash cannot produce.
    expect(ec2.reduce((sum, r) => sum + (r.amortizedAmount ?? 0), 0)).toBe(10);
  });

  it("sums record types that share a charge type into one row", async () => {
    // An RI recurring fee and a Savings Plan upfront fee on the same service
    // and day are two CE groups but one `commitment_fee` row. Emitted
    // separately they would be identical in every column the host keys on, and
    // its ReplacingMergeTree would keep only the last one written.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "5" }],
          },
        ]),
      )
      // Pass 1b — no commitment-covered usage in this account.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [
              { keys: ["AmazonEC2", "RIFee"], unblended: "30", amortized: "1" },
              { keys: ["AmazonEC2", "SavingsPlanUpfrontFee"], unblended: "12", amortized: "0.5" },
              { keys: ["AmazonEC2", "Tax"], unblended: "3" },
            ],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const fees = rows.filter((r) => r.chargeType === "commitment_fee");
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({
      service: "AmazonEC2",
      region: "",
      amount: 42,
      amortizedAmount: 1.5,
    });
    // Tax stays its own row rather than being merged into the fees.
    expect(rows.find((r) => r.chargeType === "tax")?.amount).toBe(3);
    // Usage keeps its region; the non-usage rows do not have one to keep.
    expect(rows.find((r) => r.chargeType === "usage" && r.amount === 5)?.region).toBe("us-east-1");
  });

  it("routes an unmappable record type to other instead of inflating usage", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      // Pass 1b — no commitment-covered usage in this account.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [
              { keys: ["AmazonEC2", "Enterprise Discount Program Discount"], unblended: "-90" },
              { keys: ["AmazonEC2", "SomeFutureChargeType"], unblended: "4" },
            ],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const other = rows.filter((r) => r.chargeType === "other");
    expect(other).toHaveLength(1);
    // Both unmappable types land in the same `other` bucket for the service.
    expect(other[0]).toMatchObject({ service: "AmazonEC2", amount: -86 });
    expect(rows.some((r) => r.chargeType === "usage" && r.amount !== 0)).toBe(false);
  });

  it("zeroes the stale usage row of a service whose whole spend is non-usage", async () => {
    // "Savings Plans for AWS Compute usage" has no usage lines at all, so a
    // pre-attribution collection stored its fee as an undifferentiated `usage`
    // row that nothing regenerates. The zero row lands on that exact key.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "us-east-1"], unblended: "20" }],
          },
        ]),
      )
      // Pass 1b — no commitment-covered usage in this account.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [
              {
                keys: ["Savings Plans for AWS Compute usage", "SavingsPlanRecurringFee"],
                unblended: "60",
              },
              { keys: ["AmazonEC2", "Tax"], unblended: "2" },
            ],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const zeroed = rows.filter((r) => r.chargeType === "usage" && r.amount === 0);
    expect(zeroed).toContainEqual(
      expect.objectContaining({
        date: "2026-07-01",
        service: "Savings Plans for AWS Compute usage",
        region: "",
        currency: "USD",
        amount: 0,
      }),
    );
    // Every no-region cell that now holds only non-usage gets one, including
    // EC2's — a pre-attribution collection filed EC2's no-region tax as a
    // usage row at exactly that key.
    expect(zeroed.map((r) => r.service).sort()).toEqual([
      "AmazonEC2",
      "Savings Plans for AWS Compute usage",
    ]);
    // The commitment fee itself is still reported in full.
    expect(rows.find((r) => r.chargeType === "commitment_fee")?.amount).toBe(60);
  });

  it("does not zero a service that has usage at no region", async () => {
    // Pass 1 already produced (day, service, "") for this one — overwriting it
    // with a zero would delete real spend.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AWSSupportBusiness", "NoRegion"], unblended: "15" }],
          },
        ]),
      )
      // Pass 1b — no commitment-covered usage in this account.
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AWSSupportBusiness", "Support"], unblended: "100" }],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    expect(rows.filter((r) => r.chargeType === "usage")).toHaveLength(1);
    expect(rows.find((r) => r.chargeType === "usage")?.amount).toBe(15);
    expect(rows.find((r) => r.chargeType === "support")?.amount).toBe(100);
  });
});

// ─── Absent vs zero on the amortized basis ──────────────────────────────────

describe("fetchAwsCostData amortized reporting", () => {
  it("omits amortizedAmount entirely when CE reported no such metric", async () => {
    // Absent and zero are different answers, and the host stores them apart
    // (`amortized_reported`). Stamping a 0 here because the metric was missing
    // would price this cell at nothing in every amortized view, instead of
    // falling back to the cash figure it does have.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "eu-west-1"], unblended: "11", noAmortized: true }],
          },
        ]),
      )
      .mockImplementation(async () => ceResponse([{ date: "2026-07-01", groups: [] }]));

    const { rows } = await fetchAwsCostData(creds, RANGE);

    const ec2 = rows.find((r) => r.service === "AmazonEC2");
    expect(ec2).toMatchObject({ amount: 11, chargeType: "usage" });
    expect(ec2).not.toHaveProperty("amortizedAmount");
  });

  it("omits it on the unattributed fallback too, whose groups mix every record type", async () => {
    // The fallback aggregates all record types into one group, so a response
    // without an amortized figure there would zero out a service's whole spend
    // on the amortized basis — the widest possible version of the same bug.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ __type: "ValidationException", message: "bad dimension" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "eu-west-1"], unblended: "9", noAmortized: true }],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);
    expect(rows[0]).not.toHaveProperty("amortizedAmount");
    expect(rows[0]).toMatchObject({ amount: 9 });
  });

  it("still states a reported zero, which is a real answer for a covered cell", async () => {
    // The flag must not become "omit whenever the number is 0": an RI-covered
    // cell is legitimately 0 cash, and a purchase legitimately amortizes to 0
    // on its purchase day. Those are reported zeroes and have to survive.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(ceResponse([{ date: "2026-07-01", groups: [] }]))
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "RIFee"], unblended: "30", amortized: "0" }],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);
    expect(rows.find((r) => r.chargeType === "commitment_fee")).toMatchObject({
      amount: 30,
      amortizedAmount: 0,
    });
  });
});

// ─── Degradation ────────────────────────────────────────────────────────────

describe("fetchAwsCostData degradation", () => {
  it("falls back to unattributed rows when CE rejects the attributed request", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ __type: "ValidationException", message: "bad dimension" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        ceResponse([
          {
            date: "2026-07-01",
            groups: [{ keys: ["AmazonEC2", "eu-west-1"], unblended: "9" }],
          },
        ]),
      );

    const { rows } = await fetchAwsCostData(creds, RANGE);

    // One rejected attributed request, then the legacy unfiltered one.
    expect(spy).toHaveBeenCalledTimes(2);
    const fallback = sentBodies(spy)[1]!;
    expect(fallback["Filter"]).toBeUndefined();
    expect(fallback["GroupBy"]).toEqual([
      { Type: "DIMENSION", Key: "SERVICE" },
      { Type: "DIMENSION", Key: "REGION" },
    ]);

    // Spend still reported, just unattributed — `usage` hashes identically to
    // no charge type at all, so these rows replace their predecessors.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service: "AmazonEC2",
      region: "eu-west-1",
      amount: 9,
      chargeType: "usage",
    });
  });

  it("flags the fallback as degraded so the host does not reconcile against it", async () => {
    // `ValidationException` fires both for an account that can never group by
    // RECORD_TYPE and for a transient rejection. Either way the pass writes a
    // coarser key space than the collection before it, and the host's
    // superseded-row reconciliation would read that as "the attribution rows
    // are gone" and zero all of them — unrepairable once the day ages past the
    // restatement window.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ __type: "ValidationException", message: "bad dimension" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        ceResponse([
          { date: "2026-07-01", groups: [{ keys: ["AmazonEC2", "eu-west-1"], unblended: "9" }] },
        ]),
      );

    const result = await fetchAwsCostData(creds, RANGE);
    expect(result.degraded).toBe(true);
  });

  it("does not flag a healthy attributed pass", async () => {
    // Absent means "not degraded": a normal pass must keep reconciling, which
    // is the only mechanism that retires a stale key.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ceResponse([
        { date: "2026-07-01", groups: [{ keys: ["AmazonEC2", "eu-west-1"], unblended: "9" }] },
      ]),
    );

    const result = await fetchAwsCostData(creds, RANGE);
    expect(result.degraded).toBeFalsy();
  });

  it("propagates failures that are not a rejected request shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ __type: "LimitExceededException" }), { status: 400 }),
    );

    await expect(fetchAwsCostData(creds, RANGE)).rejects.toThrow(/LimitExceededException/);
  });
});
