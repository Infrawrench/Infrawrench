import type { HttpHostServices } from "@infrawrench/plugin-base";
import { hostClient } from "@infrawrench/plugin-base/effect";
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
  return hostClient(new MistralClient({ apiKey: "test-key", adminApiKey }));
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
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/files?page_size=100&page=0");
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

/** A page of `count` rows under `key`, each with a fresh id. */
function fullPage(key: string, count: number, idKey = "id"): Record<string, unknown> {
  return {
    [key]: Array.from({ length: count }, (_, i) => ({ [idKey]: `row-${calls.length}-${i}` })),
    next_page_token: `t${calls.length}`,
  };
}

/** Each inventory list: the most requests it may take, and what a full page holds. */
const CAPPED_LISTS = [
  { type: "mistral-file", key: "data", pageSize: 100, maxPages: 500 },
  { type: "mistral-voice", key: "items", pageSize: 100, maxPages: 100 },
  { type: "mistral-fine-tuning-job", key: "data", pageSize: 100, maxPages: 100 },
  { type: "mistral-api-key", key: "keys", pageSize: 100, maxPages: 100, idKey: "key_id" },
  { type: "mistral-agent", key: "data", pageSize: 1000, maxPages: 50 },
  { type: "mistral-library", key: "data", pageSize: 100, maxPages: 100 },
];

