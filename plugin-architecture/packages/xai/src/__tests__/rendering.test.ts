import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { XaiClient } from "../client.js";

runPluginRenderingTests(plugin);

function client(): XaiClient {
  return new XaiClient({ apiKey: "xai-test", managementKey: "xai-mgmt" });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `acct-1:${resourceTypeId}:ext`,
    pluginId: "xai",
    resourceTypeId,
    accountId: "acct-1",
    displayName: "Test",
    externalId: "ext",
    fields,
    resolvedOutputs,
    secretStates: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("renderDetail", () => {
  function pricing(schema: { sections: Array<{ kind: string; title?: string }> }): string {
    return JSON.stringify(
      schema.sections.find((s) => s.kind === "section" && s.title === "Pricing"),
    );
  }

  it("converts token prices from the reported cents-per-100M scale", () => {
    // The numbers xAI's own docs report for grok-4.3, published at $1.25 / 1M
    // prompt tokens, $0.20 cached and $2.50 / 1M completion tokens.
    const rows = pricing(
      client().renderDetail(
        resource("model", {
          modelId: "grok-4.3",
          kind: "language",
          promptTextTokenPrice: 12500,
          cachedPromptTextTokenPrice: 2000,
          completionTextTokenPrice: 25000,
        }),
      ),
    );
    expect(rows).toContain("$1.2500");
    expect(rows).toContain("$0.2000");
    expect(rows).toContain("$2.5000");
    expect(rows).toContain("per 1M tokens");
  });

  it("prices images per image and search per source, not per million", () => {
    // grok-imagine-image is published at $0.02 an image; live search at $25 per
    // 1,000 sources, i.e. $0.025 each.
    const rows = pricing(
      client().renderDetail(
        resource("model", {
          modelId: "grok-imagine-image",
          kind: "image-generation",
          imagePrice: 200_000_000,
          searchPrice: 250_000_000,
        }),
      ),
    );
    expect(rows).toContain(`"price":"$0.0200","unit":"per image"`);
    expect(rows).toContain(`"price":"$0.0250","unit":"per source"`);
    expect(rows).not.toContain("per 1M images");
    expect(rows).not.toContain("per 1M sources");
  });

  it("gives models with audio modalities a speech panel and plain models none", () => {
    const audio = client().renderDetail(
      resource("model", { modelId: "grok-voice", kind: "language", outputModalities: "audio" }),
    );
    expect(audio.speechPanel?.modes).toEqual(["tts", "stt"]);

    const text = client().renderDetail(
      resource("model", { modelId: "grok-4", kind: "language", outputModalities: "text" }),
    );
    expect(text.speechPanel).toBeUndefined();
  });

  it("defaults the voice picker to the voice being viewed and uses the stashed list", () => {
    const schema = client().renderDetail(
      resource(
        "custom-voice",
        { voiceId: "abc12345", name: "Narrator", builtIn: false },
        {
          __voices__: JSON.stringify([
            { id: "eve", label: "Eve" },
            { id: "abc12345", label: "Narrator" },
          ]),
        },
      ),
    );
    expect(schema.speechPanel?.defaultVoice).toBe("abc12345");
    expect(schema.speechPanel?.voices?.map((v) => v.id)).toEqual(["eve", "abc12345"]);
    expect(schema.speechPanel?.maxCharacters).toBe(15000);
    expect(schema.speechPanel?.maxAudioBytes).toBe(25 * 1024 * 1024);
  });

  it("falls back to the documented built-in voices when nothing was stashed", () => {
    const schema = client().renderDetail(
      resource("custom-voice", { voiceId: "eve", builtIn: true }),
    );
    expect(schema.speechPanel?.voices?.map((v) => v.id)).toEqual([
      "eve",
      "ara",
      "leo",
      "rex",
      "sal",
    ]);
  });

  it("marks a batch with errors as unhealthy", () => {
    const schema = client().renderDetail(
      resource("batch", { batchId: "b1", numRequests: 5, numError: 2, numPending: 0 }),
    );
    expect(schema.status?.status).toBe("error");
  });

  it("offers a rotate action on API keys", () => {
    const schema = client().renderDetail(resource("api-key", { apiKeyId: "k1", disabled: false }));
    expect(schema.headerActions?.some((a) => a.label === "Rotate secret")).toBe(true);
  });
});
