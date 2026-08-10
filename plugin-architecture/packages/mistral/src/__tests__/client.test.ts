import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MistralClient } from "../client.js";
import { plugin } from "../plugin.js";

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
    // Dated to the period *start*, the one day of the month that does not move.
    expect(rows).toEqual([
      { date: "2026-07-01", service: "chat", currency: "USD", amount: 12.5 },
      { date: "2026-07-01", service: "audio", currency: "USD", amount: 3.25 },
      { date: "2026-07-01", service: "fine_tuning", currency: "USD", amount: 2 },
    ]);
  });
});

describe("period-native cost dating", () => {
  it("keeps an in-progress month on one key as it is re-collected day after day", async () => {
    // `/admin/usage` returns the *running* total of the month, so the same
    // month is fetched again every day. Dating those re-fetches to anything
    // that moves — the month end clamped into the requested range, as this
    // collector once did — files month-to-date-through-15 on the 15th and
    // month-to-date-through-16 on the 16th. Nothing rewrites the earlier days,
    // so the month sums to the sum of its own prefixes: 12.5 + 40 + 61 here
    // instead of 61. One stable key is what makes the host's
    // ReplacingMergeTree *replace* rather than accumulate.
    const monthToDate = [12.5, 40, 61];
    const collected = [];
    for (const [i, total] of monthToDate.entries()) {
      calls = [];
      installFetch(() => jsonResponse({ currency: "USD", chat: { cost: total } }));
      collected.push(
        await client("admin-key").fetchCostData(ACCOUNT, {
          // The host's month-aligned chunk for the in-progress month, on three
          // successive collection days.
          fromDate: "2026-08-01",
          toDate: `2026-08-${15 + i}`,
        }),
      );
      vi.restoreAllMocks();
    }

    expect(collected).toEqual([
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 12.5 }],
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 40 }],
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 61 }],
    ]);
    // One row, one date, every time: the last collection replaces the previous
    // one instead of adding a fourth day's worth of the same money.
    expect(new Set(collected.flat().map((r) => r.date))).toEqual(new Set(["2026-08-01"]));
  });

  it("reports a month only from the chunk that contains its first day", async () => {
    // Month-aligned chunks mean the oldest chunk of a backfill can start
    // mid-month. That month belongs to no chunk in this pass — claiming it here
    // would land the same month on two dates — so nothing is fetched at all.
    installFetch(() => jsonResponse({ currency: "USD", chat: { cost: 99 } }));

    const rows = await client("admin-key").fetchCostData(ACCOUNT, {
      fromDate: "2026-06-10",
      toDate: "2026-06-30",
    });

    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("declares a restatement window that always reaches a period start", async () => {
    // The dating fix has a manifest half: rows only exist for a month whose 1st
    // the chunk contains, and the host asks for `[today − restatementDays,
    // today]`. The default of 3 days contains the 1st on three days of the
    // month and no others, so for the rest of the month the running total —
    // which Mistral restates continuously — would never be re-collected at all.
    const { restatementDays } = plugin.manifest.costs!;
    expect(restatementDays).toBe(62);

    // Checked rather than argued: from *every* day of a leap year, the window
    // reaches back past the 1st of the previous month, so the in-progress month
    // and the one before it are both re-collected whatever today's date is.
    for (let day = new Date(Date.UTC(2028, 0, 1)); day.getUTCFullYear() === 2028;) {
      const start = new Date(day.valueOf() - restatementDays! * 86_400_000);
      const previousMonthStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1);
      expect(start.valueOf()).toBeLessThanOrEqual(previousMonthStart);
      day = new Date(day.valueOf() + 86_400_000);
    }
  });

  it("fetches each month once when a chunk spans several period starts", async () => {
    installFetch((url) =>
      jsonResponse({ currency: "USD", chat: { cost: url.includes("month=7") ? 10 : 20 } }),
    );

    const rows = await client("admin-key").fetchCostData(ACCOUNT, {
      fromDate: "2026-06-15",
      toDate: "2026-08-10",
    });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.mistral.ai/v1/admin/usage?year=2026&month=7",
      "https://api.mistral.ai/v1/admin/usage?year=2026&month=8",
    ]);
    expect(rows).toEqual([
      { date: "2026-07-01", service: "chat", currency: "USD", amount: 10 },
      { date: "2026-08-01", service: "chat", currency: "USD", amount: 20 },
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