describe("incomplete lists", () => {
  it.each(CAPPED_LISTS)(
    "$type throws rather than return part of a list that never ends",
    async ({ type, key, pageSize, maxPages, idKey }) => {
      installFetch(() => jsonResponse(fullPage(key, pageSize, idKey)));
      await expect(client("admin-key").listResources(type, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(maxPages);
    },
  );

  it.each(CAPPED_LISTS)(
    "$type throws on a first page whose key was renamed",
    async ({ type, key }) => {
      installFetch(() => jsonResponse({ [`${key}_renamed`]: [] }));
      await expect(client("admin-key").listResources(type, ACCOUNT)).rejects.toThrow(
        "is not a list",
      );
      expect(calls).toHaveLength(1);
    },
  );

  it.each(CAPPED_LISTS)(
    "$type throws on a later page whose key was renamed",
    async ({ type, key, pageSize, idKey }) => {
      installFetch(() =>
        calls.length === 1
          ? jsonResponse(fullPage(key, pageSize, idKey))
          : jsonResponse({ [`${key}_renamed`]: [] }),
      );
      await expect(client("admin-key").listResources(type, ACCOUNT)).rejects.toThrow(
        "is not a list",
      );
      expect(calls).toHaveLength(2);
    },
  );

  it("throws on a model catalogue with no list, which would prune every model", async () => {
    installFetch(() => jsonResponse({ detail: "something else" }));
    await expect(client().listResources("mistral-model", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("still reads a bare array of API keys", async () => {
    installFetch(() => jsonResponse([{ key_id: "k1", name: "ci" }]));
    const keys = await client("admin-key").listResources("mistral-api-key", ACCOUNT);
    expect(keys.map((k) => k.externalId)).toEqual(["k1"]);
  });

  it("keeps batch jobs as a rolling window of the newest, asking for that order", async () => {
    installFetch(() => jsonResponse(fullPage("data", 100)));
    const jobs = await client().listResources("mistral-batch-job", ACCOUNT);
    expect(calls).toHaveLength(100);
    expect(jobs).toHaveLength(10_000);
    expect(calls[0]?.url).toBe(
      "https://api.mistral.ai/v1/batch/jobs?order_by=-created&page_size=100&page=0",
    );
    expect(calls[1]?.url).toContain("page=1");
  });

  it("reads a batch answer with no data as empty, which the document allows", async () => {
    installFetch(() => jsonResponse({ total: 0 }));
    expect(await client().listResources("mistral-batch-job", ACCOUNT)).toEqual([]);
  });

  it("still fails a batch page whose data is not a list", async () => {
    installFetch(() => jsonResponse({ data: "nope", total: 1 }));
    await expect(client().listResources("mistral-batch-job", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("follows a cursor past an empty page, since only a null token ends the list", async () => {
    installFetch((url) =>
      url.includes("page_token=t2")
        ? jsonResponse({ data: [{ id: "lib_2", name: "Second" }], next_page_token: null })
        : jsonResponse({ data: [], next_page_token: "t2" }),
    );
    const libraries = await client().listResources("mistral-library", ACCOUNT);
    expect(libraries.map((l) => l.externalId)).toEqual(["lib_2"]);
  });

  it("pages voices by offset and stops at the reported total", async () => {
    installFetch(() =>
      jsonResponse({ items: Array.from({ length: 100 }, (_, i) => ({ id: `v${i}` })), total: 100 }),
    );
    await client().listResources("mistral-voice", ACCOUNT);
    expect(calls).toHaveLength(1);
  });

  it("advances the voice offset by what the page held", async () => {
    installFetch(() =>
      calls.length === 1
        ? jsonResponse({ ...fullPage("items", 100), total: 150 })
        : jsonResponse({ items: [{ id: "last" }], total: 150 }),
    );
    await client().listResources("mistral-voice", ACCOUNT);
    expect(calls[1]?.url).toBe(
      "https://api.mistral.ai/v1/audio/voices?limit=100&offset=100&type=all",
    );
  });

  it("offers what it read of a long file list in the create form", async () => {
    installFetch((url) =>
      url.includes("/models")
        ? jsonResponse({ data: [] })
        : jsonResponse({
            data: Array.from({ length: 100 }, (_, i) => ({
              id: `f-${calls.length}-${i}`,
              purpose: "batch",
            })),
          }),
    );
    const config = await client().getCreateConfig("mistral-batch-job");
    const input = config.fields.find((field) => field.key === "inputFile");
    expect(input?.options).toHaveLength(50_000);
  });

  it("fills the speech pickers from what it read of a long voice list", async () => {
    installFetch((url) =>
      url.includes("/models")
        ? jsonResponse({ data: [{ id: "voxtral-mini-latest" }] })
        : jsonResponse(fullPage("items", 100)),
    );
    const model = await client().getResource(
      "mistral-model",
      `${ACCOUNT}:mistral-model:voxtral-mini-latest`,
      ACCOUNT,
    );
    expect(JSON.parse(String(model.resolvedOutputs["__voices__"]))).toHaveLength(10_000);
  });
});

describe("fine-tuning jobs, a route the document no longer lists", () => {
  it.each([404, 410])("reads a %i on the first page as a retired API", async (status) => {
    installFetch(() => jsonResponse({ detail: "Not Found" }, status));
    expect(await client().listResources("mistral-fine-tuning-job", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("still lists jobs while the route answers", async () => {
    installFetch(() => jsonResponse({ data: [{ id: "ft-1", status: "SUCCESS" }] }));
    const jobs = await client().listResources("mistral-fine-tuning-job", ACCOUNT);
    expect(jobs.map((j) => j.externalId)).toEqual(["ft-1"]);
  });

  it("fails on any other error, so a bad day does not prune every job", async () => {
    installFetch(() => jsonResponse({ detail: "API error 404 upstream" }, 500));
    await expect(client().listResources("mistral-fine-tuning-job", ACCOUNT)).rejects.toThrow(
      "API error 500",
    );
  });

  it("fails on a 404 part way through, which is not a retired API", async () => {
    installFetch(() =>
      calls.length === 1
        ? jsonResponse(fullPage("data", 100))
        : jsonResponse({ detail: "Not Found" }, 404),
    );
    await expect(client().listResources("mistral-fine-tuning-job", ACCOUNT)).rejects.toThrow(
      "API error 404",
    );
  });
});

/** Normalized AI tags `fetchCostData` stamps on every row (plugin-base `withAiCostTags`). */
const MISTRAL_TAGS = { "ai:provider": "mistral" };

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
      { date: "2026-07-01", service: "chat", currency: "USD", amount: 12.5, tags: MISTRAL_TAGS },
      { date: "2026-07-01", service: "audio", currency: "USD", amount: 3.25, tags: MISTRAL_TAGS },
      {
        date: "2026-07-01",
        service: "fine_tuning",
        currency: "USD",
        amount: 2,
        tags: MISTRAL_TAGS,
      },
    ]);
  });
});

describe("period-native cost dating", () => {
  it("keeps an in-progress month on one key as it is re-collected day after day", async () => {
    // `/admin/usage` returns the *running* total of the month, so the same
    // month is fetched again every day. Dating those re-fetches to anything
    // that moves (the month end clamped into the requested range, as this
    // collector once did) files month-to-date-through-15 on the 15th and
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
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 12.5, tags: MISTRAL_TAGS }],
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 40, tags: MISTRAL_TAGS }],
      [{ date: "2026-08-01", service: "chat", currency: "USD", amount: 61, tags: MISTRAL_TAGS }],
    ]);
    // One row, one date, every time: the last collection replaces the previous
    // one instead of adding a fourth day's worth of the same money.
    expect(new Set(collected.flat().map((r) => r.date))).toEqual(new Set(["2026-08-01"]));
  });

  it("reports a month only from the chunk that contains its first day", async () => {
    // Month-aligned chunks mean the oldest chunk of a backfill can start
    // mid-month. That month belongs to no chunk in this pass (claiming it here
    // would land the same month on two dates) so nothing is fetched at all.
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
    // month and no others, so for the rest of the month the running total
    // (which Mistral restates continuously) would never be re-collected at all.
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
      { date: "2026-07-01", service: "chat", currency: "USD", amount: 10, tags: MISTRAL_TAGS },
      { date: "2026-08-01", service: "chat", currency: "USD", amount: 20, tags: MISTRAL_TAGS },
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

  it("reads speaker_id and prompt_audio_seconds, as the document names them", async () => {
    installFetch(() =>
      jsonResponse({
        text: "bonjour tout le monde",
        model: "voxtral-mini-latest",
        language: "fr",
        usage: { prompt_audio_seconds: 4.2, prompt_tokens: 4, total_tokens: 9 },
        segments: [
          { text: "bonjour", start: 0, end: 1, speaker_id: "speaker_1" },
          { text: "tout le monde", start: 1, end: 4.2, speaker_id: "speaker_2" },
          { text: "merci", start: 4.2, end: 5, speaker_id: null },
        ],
      }),
    );

    const result = await client().transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/webm",
    });

    expect(result.durationSeconds).toBe(4.2);
    expect(result.summary).toContain("4.2 s of audio");
    expect(result.summary).toContain("2 speakers");
    expect(result.words?.map((w) => w.speaker)).toEqual(["speaker_1", "speaker_2", undefined]);
  });

  it("numbers a speaker id that is only a number", async () => {
    installFetch(() =>
      jsonResponse({
        text: "oui",
        model: "voxtral-mini-latest",
        usage: {},
        segments: [{ text: "oui", start: 0, end: 1, speaker_id: "3" }],
      }),
    );
    const result = await client().transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/webm",
    });
    expect(result.words?.[0]?.speaker).toBe("Speaker 3");
  });

  it("uploads through the host's HTTP service, so a bastion carries it", async () => {
    const fetchStub = installFetch(() => {
      throw new Error("the host's service should have carried this");
    });
    const request = vi.fn(async (_req: Parameters<HttpHostServices["request"]>[0]) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ text: "bonjour", model: "voxtral-mini-latest", usage: {} }),
    }));

    const result = await hostClient(
      new MistralClient({ apiKey: "test-key" }, { http: { request } }),
    ).transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("fake-opus").toString("base64"),
      mimeType: "audio/webm",
    });

    expect(result.text).toBe("bonjour");
    expect(fetchStub).not.toHaveBeenCalled();
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(sent?.method).toBe("POST");
    expect(sent).not.toHaveProperty("caCert");
    expect(sent?.headers["authorization"]).toBe("Bearer test-key");
    expect(sent?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(Buffer.from(sent?.body ?? "").toString()).toContain("fake-opus");
  });

  it("hands a custom CA to the host for the upload", async () => {
    installFetch(() => {
      throw new Error("the host's service should have carried this");
    });
    const request = vi.fn(async (_req: Parameters<HttpHostServices["request"]>[0]) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ text: "", model: "voxtral-mini-latest", usage: {} }),
    }));
    await hostClient(
      new MistralClient({ apiKey: "test-key", caCert: "PEM" }, { http: { request } }),
    ).transcribeAudio("mistral-voice", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/webm",
    });
    expect(request.mock.calls[0]?.[0].caCert).toBe("PEM");
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

