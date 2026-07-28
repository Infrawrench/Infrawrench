import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MistralClient } from "../client.js";

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
    headers: new Headers(),
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

function client(adminApiKey = "") {
  return new MistralClient({ apiKey: "test-key", adminApiKey });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pagination", () => {
  it("uses no page params for /models", async () => {
    installFetch(() => jsonResponse({ data: [{ id: "mistral-large-latest" }] }));
    await client().listResources("mistral-model", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/models");
  });

  it("uses limit/offset for voices and page/page_size for files", async () => {
    installFetch((url) =>
      url.includes("/audio/voices")
        ? jsonResponse({ items: [], total: 0 })
        : jsonResponse({ data: [] }),
    );

    await client().listResources("mistral-voice", ACCOUNT);
    expect(calls[0]?.url).toBe(
      "https://api.mistral.ai/v1/audio/voices?limit=100&offset=0&type=all",
    );

    calls = [];
    await client().listResources("mistral-file", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/files?page=0&page_size=100");
  });

  it("uses limit/offset on the admin plane, with its own base and header", async () => {
    installFetch(() => jsonResponse({ keys: [{ key_id: "k1", name: "ci" }] }));
    const keys = await client("admin-key").listResources("mistral-api-key", ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/admin/api-keys?limit=100&offset=0");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("admin-key");
    expect(keys[0]?.fields["name"]).toBe("ci");
  });
});

describe("admin degradation", () => {
  it("returns no api keys instead of failing when there is no admin key", async () => {
    installFetch(() => jsonResponse({}));
    const keys = await client().listResources("mistral-api-key", ACCOUNT);
    expect(keys).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("blocks cost collection with an actionable message", async () => {
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-31" }),
    ).rejects.toThrow(/Enterprise plans/);
  });

  it("maps the monthly usage breakdown into per-service rows", async () => {
    installFetch(() =>
      jsonResponse({
        currency: "USD",
        chat: { cost: 12.5 },
        ocr: { cost: 0 },
        audio: 3.25,
        fine_tuning: { total_cost: 2 },
      }),
    );

    const rows = await client("admin-key").fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });

    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/admin/usage?year=2026&month=7");
    expect(rows).toEqual([
      { date: "2026-07-31", service: "chat", currency: "USD", amount: 12.5 },
      { date: "2026-07-31", service: "audio", currency: "USD", amount: 3.25 },
      { date: "2026-07-31", service: "fine_tuning", currency: "USD", amount: 2 },
    ]);
  });
});

describe("getResource", () => {
  it("stashes the voice and audio-model lists for the synchronous renderer", async () => {
    installFetch((url) => {
      if (url.includes("/audio/voices")) {
        return jsonResponse({
          items: [{ id: "amelie", name: "Amélie", gender: "female", languages: ["fr"] }],
          total: 1,
        });
      }
      return jsonResponse({
        data: [
          { id: "voxtral-mini-transcribe-2602" },
          { id: "voxtral-mini-tts-2603" },
          { id: "mistral-large-latest" },
        ],
      });
    });

    const voice = await client().getResource(
      "mistral-voice",
      `${ACCOUNT}:mistral-voice:amelie`,
      ACCOUNT,
    );

    expect(JSON.parse(voice.resolvedOutputs["__audioModels__"] ?? "{}")).toEqual({
      stt: ["voxtral-mini-transcribe-2602"],
      tts: ["voxtral-mini-tts-2603"],
    });
    expect(JSON.parse(voice.resolvedOutputs["__voices__"] ?? "[]")[0].name).toBe("Amélie");
  });
});

describe("mutations", () => {
  it("patches voice metadata", async () => {
    installFetch(() => jsonResponse({ id: "mine", name: "Renamed", languages: ["fr"] }));
    await client().updateResource("mistral-voice", `${ACCOUNT}:mistral-voice:mine`, ACCOUNT, {
      name: "Renamed",
      languages: "fr, en",
    });

    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/audio/voices/mine");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Renamed",
      languages: ["fr", "en"],
    });
  });

  it("cancels a batch job", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction(
      "mistral-batch-job",
      `${ACCOUNT}:mistral-batch-job:b1`,
      "cancel",
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/batch/jobs/b1/cancel");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("revokes an api key on the admin plane", async () => {
    installFetch(() => jsonResponse({}, 204));
    await client("admin-key").deleteResource(
      "mistral-api-key",
      `${ACCOUNT}:mistral-api-key:k1`,
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/admin/api-keys/k1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("synthesizeSpeech", () => {
  it("posts JSON and passes through the base64 audio_data", async () => {
    const audio = Buffer.from("fake-mp3").toString("base64");
    installFetch(() => jsonResponse({ audio_data: audio, model: "voxtral-mini-tts-2603" }));

    const result = await client().synthesizeSpeech(
      "mistral-voice",
      `${ACCOUNT}:mistral-voice:amelie`,
      ACCOUNT,
      { text: "bonjour", voiceId: "amelie", modelId: "voxtral-mini-tts-2603" },
    );

    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/audio/speech");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "voxtral-mini-tts-2603",
      input: "bonjour",
      voice_id: "amelie",
      response_format: "mp3",
      stream: false,
    });
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64").toString()).toBe("fake-mp3");
    expect(result.characters).toBe(7);
  });

  it("falls back to the voice the tab was opened from", async () => {
    installFetch(() => jsonResponse({ audio_data: Buffer.from("x").toString("base64") }));
    await client().synthesizeSpeech("mistral-voice", `${ACCOUNT}:mistral-voice:hugo`, ACCOUNT, {
      text: "salut",
    });
    expect(JSON.parse(String(calls[0]?.init?.body)).voice_id).toBe("hugo");
  });

  it("fails loudly when the response carries no audio_data", async () => {
    installFetch(() => jsonResponse({ model: "voxtral-mini-tts-2603" }));
    await expect(
      client().synthesizeSpeech("mistral-voice", `${ACCOUNT}:mistral-voice:hugo`, ACCOUNT, {
        text: "salut",
      }),
    ).rejects.toThrow(/no audio_data/);
  });
});

describe("transcribeAudio", () => {
  it("uploads multipart with diarisation on and labels speakers", async () => {
    installFetch(() =>
      jsonResponse({
        text: "bonjour tout le monde",
        model: "voxtral-mini-latest",
        language: "fr",
        usage: { audio_seconds: 4.2 },
        segments: [
          { text: "bonjour", start: 0, end: 1, speaker: 0 },
          { text: "tout le monde", start: 1, end: 4.2, speaker: 1 },
        ],
      }),
    );

    const result = await client().transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("fake-opus").toString("base64"),
      mimeType: "audio/webm;codecs=opus",
      language: "fr",
    });

    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe("voxtral-mini-latest");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("language")).toBe("fr");

    const uploaded = form.get("file") as Blob & { name?: string };
    expect(uploaded.type).toBe("audio/webm;codecs=opus");
    expect(uploaded.name).toBe("clip.webm");
    expect(Buffer.from(await uploaded.arrayBuffer()).toString()).toBe("fake-opus");

    expect(result.text).toBe("bonjour tout le monde");
    expect(result.durationSeconds).toBe(4.2);
    expect(result.words?.map((w) => w.speaker)).toEqual(["Speaker 0", "Speaker 1"]);
    expect(result.summary).toContain("2 speakers");
  });

  it("falls back to a transcription model when the shared picker holds a TTS model", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    await client().transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
      modelId: "voxtral-mini-tts-2603",
    });
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe("voxtral-mini-latest");
    expect((form.get("file") as Blob & { name?: string }).name).toBe("clip.mp4");
  });
});
