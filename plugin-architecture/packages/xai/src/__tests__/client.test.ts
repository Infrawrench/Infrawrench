import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError, CreditAccessError } from "@infrawrench/plugin-base";
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

  it("keeps paging files while a token comes back, even on a short page", async () => {
    let page = 0;
    installFetch(() => {
      page++;
      // A page well under `limit` that still carries a token: the server
      // short-paged, it is not the end of the list.
      if (page === 1) {
        return jsonResponse({
          data: [{ id: "f0", filename: "f0.txt" }],
          pagination_token: "next",
        });
      }
      return jsonResponse({ data: [{ id: "f1", filename: "f1.txt" }], pagination_token: null });
    });

    const rows = await client().listResources("file", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["f0", "f1"]);
    expect(calls).toHaveLength(2);
  });

  it("stops when the server keeps echoing the same cursor, without duplicating rows", async () => {
    // A server that never advances its cursor. Breaking only on a missing
    // token would re-fetch this page up to the iteration cap and emit the same
    // resource id many times over: worse than truncating, because duplicate
    // ids corrupt the listing rather than shortening it.
    installFetch(() =>
      jsonResponse({ data: [{ id: "f0", filename: "f0.txt" }], pagination_token: "stuck" }),
    );

    const rows = await client().listResources("file", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["f0"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(calls).toHaveLength(2);
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

  it("follows nextPageToken through the audit log and stops when it runs out", async () => {
    let page = 0;
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      if (url.includes("/audit/teams/t1/events")) {
        expect(url).toContain("pageSize=200");
        page++;
        if (page === 1) {
          expect(url).not.toContain("pageToken=");
          return jsonResponse({ events: [{ eventId: "e1" }], nextPageToken: "p2" });
        }
        expect(url).toContain("pageToken=p2");
        return jsonResponse({ events: [{ eventId: "e2" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client("xai-mgmt").listResources("audit-event", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["e1", "e2"]);
    expect(page).toBe(2);
  });

  it("caps the audit walk and says so instead of truncating silently", async () => {
    let page = 0;
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      if (url.includes("/audit/teams/t1/events")) {
        page++;
        // A log that never stops handing back tokens.
        return jsonResponse({ events: [{ eventId: `e${page}` }], nextPageToken: `p${page + 1}` });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client("xai-mgmt").listResources("audit-event", ACCOUNT);
    expect(page).toBe(20);
    expect(rows).toHaveLength(21);
    expect(rows[20]?.externalId).toBe("__truncated__");
    expect(rows[20]?.displayName).toContain("Older events not shown");
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
                // Outside the requested range: must be dropped.
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

  function usageBodies(): Array<{ analyticsRequest: Record<string, unknown> }> {
    return calls
      .filter((c) => c.url.endsWith("/usage"))
      .map(
        (c) => JSON.parse(String(c.init?.body)) as { analyticsRequest: Record<string, unknown> },
      );
  }

  it("buckets by hour for windows up to two days and by day beyond", async () => {
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      return jsonResponse({ timeSeries: [] });
    });
    const id = `${ACCOUNT}:model:grok-4`;
    await client("xai-mgmt").fetchMetricSeries("model", id, ACCOUNT, {
      startMs: Date.parse("2026-07-01T10:30:00Z"),
      endMs: Date.parse("2026-07-02T10:30:00Z"),
    });
    await client("xai-mgmt").fetchMetricSeries("model", id, ACCOUNT, {
      startMs: Date.parse("2026-06-01T10:30:00Z"),
      endMs: Date.parse("2026-07-01T10:30:00Z"),
    });
    const [hourly, daily] = usageBodies();
    expect(hourly?.analyticsRequest["timeUnit"]).toBe("TIME_UNIT_HOUR");
    expect(hourly?.analyticsRequest["timeRange"]).toEqual({
      startTime: "2026-07-01 10:00:00",
      endTime: "2026-07-02 11:00:00",
      timezone: "Etc/GMT",
    });
    expect(daily?.analyticsRequest["timeUnit"]).toBe("TIME_UNIT_DAY");
    expect(daily?.analyticsRequest["timeRange"]).toEqual({
      startTime: "2026-06-01 00:00:00",
      endTime: "2026-07-02 00:00:00",
      timezone: "Etc/GMT",
    });
  });

  it("charts team spend on the spending limit: a total plus the costliest line items", async () => {
    const day1 = "2026-07-01T00:00:00Z";
    const day2 = "2026-07-02T00:00:00Z";
    const line = (label: string, a: number, b: number) => ({
      groupLabels: [label],
      dataPoints: [
        { timestamp: day2, values: [b] },
        { timestamp: day1, values: [a] },
      ],
    });
    installFetch((url) => {
      if (url.endsWith("/auth/management-keys/validation")) return jsonResponse({ scopeId: "t1" });
      return jsonResponse({
        timeSeries: [
          line("Chat grok-4", 1, 2),
          line("Image grok-imagine", 0, 0),
          line("Chat grok-3", 0.5, 0),
          line("Search", 0.1, 0.1),
          line("Chat grok-4-fast", 0.2, 0.2),
          line("Embeddings", 0.3, 0.3),
          line("Voice", 0.01, 0),
        ],
      });
    });

    const series = await client("xai-mgmt").fetchMetricSeries(
      "spending-limit",
      `${ACCOUNT}:spending-limit:team`,
      ACCOUNT,
      { startMs: Date.parse(day1), endMs: Date.parse("2026-07-10T00:00:00Z") },
    );
    expect(series.map((s) => s.label)).toEqual([
      "Total spend",
      "Chat grok-4",
      "Embeddings",
      "Chat grok-3",
      "Chat grok-4-fast",
      "Search",
    ]);
    expect(series[0]?.points.map((p) => [p.timestamp, Number(p.value.toFixed(2))])).toEqual([
      [Date.parse(day1), 2.11],
      [Date.parse(day2), 2.6],
    ]);
    expect(series.every((s) => s.unit === "USD")).toBe(true);
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

function validation(url: string): Response | undefined {
  if (url.endsWith("/auth/management-keys/validation")) {
    return jsonResponse({ scope: "SCOPE_TEAM", scopeId: "team-42" });
  }
  return undefined;
}

describe("models: video generation and capabilities", () => {
  it("adds video models and the accepted reasoning efforts", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/language-models")) {
        return jsonResponse({
          models: [
            {
              id: "grok-4.3",
              capabilities: { reasoning_effort: ["low", "high"], default_reasoning_effort: "high" },
            },
          ],
        });
      }
      if (url.endsWith("/v1/image-generation-models")) {
        return jsonResponse({
          models: [
            {
              id: "grok-imagine-image",
              image_price: 200000000,
              pricing: [{ quality: "high", resolution: "2k", price_per_image: 700000000 }],
            },
          ],
        });
      }
      if (url.endsWith("/v1/video-generation-models")) {
        return jsonResponse({
          models: [
            {
              id: "grok-imagine-video",
              input_modalities: ["text", "image"],
              output_modalities: ["video"],
            },
          ],
        });
      }
      if (url.endsWith("/v1/embedding-models")) return jsonResponse({ models: [] });
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows.map((r) => [r.externalId, r.fields["kind"]])).toEqual([
      ["grok-4.3", "language"],
      ["grok-imagine-image", "image-generation"],
      ["grok-imagine-video", "video-generation"],
    ]);
    expect(rows[0]?.fields["reasoningEfforts"]).toBe("low, high");
    expect(rows[0]?.fields["defaultReasoningEffort"]).toBe("high");
    expect(rows[2]?.fields["outputModalities"]).toBe("video");

    const detail = client().renderDetail(rows[1]!);
    const pricing = detail.sections.find((s) => s.title === "Pricing");
    const table = pricing?.children[0];
    if (table?.kind !== "table") throw new Error("expected a pricing table");
    expect(table.rows.map((r) => r.cells["meter"])).toContain("Image (high, 2k)");
    expect(table.rows.find((r) => r.cells["meter"] === "Image (high, 2k)")?.cells["price"]).toBe(
      "$0.0700",
    );
  });
});

describe("files: public URLs", () => {
  it("creates and revokes a public URL through plugin actions", async () => {
    installFetch(() => jsonResponse({ public_url: "https://files-cdn.x.ai/x.png" }));
    const c = client();
    await c.invokeAction("file", `${ACCOUNT}:file:file_1`, "create-public-url", ACCOUNT);
    await c.invokeAction("file", `${ACCOUNT}:file:file_1`, "revoke-public-url", ACCOUNT);
    expect(calls.map((x) => [x.init?.method, x.url])).toEqual([
      ["POST", "https://api.x.ai/v1/files/file_1/public-url"],
      ["POST", "https://api.x.ai/v1/files/file_1/public-url/revoke"],
    ]);
  });

  it("offers create when there is no public URL and revoke when there is one", () => {
    const base = {
      id: `${ACCOUNT}:file:file_1`,
      pluginId: "xai",
      resourceTypeId: "file",
      accountId: ACCOUNT,
      displayName: "a.png",
      externalId: "file_1",
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const labels = (publicUrl: string) =>
      client()
        .renderDetail({ ...base, fields: { fileId: "file_1", publicUrl } })
        .headerActions?.map((a) => a.label);
    expect(labels("")).toContain("Create public URL");
    expect(labels("https://files-cdn.x.ai/x.png")).toContain("Revoke public URL");
  });
});

describe("batches", () => {
  it("creates a named batch and cancels it with the colon verb", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/batches")) {
        return jsonResponse({ batch_id: "b1", name: "nightly", state: { num_requests: 0 } });
      }
      return jsonResponse({ batch_id: "b1" });
    });
    const c = client();
    const created = await c.createResource("batch", ACCOUNT, { name: "nightly" });
    expect(created.id).toBe(`${ACCOUNT}:batch:b1`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "nightly" });

    await c.invokeAction("batch", `${ACCOUNT}:batch:b1`, "cancel", ACCOUNT);
    expect(calls[1]?.url).toBe("https://api.x.ai/v1/batches/b1:cancel");
    expect(calls[1]?.init?.method).toBe("POST");
  });

  it("stashes the first page of per-request state for the detail view", async () => {
    installFetch((url) => {
      if (url.includes("/v1/batches?")) {
        return jsonResponse({
          batches: [
            { batch_id: "b1", name: "nightly", state: { num_requests: 1, num_pending: 1 } },
          ],
        });
      }
      if (url.includes("/v1/batches/b1/requests")) {
        return jsonResponse({
          batch_request_metadata: [
            { batch_request_id: "r1", state: "pending", model: "grok-4", endpoint: "chat" },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const c = client();
    const batch = await c.getResource("batch", `${ACCOUNT}:batch:b1`, ACCOUNT);
    expect(calls[1]?.url).toBe("https://api.x.ai/v1/batches/b1/requests?limit=100");
    const detail = c.renderDetail(batch);
    const requests = detail.sections.find((s) => s.title === "Requests");
    const tables = requests?.children.filter((n) => n.kind === "table") ?? [];
    expect(tables).toHaveLength(2);
    expect(detail.headerActions?.map((a) => a.label)).toContain("Cancel batch");
  });
});

describe("skills", () => {
  it("pages with the after cursor and deletes", async () => {
    installFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse({ id: "s1", deleted: true });
      if (url.includes("after=s2")) {
        return jsonResponse({ data: [{ id: "s3", name: "c" }], has_more: false, last_id: "s3" });
      }
      return jsonResponse({
        data: [
          { id: "s1", name: "a", created_at: 1_700_000_000, latest_version: "1" },
          { id: "s2", name: "b" },
        ],
        has_more: true,
        last_id: "s2",
      });
    });
    const c = client();
    const rows = await c.listResources("skill", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["s1", "s2", "s3"]);
    expect(calls[1]?.url).toBe("https://api.x.ai/v1/skills?limit=100&order=desc&after=s2");

    await c.deleteResource("skill", `${ACCOUNT}:skill:s1`, ACCOUNT);
    expect(calls[2]?.url).toBe("https://api.x.ai/v1/skills/s1");
  });
});

describe("collections", () => {
  it("lists collections and their documents on the management host", async () => {
    installFetch((url) => {
      if (url.includes("/v1/collections?")) {
        return jsonResponse({
          collections: [
            {
              collection_id: "collection_a",
              collection_name: "SEC Filings",
              index_configuration: { model_name: "grok-embedding-small" },
              chunk_configuration: {
                tokens_configuration: {
                  max_chunk_size_tokens: 1024,
                  chunk_overlap_tokens: 200,
                  encoding_name: "o200k_base",
                },
              },
              documents_count: 1,
            },
            { collection_id: "collection_empty", collection_name: "Empty", documents_count: 0 },
          ],
        });
      }
      if (url.includes("/v1/collections/collection_a/documents?")) {
        return jsonResponse({
          documents: [
            {
              file_metadata: { file_id: "file_9", name: "q2.txt", size_bytes: "119237" },
              fields: { type: "10-Q" },
              status: "DOCUMENT_STATUS_PROCESSED",
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const c = client("xai-mgmt");
    const collections = await c.listResources("collection", ACCOUNT);
    expect(calls[0]?.url).toBe("https://management-api.x.ai/v1/collections?limit=100");
    expect(collections[0]?.fields["chunking"]).toBe(
      "Tokens · 1024 tokens per chunk · 200 overlap · o200k_base",
    );

    calls = [];
    const docs = await c.listResources("collection-document", ACCOUNT);
    // The empty collection is skipped by its documents_count.
    expect(calls.some((x) => x.url.includes("collection_empty"))).toBe(false);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(`${ACCOUNT}:collection-document:collection_a/file_9`);
    expect(docs[0]?.fields).toMatchObject({
      collectionName: "SEC Filings",
      sizeBytes: 119237,
      metadata: "type=10-Q",
    });
  });

  it("returns nothing without a management key", async () => {
    const spy = installFetch(() => jsonResponse({}));
    expect(await client().listResources("collection", ACCOUNT)).toEqual([]);
    expect(await client().listResources("collection-document", ACCOUNT)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("creates a collection with an embedding model and token chunking", async () => {
    installFetch(() =>
      jsonResponse({
        collection_id: "collection_new",
        collection_name: "Docs",
        documents_count: 0,
      }),
    );
    await client("xai-mgmt").createResource("collection", ACCOUNT, {
      name: "Docs",
      description: "Runbooks",
      embeddingModel: "grok-embedding-small",
      maxChunkTokens: "512",
      chunkOverlapTokens: "64",
    });
    expect(calls[0]?.url).toBe("https://management-api.x.ai/v1/collections");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      collection_name: "Docs",
      collection_description: "Runbooks",
      index_configuration: { model_name: "grok-embedding-small" },
      chunk_configuration: {
        tokens_configuration: { max_chunk_size_tokens: 512, chunk_overlap_tokens: 64 },
      },
    });
  });

  it("renames a collection with PUT", async () => {
    installFetch(() => jsonResponse({ collection_id: "collection_a", collection_name: "New" }));
    await client("xai-mgmt").updateResource(
      "collection",
      `${ACCOUNT}:collection:collection_a`,
      ACCOUNT,
      { name: "New", description: "d" },
    );
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      collection_name: "New",
      collection_description: "d",
    });
  });

  it("attaches, re-indexes and removes a document by collection and file", async () => {
    installFetch((url, init) => {
      if (init?.method === "GET" || !init?.method) {
        if (url.endsWith("/documents/file_9")) {
          return jsonResponse({
            file_metadata: { file_id: "file_9", name: "q2.txt" },
            status: "DOCUMENT_STATUS_PROCESSING",
          });
        }
        return jsonResponse({ collection_id: "collection_a", collection_name: "SEC Filings" });
      }
      return jsonResponse({});
    });
    const c = client("xai-mgmt");
    const doc = await c.createResource("collection-document", ACCOUNT, {
      collectionId: "collection_a",
      fileId: "file_9",
    });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://management-api.x.ai/v1/collections/collection_a/documents/file_9",
    );
    expect(doc.id).toBe(`${ACCOUNT}:collection-document:collection_a/file_9`);
    expect(doc.fields["collectionName"]).toBe("SEC Filings");

    calls = [];
    await c.invokeAction("collection-document", doc.id, "reindex", ACCOUNT);
    await c.deleteResource("collection-document", doc.id, ACCOUNT);
    expect(calls.map((x) => [x.init?.method, x.url])).toEqual([
      ["PATCH", "https://management-api.x.ai/v1/collections/collection_a/documents/file_9"],
      ["DELETE", "https://management-api.x.ai/v1/collections/collection_a/documents/file_9"],
    ]);
  });
});

describe("billing: invoices, spending limit and prepaid credit", () => {
  it("lists invoices in dollars, newest first", async () => {
    installFetch((url) => {
      const v = validation(url);
      if (v) return v;
      if (url.includes("/v1/billing/teams/team-42/invoices?")) {
        return jsonResponse({
          invoices: [
            {
              invoiceId: "i1",
              invoiceNumber: "111",
              createTime: "2026-08-01T00:00:00Z",
              invoiceStatus: "PAID",
              subtotal: "1000",
              tax: "200",
              total: "1200",
              lines: [
                { description: "Chat grok-4", unitPrice: "20000", numUnits: "5", amount: "1000" },
              ],
              monthly: { billingCycle: { year: 2026, month: 7 } },
            },
            {
              invoiceId: "i2",
              invoiceNumber: "222",
              createTime: "2026-09-01T00:00:00Z",
              invoiceStatus: "PENDING",
              total: "500",
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const rows = await client("xai-mgmt").listResources("invoice", ACCOUNT);
    expect(calls[1]?.url).toMatch(/since\.year=\d{4}&since\.month=\d+$/);
    expect(rows.map((r) => r.externalId)).toEqual(["i2", "i1"]);
    expect(rows[1]?.fields).toMatchObject({
      total: 12,
      subtotal: 10,
      tax: 2,
      billingCycle: "2026-07",
      lineCount: 1,
    });
    const detail = client().renderDetail(rows[1]!);
    const lines = detail.sections.find((s) => s.title === "Line Items")?.children[0];
    if (lines?.kind !== "table") throw new Error("expected line items");
    expect(lines.rows[0]?.cells["unitPrice"]).toBe("$200.0000 / 1M");
  });

  it("reads the spending limit with this period's preview and sets it in cents", async () => {
    installFetch((url, init) => {
      const v = validation(url);
      if (v) return v;
      if (url.endsWith("/postpaid/spending-limits") && init?.method === "POST") {
        return jsonResponse({ thisBpSoftSpendingLimit: { val: "15000" } });
      }
      if (url.endsWith("/postpaid/spending-limits")) {
        return jsonResponse({
          spendingLimits: {
            hardSlAuto: { val: "22500" },
            effectiveHardSl: { val: "22500" },
            softSl: { val: "20000" },
            effectiveSl: { val: "20000" },
          },
        });
      }
      if (url.endsWith("/postpaid/invoice/preview")) {
        return jsonResponse({
          coreInvoice: {
            amountAfterVat: "1234",
            prepaidCredits: { val: "-4500" },
            prepaidCreditsUsed: { val: "500" },
          },
          billingCycle: { year: 2026, month: 10 },
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const c = client("xai-mgmt");
    const [row] = await c.listResources("spending-limit", ACCOUNT);
    expect(row?.fields).toMatchObject({
      softLimit: 200,
      effectiveLimit: 200,
      hardLimit: 225,
      currentSpend: 12.34,
      prepaidCredits: 45,
      prepaidCreditsUsed: 5,
      billingCycle: "2026-10",
    });

    calls = [];
    await c.updateResource("spending-limit", row!.id, ACCOUNT, { softLimit: "150" });
    const post = calls.find((x) => x.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      desiredSoftSpendingLimit: { val: "15000" },
    });

    expect(await c.fetchCreditBalance()).toEqual([
      {
        key: "prepaid",
        label: "Prepaid credits",
        remaining: 40,
        currency: "USD",
        granted: 45,
      },
    ]);
  });

  it("rejects a negative spending limit before calling the API", async () => {
    const spy = installFetch(() => jsonResponse({}));
    await expect(
      client("xai-mgmt").updateResource(
        "spending-limit",
        `${ACCOUNT}:spending-limit:team`,
        ACCOUNT,
        {
          softLimit: "-5",
        },
      ),
    ).rejects.toThrow(/non-negative/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports no pot for a postpaid team and a CreditAccessError without a management key", async () => {
    installFetch((url) => {
      const v = validation(url);
      if (v) return v;
      return jsonResponse({ coreInvoice: { prepaidCredits: { val: "0" } } });
    });
    expect(await client("xai-mgmt").fetchCreditBalance()).toEqual([]);
    await expect(client().fetchCreditBalance()).rejects.toBeInstanceOf(CreditAccessError);
  });
});
