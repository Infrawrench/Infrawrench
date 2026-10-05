/**
 * The blended basis on the host side: what a plugin's `blendedAmount` turns
 * into on write, and which money each basis sums on read.
 *
 * The plugins prove sum(blended) == sum(amortized) per day for the rows they
 * emit (see `cost-blending.test.ts` and each cloud plugin's cost-data tests).
 * The host's half of that guarantee is that every row a plugin did *not*
 * blend reads as its amortized amount, so the per-day identity survives being
 * mixed with other providers and with history written before the basis
 * existed.
 */
import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { ClickHouseDialect } from "drizzle-orm/clickhouse-core";

import {
  amortizedAmountExpr,
  blendedAmountExpr,
  costBasisAmountExpr,
} from "../clickhouse/cost-readers";
import { toCostDailyRows } from "../clickhouse/cost-writers";

const render = (fragment: SQL) => new ClickHouseDialect().sqlToQuery(fragment).sql;

const meta = { organizationId: "org-1", accountId: "acct-1", pluginId: "aws" };

/** What the blended expression yields for one stored row, mirroring its SQL. */
function readBlended(row: {
  amount: number;
  amortized_amount: number;
  amortized_reported: number;
  blended_amount: number;
  blended_reported: number;
}): number {
  if (row.blended_reported !== 0) return row.blended_amount;
  return row.amortized_reported !== 0 || row.amortized_amount !== 0
    ? row.amortized_amount
    : row.amount;
}

describe("blended basis, host side", () => {
  it("stores a reported blended amount as reported, including zero, and absent as absent", () => {
    const rows = toCostDailyRows(meta, [
      { date: "2026-07-01", currency: "USD", amount: 5, amortizedAmount: 5, blendedAmount: 0 },
      { date: "2026-07-01", service: "a", currency: "USD", amount: 5, blendedAmount: 4 },
      { date: "2026-07-01", service: "b", currency: "USD", amount: 5 },
    ]);
    expect(rows.map((r) => [r.blended_amount, r.blended_reported])).toEqual([
      [0, 1],
      [4, 1],
      [0, 0],
    ]);
  });

  it("falls back to the amortized expression, not to cash", () => {
    const expr = render(blendedAmountExpr());
    expect(expr).toContain("blended_reported");
    expect(expr).toContain(render(amortizedAmountExpr()));
  });

  it("resolves each basis to its own expression", () => {
    expect(render(costBasisAmountExpr(undefined))).toBe("`cost_daily`.`amount`");
    expect(render(costBasisAmountExpr("cash"))).toBe("`cost_daily`.`amount`");
    expect(render(costBasisAmountExpr("amortized"))).toBe(render(amortizedAmountExpr()));
    expect(render(costBasisAmountExpr("blended"))).toBe(render(blendedAmountExpr()));
  });

  it("keeps a day's blended total equal to its amortized total across a provider mix", () => {
    // One AWS pool the plugin blended (on-demand 100 + covered 70 effective →
    // 68 / 102), a fee outside the pool, a non-amortizing provider's row, and
    // a row written before either column existed.
    const stored = [
      ...toCostDailyRows(meta, [
        {
          date: "2026-07-01",
          service: "ec2",
          currency: "USD",
          amount: 100,
          amortizedAmount: 100,
          blendedAmount: 68,
        },
        {
          date: "2026-07-01",
          service: "ec2",
          region: "us-west-2",
          currency: "USD",
          amount: 0,
          amortizedAmount: 70,
          blendedAmount: 102,
          chargeType: "commitment_covered_usage",
        },
        {
          date: "2026-07-01",
          service: "ec2",
          currency: "USD",
          amount: 30,
          amortizedAmount: 0,
          chargeType: "commitment_fee",
        },
      ]),
      ...toCostDailyRows({ ...meta, pluginId: "vercel" }, [
        { date: "2026-07-01", currency: "USD", amount: 12 },
      ]),
      {
        amount: 9,
        amortized_amount: 0,
        amortized_reported: 0,
        blended_amount: 0,
        blended_reported: 0,
      },
    ];
    const amortized = stored.reduce(
      (s, r) =>
        s +
        (r.amortized_reported !== 0 || r.amortized_amount !== 0 ? r.amortized_amount : r.amount),
      0,
    );
    const blended = stored.reduce((s, r) => s + readBlended(r), 0);
    expect(blended).toBeCloseTo(amortized, 9);
    expect(blended).toBeCloseTo(68 + 102 + 0 + 12 + 9, 9);
  });
});
