import { describe, expect, it } from "vitest";
import {
  AI_COST_TAG,
  AI_OVERFLOW_VALUE,
  AiRequestAccumulator,
  normalizeAiModel,
  normalizeAiProvider,
  objectKeyMatchesDay,
  parseAiRequestJsonLine,
  readMaybeGzipText,
  withAiCostTags,
} from "../ai-requests.js";

describe("normalizeAiModel", () => {
  it("reduces every spelling of one model to the same key", () => {
    const want = "claude-3-5-sonnet";
    expect(normalizeAiModel("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(want);
    expect(normalizeAiModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(want);
    expect(normalizeAiModel("claude-3-5-sonnet-20240620")).toBe(want);
    expect(normalizeAiModel("Claude 3.5 Sonnet (Amazon Bedrock Edition)")).toBe(want);
    expect(normalizeAiModel("claude-3-5-sonnet-latest")).toBe(want);
  });

  it("keeps distinct models distinct", () => {
    expect(normalizeAiModel("gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
    expect(normalizeAiModel("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeAiModel("models/gemini-2.5-pro")).toBe("gemini-2-5-pro");
  });
});

describe("normalizeAiProvider", () => {
  it("maps gateway spellings onto the plugin ids", () => {
    expect(normalizeAiProvider("aws-bedrock")).toBe("bedrock");
    expect(normalizeAiProvider("vertex_ai")).toBe("vertex");
    expect(normalizeAiProvider("google-vertex-ai")).toBe("vertex");
    expect(normalizeAiProvider("Azure")).toBe("azure-openai");
    expect(normalizeAiProvider("something-new")).toBe("something-new");
  });
});

describe("withAiCostTags", () => {
  it("tags only the rows the classifier recognizes and never mutates", () => {
    const rows = [{ service: "Amazon Bedrock", tags: { team: "a" } }, { service: "Amazon EC2" }];
    const out = withAiCostTags(rows, (r) =>
      r.service.includes("Bedrock") ? { provider: "bedrock" } : null,
    );
    expect(out[0]!.tags).toEqual({ team: "a", [AI_COST_TAG.provider]: "bedrock" });
    expect(out[1]).toBe(rows[1]);
    expect(rows[0]!.tags).toEqual({ team: "a" });
  });
});

describe("AiRequestAccumulator", () => {
  it("folds requests by provider, model and mapped metadata only", () => {
    const acc = new AiRequestAccumulator("2026-10-01", ["team"]);
    acc.add({
      timestamp: "2026-10-01T01:00:00Z",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      metadata: { team: "search", user: "u1" },
    });
    acc.add({
      timestamp: "2026-10-01T02:00:00Z",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 20,
      outputTokens: 1,
      metadata: { team: "search", user: "u2" },
    });
    // Outside the day: dropped silently.
    acc.add({ timestamp: "2026-10-02T00:00:01Z", provider: "openai", model: "gpt-4o" });
    // No model: skipped.
    acc.add({ provider: "openai", model: "" });
    const r = acc.result();
    expect(r.requests).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.aggregates).toHaveLength(1);
    expect(r.aggregates[0]).toMatchObject({
      metadata: { team: "search" },
      requests: 2,
      inputTokens: 30,
      outputTokens: 6,
    });
    expect(r.observedMetadataKeys).toEqual({ team: 2, user: 2 });
  });

  it("drops a reported cost sum when any folded request lacked one", () => {
    const acc = new AiRequestAccumulator("2026-10-01", []);
    acc.add({ provider: "openai", model: "m", reportedCost: 1 });
    acc.add({ provider: "openai", model: "m" });
    expect(acc.result().aggregates[0]!.reportedCost).toBeUndefined();
  });

  it("folds combinations past the cap into one overflow row", () => {
    const acc = new AiRequestAccumulator("2026-10-01", ["user"], 2);
    for (const user of ["a", "b", "c", "d"]) {
      acc.add({ provider: "openai", model: "m", inputTokens: 1, metadata: { user } });
    }
    const r = acc.result();
    expect(r.truncated).toBe(true);
    const overflow = r.aggregates.find((a) => a.metadata["user"] === AI_OVERFLOW_VALUE);
    expect(overflow?.requests).toBe(2);
    expect(r.aggregates.reduce((s, a) => s + a.requests, 0)).toBe(4);
  });
});

describe("parseAiRequestJsonLine", () => {
  it("parses the documented schema in either spelling", () => {
    expect(
      parseAiRequestJsonLine(
        '{"timestamp":"2026-10-01T00:00:00Z","provider":"anthropic","model":"claude-sonnet-4-5","input_tokens":5,"cacheReadTokens":2,"cost":"0.01","metadata":{"team":"x"}}',
      ),
    ).toMatchObject({
      provider: "anthropic",
      inputTokens: 5,
      cacheReadTokens: 2,
      reportedCost: 0.01,
      metadata: { team: "x" },
    });
    expect(parseAiRequestJsonLine("not json")).toBeNull();
    expect(parseAiRequestJsonLine('{"model":"x"}')).toBeNull();
    expect(parseAiRequestJsonLine("")).toBeNull();
  });
});

describe("objectKeyMatchesDay", () => {
  it("accepts the documented layouts", () => {
    expect(objectKeyMatchesDay("logs/2026/10/01/a.jsonl", "2026-10-01")).toBe(true);
    expect(objectKeyMatchesDay("logs/dt=2026-10-01/a.jsonl", "2026-10-01")).toBe(true);
    expect(objectKeyMatchesDay("logs/2026/10/02/a.jsonl", "2026-10-01")).toBe(false);
  });
});

describe("readMaybeGzipText", () => {
  it("round-trips gzip", async () => {
    const stream = new Blob(["hello\nworld"]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    expect(await readMaybeGzipText(buf, true)).toBe("hello\nworld");
  });
});
