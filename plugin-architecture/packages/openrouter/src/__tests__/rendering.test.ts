import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { OpenRouterClient } from "../client.js";

runPluginRenderingTests(plugin);

function client(withInferenceKey = true): OpenRouterClient {
  return new OpenRouterClient({
    managementKey: "sk-or-v1-management",
    ...(withInferenceKey ? { apiKey: "sk-or-v1-inference" } : {}),
  });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `acct-1:${resourceTypeId}:ext`,
    pluginId: "openrouter",
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
  it("renders the per-provider endpoint table stashed by getResource", () => {
    const schema = client().renderDetail(
      resource(
        "model",
        { modelId: "openai/gpt-4", outputModalities: "text" },
        {
          __endpoints__: JSON.stringify([
            {
              name: "OpenAI | openai/gpt-4",
              provider_name: "OpenAI",
              context_length: 8192,
              pricing: { prompt: "0.00003", completion: "0.00006" },
              uptime_last_1d: 0.9987,
              latency_last_30m: { p50: 420, p99: 1800 },
              throughput_last_30m: { p50: 58.2 },
            },
          ]),
        },
      ),
    );
    const rendered = JSON.stringify(schema);
    expect(rendered).toContain("Provider endpoints (1)");
    expect(rendered).toContain("$30.000"); // 0.00003 USD/token → $30 per 1M
    expect(rendered).toContain("99.87%");
    expect(rendered).toContain("58.2 tok/s");
  });

  it("only gives speech and transcription models a Speech tab", () => {
    expect(
      client().renderDetail(
        resource("model", { modelId: "openai/gpt-4", outputModalities: "text" }),
      ).speechPanel,
    ).toBeUndefined();
    expect(
      client().renderDetail(resource("model", { modelId: "x/tts", outputModalities: "speech" }))
        .speechPanel?.modes,
    ).toEqual(["tts", "stt"]);
    expect(
      client().renderDetail(
        resource("model", {
          modelId: "openai/whisper-large-v3",
          outputModalities: "transcription",
        }),
      ).speechPanel?.modes,
    ).toEqual(["tts", "stt"]);
  });

  it("builds the voice picker from the live catalogue, model under view first", () => {
    const schema = client().renderDetail(
      resource(
        "model",
        { modelId: "mistralai/voxtral-mini-tts-2603", outputModalities: "speech" },
        {
          __speech__: JSON.stringify({
            tts: [
              { id: "x-ai/grok-voice-tts-1.0", name: "Grok TTS", supported_voices: ["eve"] },
              {
                id: "mistralai/voxtral-mini-tts-2603",
                name: "Voxtral Mini TTS",
                supported_voices: ["en_paul_neutral"],
              },
            ],
            stt: [{ id: "openai/whisper-large-v3", name: "Whisper Large v3" }],
          }),
        },
      ),
    );
    expect(schema.speechPanel?.voices?.[0]).toEqual({
      id: "en_paul_neutral",
      label: "en_paul_neutral",
      description: "for Voxtral Mini TTS",
    });
    expect(schema.speechPanel?.defaultVoice).toBe("en_paul_neutral");
    expect(schema.speechPanel?.defaultModel).toBe("mistralai/voxtral-mini-tts-2603");
    expect(schema.speechPanel?.models?.map((m) => m.id)).toContain("openai/whisper-large-v3");
  });

  it("disables the Speech tab when the account only has a management key", () => {
    const schema = client(false).renderDetail(
      resource("model", { modelId: "x/tts", outputModalities: "speech" }),
    );
    expect(schema.speechPanel?.disabledReason).toMatch(/inference API key/);
  });

  it("grades endpoint health off the 1-day uptime", () => {
    expect(
      client().renderDetail(resource("model-endpoint", { uptimeLast1d: 0.999 })).status?.status,
    ).toBe("healthy");
    expect(
      client().renderDetail(resource("model-endpoint", { uptimeLast1d: 0.95 })).status?.status,
    ).toBe("degraded");
    expect(
      client().renderDetail(resource("model-endpoint", { uptimeLast1d: 0.5 })).status?.status,
    ).toBe("error");
  });

  it("shows the key's spend table", () => {
    const schema = client().renderDetail(
      resource("api-key", { hash: "abc", limit: 100, limitRemaining: 74.5, usage: 25.5 }),
    );
    const rendered = JSON.stringify(schema);
    expect(rendered).toContain("$100.00");
    expect(rendered).toContain("$74.5000");
  });
});
