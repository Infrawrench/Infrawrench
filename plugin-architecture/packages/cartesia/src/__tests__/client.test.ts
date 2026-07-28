import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartesiaClient } from "../client.js";

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
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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

function client(extra: Record<string, string> = {}) {
  return new CartesiaClient({ apiKey: "sk_car_test", ...extra });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

const VOICE = {
  id: "a0e99841-438c-4a64-b679-ae501e7d6091",
  name: "Barbershop Man",
  tagline: "Warm and conversational",
  description: "A friendly American male voice",
  gender: "masculine",
  language: "en",
  locales: [{ locale: "en-US" }],
  country: "US",
  created_at: "2026-01-02T03:04:05Z",
  is_owner: true,
  is_pro: false,
  access: { type: "private", visibility: "owner" },
  preview_file_url: "https://files.cartesia.ai/preview.wav",
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("headers", () => {
  it("sends the mandatory Cartesia-Version header and a Bearer key on every call", async () => {
    installFetch(() => jsonResponse({ data: [VOICE], has_more: false, next_page: null }));

    await client().listResources("voice", ACCOUNT);

    expect(headerOf(calls[0]!.init, "Cartesia-Version")).toBe("2026-03-01");
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("Bearer sk_car_test");
  });
});

describe("listResources", () => {
  it("expands preview_file_url and follows the starting_after cursor", async () => {
    installFetch((url) => {
      if (url.includes("starting_after")) {
        return jsonResponse({
          data: [{ ...VOICE, id: "second-voice", name: "Second" }],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse({ data: [VOICE], has_more: true, next_page: VOICE.id });
    });

    const voices = await client().listResources("voice", ACCOUNT);

    expect(voices.map((voice) => voice.displayName)).toEqual(["Barbershop Man", "Second"]);
    expect(calls[0]!.url).toBe(
      "https://api.cartesia.ai/voices?limit=100&expand%5B%5D=preview_file_url",
    );
    expect(calls[1]!.url).toBe(
      `https://api.cartesia.ai/voices?limit=100&expand%5B%5D=preview_file_url&starting_after=${VOICE.id}`,
    );
    expect(voices[0]!.fields["previewUrl"]).toBe("https://files.cartesia.ai/preview.wav");
    expect(voices[0]!.id).toBe(`${ACCOUNT}:voice:${VOICE.id}`);
  });

  it("lists pronunciation dictionaries from the trailing-slash path", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "dict-1",
            name: "Brands",
            description: "Product names",
            is_owner: true,
            pinned: true,
            access: { type: "private", visibility: "owner" },
            items: [{ text: "Cartesia", pronunciation: "car-TEE-zhuh" }],
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );

    const dicts = await client().listResources("pronunciation-dict", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.cartesia.ai/pronunciation-dicts/?limit=100");
    expect(dicts[0]!.fields["entryCount"]).toBe(1);
    expect(dicts[0]!.resolvedOutputs?.["__items__"]).toContain("car-TEE-zhuh");
  });

  it("returns no API keys and makes no request when the admin key is absent", async () => {
    installFetch(() => jsonResponse({}));

    const keys = await client().listResources("api-key", ACCOUNT);

    expect(keys).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("lists API keys with the admin key when one is configured", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "key-1",
            description: "production",
            created_at: "2026-03-01T00:00:00Z",
            creator_email: "astrid@example.com",
            creator_still_in_org: true,
          },
        ],
        has_more: false,
        next_page: null,
      }),
    );

    const keys = await client({ adminApiKey: "sk_car_admin_test" }).listResources(
      "api-key",
      ACCOUNT,
    );

    expect(calls[0]!.url).toBe("https://api.cartesia.ai/api-keys?limit=100");
    expect(headerOf(calls[0]!.init, "Authorization")).toBe("Bearer sk_car_admin_test");
    expect(keys[0]!.displayName).toBe("production");
  });
});