describe("agents", () => {
  it("pages GET /v1/agents/pages by cursor and maps tools, libraries and versions", async () => {
    installFetch((url) => {
      if (url.includes("page_token=t2")) {
        return jsonResponse({
          data: [{ id: "ag_2", name: "Second", model: "mistral-small-latest" }],
        });
      }
      return jsonResponse({
        data: [
          {
            id: "ag_1",
            name: "Support",
            model: "mistral-medium-latest",
            instructions: "Be terse.",
            tools: [
              { type: "web_search" },
              { type: "function", function: { name: "lookup_order" } },
              { type: "document_library", library_ids: ["lib_a", "lib_b"] },
            ],
            completion_args: { temperature: 0.3 },
            version: 3,
            versions: [1, 2, 3],
            deployment_chat: true,
          },
        ],
        next_page_token: "t2",
      });
    });

    const rows = await client().listResources("mistral-agent", ACCOUNT);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.mistral.ai/v1/agents/pages?page_size=1000",
      "https://api.mistral.ai/v1/agents/pages?page_size=1000&page_token=t2",
    ]);
    expect(rows.map((r) => r.externalId)).toEqual(["ag_1", "ag_2"]);
    expect(rows[0]?.fields).toMatchObject({
      tools: "web_search, function:lookup_order, document_library",
      libraries: "lib_a, lib_b",
      version: 3,
      versionCount: 3,
      deploymentChat: true,
    });
    const detail = client().renderDetail(rows[0]!);
    expect(detail.sections.map((s) => s.title)).toEqual([
      "Agent",
      "Instructions",
      "Completion Arguments",
    ]);
  });

  it("creates with a picked model, edits with PATCH and deletes", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/models")) {
        return jsonResponse({
          data: [
            { id: "mistral-medium-latest", capabilities: { completion_chat: true } },
            { id: "mistral-embed", capabilities: { completion_chat: false } },
            { id: "old-model", archived: true },
          ],
        });
      }
      if (init?.method === "DELETE") return jsonResponse({});
      return jsonResponse({
        id: "ag_new",
        name: "Bot",
        model: "mistral-medium-latest",
        version: 1,
      });
    });
    const c = client();
    const config = await c.getCreateConfig("mistral-agent");
    expect(config.fields.find((f) => f.key === "model")?.options?.map((o) => o.id)).toEqual([
      "mistral-medium-latest",
    ]);

    calls = [];
    const created = await c.createResource("mistral-agent", ACCOUNT, {
      name: "Bot",
      model: "mistral-medium-latest",
      instructions: "Hi",
    });
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/agents");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Bot",
      model: "mistral-medium-latest",
      instructions: "Hi",
    });
    expect(created.id).toBe(`${ACCOUNT}:mistral-agent:ag_new`);

    await c.updateResource("mistral-agent", created.id, ACCOUNT, { description: "New" });
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(calls[1]?.url).toBe("https://api.mistral.ai/v1/agents/ag_new");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ description: "New" });

    await c.deleteResource("mistral-agent", created.id, ACCOUNT);
    expect(calls[2]?.init?.method).toBe("DELETE");
  });
});

