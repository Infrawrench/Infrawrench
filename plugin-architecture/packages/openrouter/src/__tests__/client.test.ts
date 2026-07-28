import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { OpenRouterClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, contentType = "audio/mpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    text: async () => "",
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as unknown as typeof fetch);
}

function client(withInferenceKey = true) {
  return new OpenRouterClient({
    managementKey: "sk-or-v1-management",
    ...(withInferenceKey ? { apiKey: "sk-or-v1-inference" } : {}),
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("requires a management key", () => {
    expect(() => new OpenRouterClient({})).toThrow(/missing managementKey/);
  });

  it("works with only a management key", () => {
    expect(() => client(false)).not.toThrow();
  });
});

describe("listResources", () => {
  it("asks for every modality and normalises prices to per-million tokens", async () => {
    installFetch((url) => {
      expect(url).toContain("output_modalities=all");
      expect(url).toContain("limit=1000");
      expect(url).toContain("offset=0");
      return jsonResponse({
        data: [
          {
            id: "openai/gpt-4",
            name: "GPT-4",
            canonical_slug: "openai/gpt-4",
            context_length: 8192,
            architecture: {
              modality: "text->text",
              input_modalities: ["text"],
              output_modalities: ["text"],
              tokenizer: "GPT",
            },
            pricing: { prompt: "0.00003", completion: "0.00006", image: "0", request: "0" },
            top_provider: { context_length: 8192, max_completion_tokens: 4096, is_moderated: true },
          },
        ],
      });
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields["promptPricePerMillion"]).toBeCloseTo(30);
    expect(rows[0]?.fields["completionPricePerMillion"]).toBeCloseTo(60);
    expect(rows[0]?.fields["author"]).toBe("openai");
    expect(rows[0]?.id).toBe(`${ACCOUNT}:model:openai/gpt-4`);
  });

  it("pages models with offset+limit rather than a cursor", async () => {
    let page = 0;
    installFetch((url) => {
      page++;
      if (page === 1) {
        expect(url).toContain("offset=0");
        return jsonResponse({
          data: Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })),
        });
      }
      expect(url).toContain("offset=1000");
      return jsonResponse({ data: [{ id: "a/last" }] });
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows).toHaveLength(1001);
    expect(rows[1000]?.externalId).toBe("a/last");
  });

  it("sends the management key as the bearer token", async () => {
    installFetch(() => jsonResponse({ data: [] }));
    await client().listResources("provider", ACCOUNT);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/providers");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer sk-or-v1-management");
  });

  it("caps the model-endpoint fan-out to the most popular models", async () => {
    installFetch((url) => {
      if (url.includes("/models?")) {
        expect(url).toContain("limit=25");
        expect(url).toContain("sort=most-popular");
        return jsonResponse({ data: [{ id: "openai/gpt-4" }] });
      }
      if (url.endsWith("/models/openai/gpt-4/endpoints")) {
        return jsonResponse({
          data: {
            endpoints: [
              {
                name: "OpenAI | openai/gpt-4",
                provider_name: "OpenAI",
                context_length: 8192,
                pricing: { prompt: "0.00003", completion: "0.00006" },
                uptime_last_1d: 0.999,
                latency_last_30m: { p50: 420, p75: 600, p90: 900, p99: 1800 },
                throughput_last_30m: { p50: 58.2, p90: 91.4 },
                status: 0,
              },
            ],
          },
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().listResources("model-endpoint", ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("openai/gpt-4|OpenAI | openai/gpt-4");
    expect(rows[0]?.parentResourceId).toBe(`${ACCOUNT}:model:openai/gpt-4`);
    expect(rows[0]?.fields["latencyP99"]).toBe(1800);
    expect(rows[0]?.fields["throughputP50"]).toBe(58.2);
    expect(rows[0]?.fields["status"]).toBe("healthy");
  });

  it("lists API keys including disabled ones", async () => {
    installFetch((url) => {
      expect(url).toContain("include_disabled=true");
      expect(url).toContain("offset=0");
      return jsonResponse({
        data: [
          {
            hash: "f01d",
            name: "Prod",
            disabled: false,
            limit: 100,
            limit_remaining: 74.5,
            limit_reset: "monthly",
            usage: 25.5,
          },
        ],
      });
    });

    const rows = await client().listResources("api-key", ACCOUNT);
    expect(rows[0]?.fields["limitReset"]).toBe("monthly");
    expect(rows[0]?.fields["limitRemaining"]).toBe(74.5);
  });
});

describe("getResource", () => {
  it("stashes a model's full endpoint list for the synchronous renderer", async () => {
    installFetch((url) => {
      if (url.endsWith("/models/openai/gpt-4/endpoints")) {
        return jsonResponse({
          data: {
            id: "openai/gpt-4",
            name: "GPT-4",
            architecture: { output_modalities: ["text"] },
            endpoints: [{ name: "OpenAI | openai/gpt-4", provider_name: "OpenAI" }],
          },
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource("model", `${ACCOUNT}:model:openai/gpt-4`, ACCOUNT);
    const stashed = JSON.parse(resource.resolvedOutputs["__endpoints__"] ?? "[]");
    expect(stashed).toHaveLength(1);
    expect(resource.resolvedOutputs["__speech__"]).toBeUndefined();
  });

  it("also stashes the speech catalogue for audio models", async () => {
    installFetch((url) => {
      if (url.endsWith("/models/x-ai/grok-voice-tts-1.0/endpoints")) {
        return jsonResponse({
          data: {
            id: "x-ai/grok-voice-tts-1.0",
            architecture: { output_modalities: ["speech"] },
            endpoints: [],
          },
        });
      }
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [{ id: "x-ai/grok-voice-tts-1.0", supported_voices: ["eve", "ara"] }],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource(
      "model",
      `${ACCOUNT}:model:x-ai/grok-voice-tts-1.0`,
      ACCOUNT,
    );
    const speech = JSON.parse(resource.resolvedOutputs["__speech__"] ?? "{}");
    expect(speech.tts?.[0]?.supported_voices).toEqual(["eve", "ara"]);
    expect(speech.stt?.[0]?.id).toBe("openai/whisper-large-v3");
  });

  it("splits a model-endpoint id back into model and endpoint name", async () => {
    installFetch((url) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models/openai/gpt-4/endpoints");
      return jsonResponse({
        data: { endpoints: [{ name: "OpenAI | openai/gpt-4", provider_name: "OpenAI" }] },
      });
    });
    const resource = await client().getResource(
      "model-endpoint",
      `${ACCOUNT}:model-endpoint:openai/gpt-4|OpenAI | openai/gpt-4`,
      ACCOUNT,
    );
    expect(resource.fields["providerName"]).toBe("OpenAI");
  });
});

describe("api key management", () => {
  it("creates a key and surfaces the one-time plaintext", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "CI",
        limit: 50,
        limit_reset: "monthly",
      });
      return jsonResponse({ data: { hash: "h1", name: "CI" }, key: "sk-or-v1-plain" }, 201);
    });

    const created = await client().createResource("api-key", ACCOUNT, {
      name: "CI",
      limit: "50",
      limitReset: "monthly",
    });
    expect(created.resolvedOutputs["apiKey"]).toBe("sk-or-v1-plain");
  });

  it("PATCHes only the changed fields and nulls a cleared limit", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/h1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ disabled: true, limit: null });
      return jsonResponse({ data: { hash: "h1", disabled: true } });
    });

    const updated = await client().updateResource("api-key", `${ACCOUNT}:api-key:h1`, ACCOUNT, {
      disabled: "true",
      limit: "",
    });
    expect(updated.fields["disabled"]).toBe(true);
  });

  it("deletes by hash", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/h1");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ deleted: true });
    });
    await client().deleteResource("api-key", `${ACCOUNT}:api-key:h1`, ACCOUNT);
  });
});

