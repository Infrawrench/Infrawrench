import { describe, expect, it } from "vitest";
import { parseGatewayLogRow } from "../ai-request-logs.js";

describe("parseGatewayLogRow", () => {
  it("reads provider, model, tokens, cost and the cf-aig-metadata JSON string", () => {
    expect(
      parseGatewayLogRow({
        created_at: "2026-10-01T10:00:00Z",
        provider: "openai",
        model: "gpt-4o-mini",
        tokens_in: 120,
        tokens_out: 30,
        cost: 0.0004,
        cached: false,
        metadata: '{"team":"search","user":42}',
      }),
    ).toEqual({
      timestamp: "2026-10-01T10:00:00Z",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 120,
      outputTokens: 30,
      reportedCost: 0.0004,
      reportedCurrency: "USD",
      metadata: { team: "search", user: 42 },
    });
  });

  it("skips cache hits, which never reach a provider bill", () => {
    expect(parseGatewayLogRow({ provider: "openai", model: "m", cached: true })).toBeNull();
  });

  it("treats unparseable metadata as none rather than dropping the request", () => {
    const rec = parseGatewayLogRow({ provider: "anthropic", model: "m", metadata: "{not json" });
    expect(rec).not.toBeNull();
    expect(rec?.metadata).toBeUndefined();
  });
});