describe("libraries", () => {
  it("lists by page_token, creates, renames and deletes", async () => {
    installFetch((url, init) => {
      if (init?.method === "POST" || init?.method === "PATCH" || init?.method === "DELETE") {
        return jsonResponse({ id: "lib_1", name: "Runbooks", nb_documents: 0, total_size: 0 });
      }
      return jsonResponse({
        data: [
          {
            id: "lib_1",
            name: "Runbooks",
            nb_documents: 4,
            total_size: 2048,
            owner_type: "Workspace",
          },
        ],
        next_page_token: null,
      });
    });
    const c = client();
    const [library] = await c.listResources("mistral-library", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/libraries?page_size=100");
    expect(library?.fields).toMatchObject({
      documents: 4,
      totalSize: 2048,
      ownerType: "Workspace",
    });

    await c.createResource("mistral-library", ACCOUNT, { name: "Runbooks", description: "Ops" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      name: "Runbooks",
      description: "Ops",
    });

    await c.updateResource("mistral-library", library!.id, ACCOUNT, { name: "Ops runbooks" });
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(calls[2]?.url).toBe("https://api.mistral.ai/v1/libraries/lib_1");

    await c.deleteResource("mistral-library", library!.id, ACCOUNT);
    expect(calls[3]?.init?.method).toBe("DELETE");
  });
});

describe("batch job creation", () => {
  it("offers only batch-purpose files and posts a single input file", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "mistral-small-latest" }] });
      if (url.includes("/files?")) {
        return jsonResponse({
          data: [
            { id: "f-batch", filename: "requests.jsonl", purpose: "batch" },
            { id: "f-ft", filename: "train.jsonl", purpose: "fine-tune" },
          ],
        });
      }
      if (init?.method === "POST") {
        return jsonResponse({ id: "job-1", status: "QUEUED", endpoint: "/v1/chat/completions" });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const c = client();
    const config = await c.getCreateConfig("mistral-batch-job");
    expect(config.fields.find((f) => f.key === "inputFile")?.options?.map((o) => o.id)).toEqual([
      "f-batch",
    ]);

    calls = [];
    const job = await c.createResource("mistral-batch-job", ACCOUNT, {
      inputFile: "f-batch",
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      timeoutHours: "12",
    });
    expect(calls[0]?.url).toBe("https://api.mistral.ai/v1/batch/jobs");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      input_files: ["f-batch"],
      endpoint: "/v1/chat/completions",
      model: "mistral-small-latest",
      timeout_hours: 12,
    });
    expect(job.id).toBe(`${ACCOUNT}:mistral-batch-job:job-1`);
  });
});