describe("fetchCostData", () => {
  it("turns /activity rows into daily CostRows inside the requested range", async () => {
    installFetch((url) => {
      expect(url).toBe("https://openrouter.ai/api/v1/activity");
      return jsonResponse({
        data: [
          {
            date: "2026-07-20",
            model: "openai/gpt-4.1",
            provider_name: "OpenAI",
            usage: 0.015,
            byok_usage_inference: 0.012,
            requests: 5,
          },
          { date: "2026-06-01", model: "old/model", provider_name: "OpenAI", usage: 9 },
        ],
      });
    });

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-28",
    });
    expect(rows).toEqual([
      {
        date: "2026-07-20",
        service: "OpenAI",
        resourceId: "openai/gpt-4.1",
        currency: "USD",
        amount: 0.027,
        usageAmount: 5,
        usageUnit: "Requests",
      },
    ]);
  });

  it("raises a CostSetupError when /activity 403s on a non-management key", async () => {
    installFetch(() => jsonResponse({ error: { code: 403 } }, 403));
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-28" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchMetricSeries", () => {
  it("returns spend and request series for one model", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          { date: "2026-07-20", model: "openai/gpt-4.1", usage: 1.5, requests: 10 },
          { date: "2026-07-21", model: "openai/gpt-4.1", usage: 2.5, requests: 20 },
          { date: "2026-07-21", model: "other/model", usage: 99, requests: 99 },
        ],
      }),
    );

    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:openai/gpt-4.1`,
      ACCOUNT,
      { startMs: Date.parse("2026-07-01T00:00:00Z"), endMs: Date.parse("2026-07-28T00:00:00Z") },
    );
    expect(series.map((s) => s.unit)).toEqual(["USD", "Requests"]);
    expect(series[0]?.points.map((p) => p.value)).toEqual([1.5, 2.5]);
    expect(series[1]?.points.map((p) => p.value)).toEqual([10, 20]);
  });
});

describe("synthesizeSpeech", () => {
  it("requests mp3, uses the inference key, and base64-encodes the raw bytes", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [
            {
              id: "mistralai/voxtral-mini-tts-2603",
              supported_voices: ["en_paul_neutral", "gb_jane_neutral"],
            },
          ],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-or-v1-inference");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "mistralai/voxtral-mini-tts-2603",
        input: "Hello",
        voice: "gb_jane_neutral",
        response_format: "mp3",
      });
      return binaryResponse(audio);
    });

    const result = await client().synthesizeSpeech(
      "model",
      `${ACCOUNT}:model:mistralai/voxtral-mini-tts-2603`,
      ACCOUNT,
      { text: "Hello", voiceId: "gb_jane_neutral", modelId: "mistralai/voxtral-mini-tts-2603" },
    );
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(audio));
    expect(result.characters).toBe(5);
  });

  it("falls back to a valid TTS model when the shared picker holds an STT model", async () => {
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [{ id: "x-ai/grok-voice-tts-1.0", supported_voices: ["eve"] }],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(JSON.parse(String(init?.body)).model).toBe("x-ai/grok-voice-tts-1.0");
      expect(JSON.parse(String(init?.body)).voice).toBe("eve");
      return binaryResponse(new Uint8Array([1]));
    });

    await client().synthesizeSpeech("model", `${ACCOUNT}:model:x-ai/grok-voice-tts-1.0`, ACCOUNT, {
      text: "Hi",
      modelId: "openai/whisper-large-v3",
      voiceId: "not-a-real-voice",
    });
  });

  it("refuses to synthesise with only a management key", async () => {
    await expect(
      client(false).synthesizeSpeech("model", `${ACCOUNT}:model:x/tts`, ACCOUNT, { text: "Hi" }),
    ).rejects.toThrow(/inference API key/);
  });
});

describe("transcribeAudio", () => {
  it("posts base64 JSON rather than multipart, with the container derived from the MIME type", async () => {
    const audioBase64 = Buffer.from("webm-bytes").toString("base64");
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) return jsonResponse({ data: [] });
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-or-v1-inference");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("openai/whisper-large-v3");
      // The clip already arrives base64 — it must go out untouched.
      expect(body.input_audio).toEqual({ data: audioBase64, format: "webm" });
      expect(body.language).toBe("en");
      expect(body.response_format).toBe("verbose_json");
      return jsonResponse({
        text: "hello world",
        language: "english",
        duration: 2.5,
        words: [
          { word: "hello", start: 0, end: 0.4 },
          { word: "world", start: 0.4, end: 0.8, speaker: 1 },
        ],
        usage: { cost: 0.000508, seconds: 2.5 },
      });
    });

    const result = await client().transcribeAudio(
      "model",
      `${ACCOUNT}:model:openai/whisper-large-v3`,
      ACCOUNT,
      { audioBase64, mimeType: "audio/webm;codecs=opus", language: "en" },
    );
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("english");
    expect(result.durationSeconds).toBe(2.5);
    expect(result.words?.[1]).toEqual({
      text: "world",
      start: 0.4,
      end: 0.8,
      speaker: "Speaker 2",
    });
    expect(result.summary).toContain("$0.000508");
  });

  it("retries with the plain json shape when verbose_json is unsupported", async () => {
    let attempt = 0;
    installFetch((url, init) => {
      if (url.includes("output_modalities=")) return jsonResponse({ data: [] });
      attempt++;
      if (attempt === 1) {
        expect(JSON.parse(String(init?.body)).response_format).toBe("verbose_json");
        return jsonResponse("verbose_json unsupported", 400);
      }
      expect(JSON.parse(String(init?.body)).response_format).toBeUndefined();
      return jsonResponse({ text: "plain" });
    });

    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/wav",
    });
    expect(result.text).toBe("plain");
    expect(attempt).toBe(2);
  });

  it("omits the language field when the picker is on auto", async () => {
    installFetch((url, init) => {
      if (url.includes("output_modalities=")) return jsonResponse({ data: [] });
      expect(JSON.parse(String(init?.body)).language).toBeUndefined();
      return jsonResponse({ text: "" });
    });
    await client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
      language: "auto",
    });
  });

  it("refuses a clip over the 25 MB host cap", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
        audioBase64: big,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/over the 25 MB limit/);
  });
});