describe("getResource", () => {
  it("expands the preview URL and stashes the voice picker for the Speech tab", async () => {
    installFetch((url) => {
      if (url.startsWith("https://api.cartesia.ai/voices/")) return jsonResponse(VOICE);
      return jsonResponse({
        data: [VOICE, { ...VOICE, id: "other", name: "Other" }],
        has_more: false,
        next_page: null,
      });
    });

    const voice = await client().getResource("voice", `${ACCOUNT}:voice:${VOICE.id}`, ACCOUNT);

    expect(calls[0]!.url).toBe(
      `https://api.cartesia.ai/voices/${VOICE.id}?expand%5B%5D=preview_file_url`,
    );
    const picker = JSON.parse(voice.resolvedOutputs?.["__voices__"] ?? "[]") as Array<{
      id: string;
    }>;
    expect(picker.map((option) => option.id)).toEqual([VOICE.id, "other"]);
  });
});

describe("deleteResource", () => {
  it("deletes a voice and a pronunciation dictionary on their documented paths", async () => {
    installFetch(() => jsonResponse("", 204));

    await client().deleteResource("voice", `${ACCOUNT}:voice:${VOICE.id}`, ACCOUNT);
    await client().deleteResource(
      "pronunciation-dict",
      `${ACCOUNT}:pronunciation-dict:dict-1`,
      ACCOUNT,
    );

    expect(calls[0]!.url).toBe(`https://api.cartesia.ai/voices/${VOICE.id}`);
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[1]!.url).toBe("https://api.cartesia.ai/pronunciation-dicts/dict-1");
    expect(calls[1]!.init?.method).toBe("DELETE");
  });

  it("refuses to delete an API key", async () => {
    await expect(
      client().deleteResource("api-key", `${ACCOUNT}:api-key:key-1`, ACCOUNT),
    ).rejects.toThrow(/cannot delete type "api-key"/);
  });
});

describe("renderDetail", () => {
  it("wires the Speech tab with both modes and the Sonic model enum", async () => {
    installFetch((url) => {
      if (url.startsWith("https://api.cartesia.ai/voices/")) return jsonResponse(VOICE);
      return jsonResponse({ data: [VOICE], has_more: false, next_page: null });
    });

    const c = client();
    const voice = await c.getResource("voice", `${ACCOUNT}:voice:${VOICE.id}`, ACCOUNT);
    const detail = c.renderDetail(voice);

    expect(detail.speechPanel?.modes).toEqual(["tts", "stt"]);
    expect(detail.speechPanel?.defaultVoice).toBe(VOICE.id);
    expect(detail.speechPanel?.models?.map((model) => model.id)).toEqual([
      "sonic-3.5",
      "sonic-3",
      "sonic-latest",
    ]);
    expect(detail.speechPanel?.defaultModel).toBe("sonic-3.5");
    // Cartesia documents no transcript ceiling — we must not invent one.
    expect(detail.speechPanel?.maxCharacters).toBeUndefined();
    expect(detail.speechPanel?.voices?.[0]?.id).toBe(VOICE.id);
  });
});

