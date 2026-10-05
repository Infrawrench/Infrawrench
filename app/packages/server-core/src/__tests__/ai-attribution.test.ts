import { describe, expect, it } from "vitest";
import type { AiModelRateCard } from "@infrawrench/plugin-base";
import {
  attributeDay,
  callerValues,
  type BilledAiRow,
  type RequestAggregateInput,
} from "../ai-attribution/attribute";

type TestRow = BilledAiRow & Record<string, unknown>;

function billed(
  amount: number,
  tags: Record<string, string>,
  extra: Record<string, unknown> = {},
): TestRow {
  return {
    account_id: "acc",
    currency: "USD",
    amount,
    usage_amount: 0,
    amortized_amount: 0,
    tags,
    ...extra,
  };
}

function agg(
  partial: Partial<RequestAggregateInput> & Pick<RequestAggregateInput, "provider" | "model">,
): RequestAggregateInput {
  return {
    sourceId: "s1",
    metadata: {},
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reportedCost: null,
    reportedCurrency: null,
    ...partial,
  };
}

const TEAM = [{ key: "team", metadataKeys: ["team", "team_id"] }];

function sumBy(rows: Array<{ amount: number; tags: Record<string, string> }>, tag: string) {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.tags[tag] ?? ""] = (out[r.tags[tag] ?? ""] ?? 0) + r.amount;
  return out;
}

const RATES: AiModelRateCard = {
  provider: "anthropic",
  currency: "USD",
  asOf: "2026-10-04",
  models: { "claude-sonnet-4-5": { input: 3, output: 15 } },
};

describe("callerValues", () => {
  it("takes the first present metadata key and marks absence", () => {
    expect(callerValues({ team_id: "b" }, TEAM)).toEqual({ team: "b" });
    expect(callerValues({ team: "a", team_id: "b" }, TEAM)).toEqual({ team: "a" });
    expect(callerValues({}, TEAM)).toEqual({ team: "(not set)" });
  });
});

describe("attributeDay", () => {
  it("never changes the billed total and splits a typed line by that token type", () => {
    const rows = [
      billed(60, { "ai:provider": "openai", "ai:model": "gpt-4o", "ai:token_type": "output" }),
      billed(40, { "ai:provider": "openai", "ai:model": "gpt-4o", "ai:token_type": "input" }),
    ];
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "openai",
          model: "gpt-4o-2024-08-06",
          metadata: { team: "a" },
          inputTokens: 100,
          outputTokens: 300,
        }),
        agg({
          provider: "openai",
          model: "gpt-4o",
          metadata: { team: "b" },
          inputTokens: 300,
          outputTokens: 100,
        }),
      ],
      TEAM,
      new Map(),
    );
    const total = r.rows.reduce((s, x) => s + x.amount, 0);
    expect(total).toBeCloseTo(100, 9);
    const byTeam = sumBy(r.rows, "caller:team");
    // Output $60 splits 3:1 a:b; input $40 splits 1:3.
    expect(byTeam["a"]).toBeCloseTo(45 + 10, 9);
    expect(byTeam["b"]).toBeCloseTo(15 + 30, 9);
    expect(byTeam["(unattributed)"] ?? 0).toBeCloseTo(0, 9);
    expect(r.sources["s1"]!.matchedRequests).toBe(2);
  });

  it("caps priced attribution at list cost and leaves the rest unattributed", () => {
    const rows = [billed(100, { "ai:provider": "anthropic", "ai:model": "claude-sonnet-4-5" })];
    // 1M input tokens at $3 + 1M output at $15 = $18 of list cost.
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          metadata: { team: "a" },
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ],
      TEAM,
      new Map([["anthropic", RATES]]),
    );
    const byTeam = sumBy(r.rows, "caller:team");
    expect(byTeam["a"]).toBeCloseTo(18, 9);
    expect(byTeam["(unattributed)"]).toBeCloseTo(82, 9);
    expect(r.providers[0]).toMatchObject({ provider: "anthropic", billed: 100 });
    expect(r.providers[0]!.attributed).toBeCloseTo(18, 9);
  });

  it("scales priced list cost down when the bill is below it (discounts)", () => {
    const rows = [billed(9, { "ai:provider": "anthropic", "ai:model": "claude-sonnet-4-5" })];
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          metadata: { team: "a" },
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ],
      TEAM,
      new Map([["anthropic", RATES]]),
    );
    expect(sumBy(r.rows, "caller:team")["a"]).toBeCloseTo(9, 9);
  });

  it("lands on a provider-level line when the bill names no model", () => {
    const rows = [
      billed(10, { "ai:provider": "bedrock" }),
      billed(5, { "ai:provider": "bedrock" }, { account_id: "acc2" }),
    ];
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "aws-bedrock",
          model: "anthropic.claude-3-haiku-20240307-v1:0",
          metadata: { team: "x" },
          inputTokens: 10,
        }),
      ],
      TEAM,
      new Map(),
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((row) => row.tags["caller:team"] === "x")).toBe(true);
    expect(r.rows.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(15, 9);
  });

  it("counts requests with nowhere to land as unmatched and leaves the bill unattributed", () => {
    const rows = [billed(10, { "ai:provider": "openai", "ai:model": "gpt-4o" })];
    const r = attributeDay(
      rows,
      [agg({ provider: "mistral", model: "mistral-large", requests: 7 })],
      TEAM,
      new Map(),
    );
    expect(r.sources["s1"]!.unmatchedRequests).toBe(7);
    expect(sumBy(r.rows, "caller:team")).toEqual({ "(unattributed)": 10 });
  });

  it("splits an ambiguous model across the billed candidates by billed amount", () => {
    const rows = [
      billed(30, { "ai:provider": "openai", "ai:model": "gpt-4o-mini" }),
      billed(10, { "ai:provider": "openai", "ai:model": "gpt-4o-audio" }),
    ];
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "openai",
          model: "gpt-4o",
          metadata: { team: "a" },
          requests: 2,
          inputTokens: 5,
        }),
      ],
      TEAM,
      new Map(),
    );
    expect(r.sources["s1"]!.ambiguousRequests).toBe(2);
    expect(sumBy(r.rows, "caller:team")["a"]).toBeCloseTo(40, 9);
  });

  it("uses a gateway-reported cost as list cost for untyped lines", () => {
    const rows = [billed(10, { "ai:provider": "openai", "ai:model": "gpt-4o" })];
    const r = attributeDay(
      rows,
      [
        agg({
          provider: "openai",
          model: "gpt-4o",
          metadata: { team: "a" },
          reportedCost: 4,
          reportedCurrency: "USD",
          inputTokens: 1,
        }),
      ],
      TEAM,
      new Map(),
    );
    const byTeam = sumBy(r.rows, "caller:team");
    expect(byTeam["a"]).toBeCloseTo(4, 9);
    expect(byTeam["(unattributed)"]).toBeCloseTo(6, 9);
  });

  it("keeps per-row identity fields and conserves credits", () => {
    const rows = [
      billed(
        -5,
        { "ai:provider": "openai", "ai:model": "gpt-4o" },
        { charge_type: "credit", region: "us" },
      ),
    ];
    const r = attributeDay(
      rows,
      [agg({ provider: "openai", model: "gpt-4o", metadata: { team: "a" }, inputTokens: 1 })],
      TEAM,
      new Map(),
    );
    expect(r.rows.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(-5, 9);
    expect(r.rows[0]).toMatchObject({ charge_type: "credit", region: "us" });
  });
});