describe("fine-tuned model actions", () => {
  const base = {
    pluginId: "mistral",
    resourceTypeId: "mistral-model",
    accountId: ACCOUNT,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };

  it("offers archive and delete only on fine-tuned models", () => {
    const labels = (fields: Record<string, string | boolean>, id: string) =>
      client()
        .renderDetail({
          ...base,
          id: `${ACCOUNT}:mistral-model:${id}`,
          displayName: id,
          externalId: id,
          fields,
        })
        .headerActions?.map((a) => a.label);
    expect(
      labels({ modelId: "mistral-large-latest", type: "base" }, "mistral-large-latest"),
    ).toEqual(["Refresh"]);
    expect(labels({ modelId: "ft:a:b", type: "fine-tuned" }, "ft:a:b")).toEqual([
      "Refresh",
      "Archive",
      "Delete model",
    ]);
    expect(labels({ modelId: "ft:a:b", type: "fine-tuned", archived: true }, "ft:a:b")).toContain(
      "Unarchive",
    );
  });

  it("archives, unarchives and deletes through the documented routes", async () => {
    installFetch((_url, init) =>
      init?.method === "DELETE" && _url.includes("/models/ft")
        ? jsonResponse({ id: "ft:a:b", deleted: true })
        : jsonResponse({ id: "ft:a:b", archived: true }),
    );
    const c = client();
    const id = `${ACCOUNT}:mistral-model:ft:a:b`;
    await c.invokeAction("mistral-model", id, "archive", ACCOUNT);
    await c.invokeAction("mistral-model", id, "unarchive", ACCOUNT);
    await c.invokeAction("mistral-model", id, "delete-model", ACCOUNT);
    expect(calls.map((x) => [x.init?.method, x.url])).toEqual([
      ["POST", "https://api.mistral.ai/v1/fine_tuning/models/ft%3Aa%3Ab/archive"],
      ["DELETE", "https://api.mistral.ai/v1/fine_tuning/models/ft%3Aa%3Ab/archive"],
      ["DELETE", "https://api.mistral.ai/v1/models/ft%3Aa%3Ab"],
    ]);
  });
});
