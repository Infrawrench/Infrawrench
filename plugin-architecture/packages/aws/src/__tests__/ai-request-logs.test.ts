import { describe, expect, it } from "vitest";
import {
  bedrockDayPrefix,
  bedrockInsightsQuery,
  classifyAwsCostRow,
  foldInsightsRows,
  parseBedrockInvocationRecord,
} from "../ai-request-logs.js";

describe("parseBedrockInvocationRecord", () => {
  it("reads the documented invocation-log shape, cache tokens and request metadata", () => {
    const rec = parseBedrockInvocationRecord({
      schemaType: "ModelInvocationLog",
      schemaVersion: "1.0",
      timestamp: "2026-10-01T12:00:00Z",
      modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      requestMetadata: { team: "orchestrator" },
      input: { inputTokenCount: 25, cacheReadInputTokenCount: 10, cacheWriteInputTokenCount: 3 },
      output: { outputTokenCount: 150 },
    });
    expect(rec).toMatchObject({
      provider: "bedrock",
      model: "anthropic.claude-sonnet-4-20250514-v1:0",
      inputTokens: 25,
      outputTokens: 150,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      metadata: { team: "orchestrator" },
    });
  });

  it("rejects records that are not invocation logs", () => {
    expect(parseBedrockInvocationRecord({ schemaType: "Other", modelId: "x" })).toBeNull();
    expect(parseBedrockInvocationRecord({ schemaType: "ModelInvocationLog" })).toBeNull();
  });
});

describe("bedrockDayPrefix", () => {
  it("builds the AWSLogs delivery path, with and without a key prefix", () => {
    expect(bedrockDayPrefix("", "123456789012", "us-east-1", "2026-10-01")).toBe(
      "AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/2026/10/01/",
    );
    expect(bedrockDayPrefix("bedrock/", "123", "eu-west-1", "2026-01-09")).toBe(
      "bedrock/AWSLogs/123/BedrockModelInvocationLogs/eu-west-1/2026/01/09/",
    );
  });
});

describe("classifyAwsCostRow", () => {
  it("names the model for Marketplace Bedrock editions and the provider for the rest", () => {
    expect(classifyAwsCostRow("Claude 3.5 Sonnet (Amazon Bedrock Edition)")).toEqual({
      provider: "bedrock",
      model: "Claude 3.5 Sonnet",
    });
    expect(classifyAwsCostRow("Amazon Bedrock")).toEqual({ provider: "bedrock" });
    expect(classifyAwsCostRow("Amazon Elastic Compute Cloud - Compute")).toBeNull();
  });
});

describe("Logs Insights path", () => {
  it("groups by model and each mapped metadata key", () => {
    const q = bedrockInsightsQuery(["team", "feature-name"]);
    expect(q).toContain("`requestMetadata.team` as m0");
    expect(q).toContain("`requestMetadata.feature-name` as m1");
    expect(q).toContain("by modelId, m0, m1");
  });

  it("folds grouped rows into aggregates", () => {
    const r = foldInsightsRows(
      "2026-10-01",
      ["team"],
      [
        [
          { field: "modelId", value: "amazon.nova-pro-v1:0" },
          { field: "m0", value: "search" },
          { field: "n", value: "4" },
          { field: "ti", value: "100" },
          { field: "tout", value: "40" },
        ],
      ],
      2048,
    );
    expect(r.requests).toBe(4);
    expect(r.queryBytesScanned).toBe(2048);
    expect(r.aggregates[0]).toMatchObject({
      model: "amazon.nova-pro-v1:0",
      metadata: { team: "search" },
      inputTokens: 100,
      outputTokens: 40,
    });
  });
});
