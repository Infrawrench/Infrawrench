import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { XaiClient } from "../client.js";

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

function client(managementKey?: string) {
  return new XaiClient({
    apiKey: "xai-inference",
    ...(managementKey ? { managementKey } : {}),
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("requires an inference API key", () => {
    expect(() => new XaiClient({})).toThrow(/missing apiKey/);
  });

  it("constructs without a management key", () => {
    expect(() => client()).not.toThrow();
  });
});

describe("listResources", () => {
  it("folds language, image and embedding models into one list with prices", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/language-models")) {
        return jsonResponse({
          models: [
            {
              id: "grok-4",
              owned_by: "xai",
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              prompt_text_token_price: 300,
              completion_text_token_price: 1500,
              cached_prompt_text_token_price: 75,
            },
          ],
        });
      }
      if (url.endsWith("/v1/image-generation-models")) {
        return jsonResponse({ models: [{ id: "grok-image", image_price: 7000 }] });
      }
      if (url.endsWith("/v1/embedding-models")) {
        return jsonResponse({ models: [{ id: "grok-embed", prompt_text_token_price: 10 }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["grok-4", "grok-image", "grok-embed"]);
    expect(rows[0]?.fields["kind"]).toBe("language");
    expect(rows[0]?.fields["cachedPromptTextTokenPrice"]).toBe(75);
    expect(rows[1]?.fields["kind"]).toBe("image-generation");
    expect(rows[2]?.fields["kind"]).toBe("embedding");
    expect(rows[0]?.id).toBe(`${ACCOUNT}:model:grok-4`);
  });

  it("sends the inference bearer token to api.x.ai", async () => {
    installFetch(() => jsonResponse({ models: [] }));
    await client().listResources("model", ACCOUNT);
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/language-models");
    expect(headers?.["Authorization"]).toBe("Bearer xai-inference");
  });

  it("merges built-in and custom voices into one Voices list", async () => {
    installFetch((url) => {
      if (url.includes("/v1/tts/voices")) {
        return jsonResponse({
          voices: [
            { voice_id: "eve", name: "Eve", language: "en" },
            { voice_id: "ara", name: "Ara", language: "en" },
          ],
        });
      }
      if (url.includes("/v1/custom-voices")) {
        return jsonResponse({
          voices: [{ voice_id: "ab12cd34", name: "Narrator", tone: "warm" }],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().listResources("custom-voice", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["eve", "ara", "ab12cd34"]);
    expect(rows[0]?.fields["builtIn"]).toBe(true);
    expect(rows[2]?.fields["builtIn"]).toBe(false);
    expect(rows[2]?.fields["tone"]).toBe("warm");
  });

  it("falls back to the documented built-in voices when /v1/tts/voices fails", async () => {
    installFetch((url) => {
      if (url.includes("/v1/tts/voices")) return jsonResponse("nope", 500);
      return jsonResponse({ voices: [] });
    });
    const rows = await client().listResources("custom-voice", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["eve", "ara", "leo", "rex", "sal"]);
  });

  it("caps the file page size at 100 and follows pagination_token", async () => {
    let page = 0;
    installFetch((url) => {
      expect(url).toContain("limit=100");
      page++;
      if (page === 1) {
        return jsonResponse({
          data: Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, filename: `f${i}.txt` })),
          pagination_token: "next",
        });
      }
      expect(url).toContain("pagination_token=next");
      return jsonResponse({ data: [{ id: "f100", filename: "f100.txt" }] });
    });

    const rows = await client().listResources("file", ACCOUNT);
    expect(rows).toHaveLength(101);
    expect(rows[100]?.externalId).toBe("f100");
  });

  it("returns an empty list for management-only types when no management key is set", async () => {
    const spy = installFetch(() => jsonResponse({}));
    expect(await client().listResources("api-key", ACCOUNT)).toEqual([]);
    expect(await client().listResources("audit-event", ACCOUNT)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("discovers the team id from the management key and lists team API keys", async () => {
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) {
        return jsonResponse({ scope: "SCOPE_TEAM", scopeId: "team-42", teamId: "team-legacy" });
      }
      if (url.includes("/auth/teams/team-42/api-keys")) {
        return jsonResponse({
          apiKeys: [
            {
              apiKeyId: "k1",
              name: "Prod",
              redactedApiKey: "xai-a**b",
              disabled: "false",
              aclStrings: ["api-key:model:*"],
              tpm: "100000",
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client("xai-mgmt").listResources("api-key", ACCOUNT);
    expect(calls[0]?.url).toBe("https://management-api.x.ai/auth/management-keys/validation");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer xai-mgmt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields["disabled"]).toBe(false);
    expect(rows[0]?.fields["acls"]).toBe("api-key:model:*");
  });

  it("falls back to /v1/api-key for the team id when there is no management key scope", async () => {
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({});
      if (url.endsWith("/v1/api-key")) return jsonResponse({ team_id: "team-from-inference" });
      if (url.includes("/audit/teams/team-from-inference/events")) {
        return jsonResponse({
          events: [
            {
              eventId: "e1",
              eventTime: "2026-01-01T00:00:00Z",
              description: "Key created",
              user: { userId: "u1", email: "a@b.c", givenName: "Ada", familyName: "L" },
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client("xai-mgmt").listResources("audit-event", ACCOUNT);
    expect(rows[0]?.fields["userName"]).toBe("Ada L");
    expect(rows[0]?.displayName).toBe("Key created");
  });
});

describe("api key management", () => {
  it("creates a key with wildcard ACLs and surfaces the one-time plaintext", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      if (url.endsWith("/auth/teams/t1/api-keys") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          name: "CI",
          acls: ["api-key:model:*", "api-key:endpoint:chat"],
          qps: 5,
        });
        return jsonResponse({ apiKeyId: "k9", name: "CI", apiKey: "xai-secret" });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const created = await client("xai-mgmt").createResource("api-key", ACCOUNT, {
      name: "CI",
      modelAcl: "*",
      endpointAcl: "chat",
      qps: "5",
    });
    expect(created.resolvedOutputs["apiKey"]).toBe("xai-secret");
  });

  it("updates a key through PUT with a field mask", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/auth/api-keys/k1") && init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({
          apiKey: { name: "Renamed", qpm: 200 },
          fieldMask: "name,qpm",
        });
        return jsonResponse({ apiKeyId: "k1", name: "Renamed", qpm: 200 });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const updated = await client("xai-mgmt").updateResource(
      "api-key",
      `${ACCOUNT}:api-key:k1`,
      ACCOUNT,
      {
        name: "Renamed",
        qpm: "200",
      },
    );
    expect(updated.fields["name"]).toBe("Renamed");
  });

  it("rotates a key via the plugin action", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://management-api.x.ai/auth/api-keys/k1/rotate");
      expect(init?.method).toBe("POST");
      return jsonResponse({ apiKeyId: "k1" });
    });
    await client("xai-mgmt").invokeAction("api-key", `${ACCOUNT}:api-key:k1`, "rotate", ACCOUNT);
    expect(calls).toHaveLength(1);
  });

  it("deletes a custom voice on the inference host", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://api.x.ai/v1/custom-voices/ab12cd34");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({}, 204);
    });
    await client().deleteResource("custom-voice", `${ACCOUNT}:custom-voice:ab12cd34`, ACCOUNT);
  });
});

describe("fetchCostData", () => {
  it("refuses with a CostSetupError when there is no management key", async () => {
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-07" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });

  it("turns the analytics time series into daily USD rows", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      if (url.endsWith("/v1/billing/teams/t1/usage")) {
        const body = JSON.parse(String(init?.body));
        expect(body.analyticsRequest.timeUnit).toBe("TIME_UNIT_DAY");
        expect(body.analyticsRequest.timeRange).toEqual({
          startTime: "2026-07-01 00:00:00",
          endTime: "2026-07-03 00:00:00",
          timezone: "Etc/GMT",
        });
        expect(body.analyticsRequest.values).toEqual([
          { name: "usd", aggregation: "AGGREGATION_SUM" },
        ]);
        return jsonResponse({
          timeSeries: [
            {
              group: ["Chat grok-4-0709"],
              groupLabels: ["Chat grok-4-0709"],
              dataPoints: [
                { timestamp: "2026-07-01T00:00:00Z", values: [0.75] },
                { timestamp: "2026-07-02T00:00:00Z", values: [0] },
                // Outside the requested range — must be dropped.
                { timestamp: "2026-07-09T00:00:00Z", values: [9] },
              ],
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client("xai-mgmt").fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-02",
    });
    expect(rows).toEqual([
      { date: "2026-07-01", service: "Chat grok-4-0709", currency: "USD", amount: 0.75 },
      { date: "2026-07-02", service: "Chat grok-4-0709", currency: "USD", amount: 0 },
    ]);
  });
});

describe("fetchMetricSeries", () => {
  it("keeps only the series whose group label names the model", async () => {
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      if (url.endsWith("/v1/billing/teams/t1/usage")) {
        return jsonResponse({
          timeSeries: [
            {
              groupLabels: ["Chat grok-4"],
              dataPoints: [{ timestamp: "2026-07-01T00:00:00Z", values: [1.5] }],
            },
            {
              groupLabels: ["Chat grok-3"],
              dataPoints: [{ timestamp: "2026-07-01T00:00:00Z", values: [99] }],
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const series = await client("xai-mgmt").fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:grok-4`,
      ACCOUNT,
      {
        startMs: Date.parse("2026-07-01T00:00:00Z"),
        endMs: Date.parse("2026-07-02T00:00:00Z"),
      },
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.points).toEqual([
      { timestamp: Date.parse("2026-07-01T00:00:00Z"), value: 1.5 },
    ]);
  });

  it("returns nothing without a management key", async () => {
    expect(await client().fetchMetricSeries("model", `${ACCOUNT}:model:grok-4`, ACCOUNT)).toEqual(
      [],
    );
  });
});

describe("synthesizeSpeech", () => {
  it("requests mp3 and passes the base64 audio through unchanged", async () => {
    const audio = Buffer.from("fake-mp3-bytes").toString("base64");
    installFetch((url, init) => {
      expect(url).toBe("https://api.x.ai/v1/tts");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        text: "Hello there",
        voice_id: "ara",
        language: "en",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
      });
      return jsonResponse({ audio, content_type: "audio/mpeg", duration: 1.25 });
    });

    const result = await client().synthesizeSpeech("custom-voice", "id", ACCOUNT, {
      text: "Hello there",
      voiceId: "ara",
      modelId: "en",
    });
    expect(result.audioBase64).toBe(audio);
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("fake-mp3-bytes");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.fileName).toBe("xai-ara.mp3");
    expect(result.characters).toBe(11);
    expect(result.summary).toContain("1.25s audio");
  });

  it("truncates at the documented 15,000 character cap", async () => {
    installFetch((_url, init) => {
      expect(JSON.parse(String(init?.body)).text).toHaveLength(15000);
      return jsonResponse({ audio: "", content_type: "audio/mpeg" });
    });
    await client().synthesizeSpeech("custom-voice", "id", ACCOUNT, { text: "x".repeat(20000) });
  });
});

describe("transcribeAudio", () => {
  it("posts multipart with the recorded MIME type and file last", async () => {
    const audioBase64 = Buffer.from("webm-bytes").toString("base64");
    installFetch((url, init) => {
      expect(url).toBe("https://api.x.ai/v1/stt");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
      const body = Buffer.from(init?.body as Uint8Array).toString("binary");
      expect(body).toContain('name="language"');
      expect(body).toContain('name="diarize"');
      expect(body).toContain("Content-Type: audio/webm;codecs=opus");
      expect(body).toContain("webm-bytes");
      // `file` must be the last field in the form.
      expect(body.lastIndexOf('name="file"')).toBeGreaterThan(body.lastIndexOf('name="diarize"'));
      return jsonResponse({
        text: "hello world",
        language: "en",
        duration: 2.5,
        words: [
          { text: "hello", start: 0, end: 0.4, confidence: 0.9, speaker: 0 },
          { text: "world", start: 0.4, end: 0.8, confidence: 0.7, speaker: 1 },
        ],
      });
    });

    const result = await client().transcribeAudio("custom-voice", "id", ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm;codecs=opus",
      language: "en",
    });
    expect(result.text).toBe("hello world");
    expect(result.durationSeconds).toBe(2.5);
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.words?.[1]).toEqual({
      text: "world",
      start: 0.4,
      end: 0.8,
      speaker: "Speaker 2",
    });
  });

  it("omits the language field when the picker is on auto", async () => {
    installFetch((_url, init) => {
      const body = Buffer.from(init?.body as Uint8Array).toString("binary");
      expect(body).not.toContain('name="language"');
      return jsonResponse({ text: "" });
    });
    await client().transcribeAudio("custom-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
      language: "auto",
    });
  });

  it("refuses a clip over the 25 MB host cap", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    await expect(
      client().transcribeAudio("custom-voice", "id", ACCOUNT, {
        audioBase64: big,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/over the 25 MB limit/);
  });

  it("routes multipart through the host HTTP service when one is available", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ text: "via host" }),
    }));
    const hosted = new XaiClient({ apiKey: "xai-inference" }, { http: { request } });
    const result = await hosted.transcribeAudio("custom-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/wav",
    });
    expect(result.text).toBe("via host");
    const req = (
      request.mock.calls as unknown as Array<[{ body: Uint8Array; url: string }]>
    )[0]?.[0];
    expect(req?.url).toBe("https://api.x.ai/v1/stt");
    expect(req?.body).toBeInstanceOf(Uint8Array);
  });
});