describe("synthesizeSpeech", () => {
  it("posts transcript + voice object + mp3 output_format and base64s the bytes back", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    installFetch(() => binaryResponse(audio, { "x-request-id": "req-123" }));

    const result = await client().synthesizeSpeech(
      "voice",
      `${ACCOUNT}:voice:${VOICE.id}`,
      ACCOUNT,
      { text: "Hello there", modelId: "sonic-3.5" },
    );

    expect(calls[0]!.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(headerOf(calls[0]!.init, "Cartesia-Version")).toBe("2026-03-01");

    const body = JSON.parse(calls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body["transcript"]).toBe("Hello there");
    expect(body["text"]).toBeUndefined();
    expect(body["voice"]).toEqual({ mode: "id", id: VOICE.id });
    expect(body["model_id"]).toBe("sonic-3.5");
    // mp3 takes container/sample_rate/bit_rate only — an `encoding` key is a 400.
    expect(body["output_format"]).toEqual({
      container: "mp3",
      sample_rate: 44100,
      bit_rate: 128000,
    });

    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.requestId).toBe("req-123");
    expect(result.characters).toBe(11);
    expect(Array.from(Buffer.from(result.audioBase64, "base64"))).toEqual(Array.from(audio));
  });

  it("prefers the picked voice over the resource's own id", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1, 2, 3])));

    await client().synthesizeSpeech("voice", `${ACCOUNT}:voice:${VOICE.id}`, ACCOUNT, {
      text: "Hi",
      voiceId: "picked-voice",
    });

    const body = JSON.parse(calls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body["voice"]).toEqual({ mode: "id", id: "picked-voice" });
    expect(body["model_id"]).toBe("sonic-3.5");
  });

  it("surfaces the provider error body instead of trying to parse it as audio", async () => {
    installFetch(() => jsonResponse({ error: "invalid output_format" }, 400));

    await expect(
      client().synthesizeSpeech("voice", `${ACCOUNT}:voice:${VOICE.id}`, ACCOUNT, { text: "Hi" }),
    ).rejects.toThrow(/Cartesia API error 400 for \/tts\/bytes: .*invalid output_format/);
  });
});

describe("transcribeAudio", () => {
  it("uploads multipart with ink-whisper and forwards the recorder's MIME type", async () => {
    installFetch(() =>
      jsonResponse({
        type: "transcript",
        request_id: "stt-1",
        text: "hello world",
        language: "en",
        duration: 1.5,
        words: [
          { word: "hello", start: 0, end: 0.5 },
          { word: "world", start: 0.5, end: 1 },
        ],
      }),
    );

    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");
    const result = await client().transcribeAudio(
      "voice",
      `${ACCOUNT}:voice:${VOICE.id}`,
      ACCOUNT,
      { audioBase64: audio, mimeType: "audio/webm;codecs=opus", language: "en" },
    );

    expect(calls[0]!.url).toBe("https://api.cartesia.ai/stt");
    expect(calls[0]!.init?.method).toBe("POST");
    // fetch must own Content-Type so the multipart boundary matches the body.
    expect(headerOf(calls[0]!.init, "Content-Type")).toBeUndefined();

    const form = calls[0]!.init?.body as FormData;
    expect(form.get("model")).toBe("ink-whisper");
    expect(form.get("language")).toBe("en");
    expect(form.get("timestamp_granularities[]")).toBe("word");
    const file = form.get("file") as Blob;
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(1.5);
    expect(result.requestId).toBe("stt-1");
    expect(result.words).toEqual([
      { text: "hello", start: 0, end: 0.5 },
      { text: "world", start: 0.5, end: 1 },
    ]);
  });
});

describe("fetchDashboardStats", () => {
  it("reports credit consumption for an API key without inventing a quota", async () => {
    installFetch((url) => {
      if (url.startsWith("https://api.cartesia.ai/api-keys")) {
        return jsonResponse({
          data: [{ id: "key-1", description: "prod", creator_email: "a@b.co" }],
          has_more: false,
          next_page: null,
        });
      }
      if (url.includes("api_key_id=key-1")) {
        return jsonResponse({ data: [{ credits: 1200 }, { credits: 300 }] });
      }
      return jsonResponse({ data: [{ credits: 5000 }] });
    });

    const stats = await client({ adminApiKey: "sk_car_admin_test" }).fetchDashboardStats(
      "api-key",
      `${ACCOUNT}:api-key:key-1`,
      ACCOUNT,
    );

    expect(stats[0]).toEqual({ label: "Credits (30 d)", value: (1500).toLocaleString() });
    expect(stats[1]).toEqual({ label: "Org credits (30 d)", value: (5000).toLocaleString() });
    const usage = calls.filter((call) => call.url.includes("/usage/credits"));
    expect(usage).toHaveLength(2);
    expect(usage[0]!.url).toMatch(/start_ts=.*&end_ts=.*&api_key_id=key-1/);
  });
});
