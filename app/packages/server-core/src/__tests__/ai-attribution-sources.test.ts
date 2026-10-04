import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));

import { daysToCollect } from "../ai-attribution/pass";
import { fetchLiteLlmDay, parseLiteLlmSpendLog } from "../ai-attribution/litellm";
import { summarizeAiAttributionDays } from "../ai-attribution/stats";

describe("daysToCollect", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  it("starts a new source at its lookback and stops at the last settled day", () => {
    expect(daysToCollect(null, 3, 90, now)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("does not read yesterday before it has settled", () => {
    expect(daysToCollect("2026-10-02", 7, 90, new Date("2026-10-04T01:00:00Z"))).toEqual([]);
  });

  it("continues forward from the watermark, bounded per pass and by history", () => {
    expect(daysToCollect("2026-10-02", 7, 90, now)).toEqual(["2026-10-03"]);
    expect(daysToCollect(null, 30, 90, now, 2)).toEqual(["2026-09-04", "2026-09-05"]);
    expect(daysToCollect("2026-01-01", 7, 5, now)[0]).toBe("2026-09-29");
  });
});

describe("LiteLLM spend logs", () => {
  it("flattens proxy and caller metadata, caller winning", () => {
    const rec = parseLiteLlmSpendLog({
      startTime: "2026-10-01T10:00:00Z",
      model: "gpt-4o",
      custom_llm_provider: "openai",
      spend: 0.5,
      prompt_tokens: 10,
      completion_tokens: 2,
      status: "success",
      team_id: "t1",
      request_tags: ["batch"],
      metadata: {
        user_api_key_team_alias: "search",
        spend_logs_metadata: { team: "caller-team" },
      },
    });
    expect(rec).toMatchObject({
      provider: "openai",
      reportedCost: 0.5,
      metadata: {
        team_id: "t1",
        user_api_key_team_alias: "search",
        team: "caller-team",
        "tag:batch": "true",
      },
    });
  });

  it("skips failures and cache hits", () => {
    expect(parseLiteLlmSpendLog({ status: "failure", model: "m" })).toBeNull();
    expect(parseLiteLlmSpendLog({ cache_hit: "True", model: "m" })).toBeNull();
  });

  it("pages /spend/logs/v2 with the day's bounds and a bearer key", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
      return new Response(
        JSON.stringify({
          data: [
            {
              startTime: "2026-10-01T01:00:00Z",
              model: "claude-sonnet-4-5",
              custom_llm_provider: "anthropic",
              prompt_tokens: 3,
              metadata: { team: "a" },
            },
          ],
          total_pages: 1,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await fetchLiteLlmDay(
      "https://llm.example.com",
      "k",
      "2026-10-01",
      ["team"],
      undefined,
      fetchImpl,
    );
    expect(calls[0]).toContain("/spend/logs/v2?");
    expect(calls[0]).toContain("start_date=2026-10-01+00%3A00%3A00");
    expect(r.aggregates[0]).toMatchObject({
      provider: "anthropic",
      metadata: { team: "a" },
      inputTokens: 3,
    });
  });
});

describe("summarizeAiAttributionDays", () => {
  it("sums days per source and provider and computes coverage", () => {
    const s = summarizeAiAttributionDays(
      "2026-10-01",
      "2026-10-02",
      [
        {
          runAt: new Date(),
          sources: {
            s1: {
              requests: 10,
              matchedRequests: 8,
              ambiguousRequests: 1,
              unmatchedRequests: 2,
              skippedRecords: 0,
              degraded: false,
              truncated: true,
              attributed: { USD: 30 },
              billed: { USD: 60 },
            },
          },
          providers: [{ provider: "openai", currency: "USD", billed: 60, attributed: 30 }],
        },
        {
          runAt: null,
          sources: {},
          providers: [],
        },
      ],
      new Map([
        ["s1", "Gateway"],
        ["s2", "Idle"],
      ]),
    );
    expect(s.attributedDays).toBe(1);
    const s1 = s.sources.find((x) => x.sourceId === "s1")!;
    expect(s1).toMatchObject({
      name: "Gateway",
      requests: 10,
      coveragePercent: 50,
      truncatedDays: 1,
    });
    expect(s.sources.find((x) => x.sourceId === "s2")!.days).toBe(0);
    expect(s.providers[0]).toMatchObject({ provider: "openai", unattributedAmount: 30 });
  });
});
