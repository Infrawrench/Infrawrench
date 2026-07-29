import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsClient } from "../client.js";

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
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
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

function client() {
  return new ElevenLabsClient({ apiKey: "sk_test_key" });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("rejects a missing API key", () => {
    expect(() => new ElevenLabsClient({})).toThrow(/missing apiKey/);
  });
});

describe("listResources", () => {
  it("pages through GET /v2/voices with xi-api-key", async () => {
    installFetch((url) => {
      if (url.includes("/v2/voices") && !url.includes("next_page_token")) {
        return jsonResponse({
          voices: [
            {
              voice_id: "v1",
              name: "Rachel",
              category: "premade",
              preview_url: "https://example.test/rachel.mp3",
              labels: { accent: "american", gender: "female" },
            },
          ],
          has_more: true,
          next_page_token: "tok-2",
        });
      }
      if (url.includes("next_page_token=tok-2")) {
        return jsonResponse({
          voices: [{ voice_id: "v2", name: "Domi", category: "cloned" }],
          has_more: false,
          next_page_token: null,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const voices = await client().listResources("voice", ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v2/voices?page_size=100");
    expect(headerOf(calls[0]?.init, "xi-api-key")).toBe("sk_test_key");
    expect(calls[1]?.url).toContain("next_page_token=tok-2");
    expect(voices).toHaveLength(2);
    expect(voices[0]?.id).toBe(`${ACCOUNT}:voice:v1`);
    expect(voices[0]?.fields["labels"]).toBe("Accent: american · Gender: female");
    expect(voices[0]?.resolvedOutputs["previewUrl"]).toBe("https://example.test/rachel.mp3");
  });

  it("handles the bare array GET /v1/models returns", async () => {
    installFetch(() =>
      jsonResponse([
        {
          model_id: "eleven_multilingual_v2",
          name: "Eleven Multilingual v2",
          can_do_text_to_speech: true,
          maximum_text_length_per_request: 10000,
          languages: [{ language_id: "en", name: "English" }],
        },
      ]),
    );

    const models = await client().listResources("model", ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/models");
    expect(models[0]?.fields["maxCharacters"]).toBe(10000);
    expect(models[0]?.resolvedOutputs["modelId"]).toBe("eleven_multilingual_v2");
  });

  it("pages history with start_after_history_item_id", async () => {
    installFetch((url) => {
      if (!url.includes("start_after")) {
        return jsonResponse({
          history: [
            {
              history_item_id: "h1",
              voice_id: "v1",
              voice_name: "Rachel",
              text: "hello world",
              character_count_change_from: 100,
              character_count_change_to: 111,
              date_unix: 1_700_000_000,
            },
          ],
          has_more: true,
          last_history_item_id: "h1",
        });
      }
      return jsonResponse({ history: [], has_more: false, last_history_item_id: null });
    });

    const items = await client().listResources("history-item", ACCOUNT);

    expect(calls[1]?.url).toContain("start_after_history_item_id=h1");
    expect(items[0]?.fields["characterCount"]).toBe(11);
    expect(items[0]?.resolvedOutputs["audioUrl"]).toBe("/v1/history/h1/audio");
  });

  it("reads pronunciation dictionaries from the pronunciation_dictionaries envelope", async () => {
    installFetch(() =>
      jsonResponse({
        pronunciation_dictionaries: [
          {
            id: "pd1",
            name: "Brand names",
            latest_version_id: "ver1",
            latest_version_rules_num: 7,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const dictionaries = await client().listResources("pronunciation-dictionary", ACCOUNT);

    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/pronunciation-dictionaries?page_size=100",
    );
    expect(dictionaries[0]?.fields["ruleCount"]).toBe(7);
    expect(dictionaries[0]?.resolvedOutputs["latestVersionId"]).toBe("ver1");
  });

  it("rejects an unknown resource type", async () => {
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("getResource", () => {
  it("stashes the voice, model and quota lists for the synchronous detail view", async () => {
    installFetch((url) => {
      if (url.includes("/v2/voices")) {
        return jsonResponse({
          voices: [
            { voice_id: "v1", name: "Rachel", category: "premade" },
            { voice_id: "v2", name: "Domi", category: "cloned" },
          ],
          has_more: false,
        });
      }
      if (url.endsWith("/v1/models")) {
        return jsonResponse([
          {
            model_id: "eleven_multilingual_v2",
            name: "Eleven Multilingual v2",
            can_do_text_to_speech: true,
            maximum_text_length_per_request: 10000,
          },
          {
            model_id: "eleven_english_sts_v2",
            name: "Eleven English STS v2",
            can_do_text_to_speech: false,
          },
        ]);
      }
      if (url.endsWith("/v1/user/subscription")) {
        return jsonResponse({
          tier: "creator",
          character_count: 25000,
          character_limit: 100000,
          next_character_count_reset_unix: 1_800_000_000,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource("voice", `${ACCOUNT}:voice:v1`, ACCOUNT);

    const stashedVoices = JSON.parse(resource.resolvedOutputs["__voices__"] ?? "[]") as Array<{
      id: string;
    }>;
    const stashedModels = JSON.parse(resource.resolvedOutputs["__models__"] ?? "[]") as Array<{
      id: string;
      maxCharacters: number;
    }>;
    const quota = JSON.parse(resource.resolvedOutputs["__subscription__"] ?? "{}") as {
      used: number;
      limit: number;
    };

    expect(stashedVoices.map((v) => v.id)).toEqual(["v1", "v2"]);
    // Conversion-only models are filtered out of the TTS picker.
    expect(stashedModels).toEqual([
      expect.objectContaining({ id: "eleven_multilingual_v2", maxCharacters: 10000 }),
    ]);
    expect(quota).toEqual({
      used: 25000,
      limit: 100000,
      resetUnix: 1_800_000_000,
      tier: "creator",
    });
  });

  it("throws when the voice is not in the workspace", async () => {
    installFetch((url) => {
      if (url.includes("/v2/voices")) return jsonResponse({ voices: [], has_more: false });
      if (url.endsWith("/v1/models")) return jsonResponse([]);
      return jsonResponse({});
    });
    await expect(
      client().getResource("voice", `${ACCOUNT}:voice:missing`, ACCOUNT),
    ).rejects.toThrow(/voice missing not found/);
  });
});

describe("deleteResource", () => {
  it("deletes a voice", async () => {
    installFetch(() => jsonResponse({ status: "ok" }));
    await client().deleteResource("voice", `${ACCOUNT}:voice:v1`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/voices/v1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("deletes a history item", async () => {
    installFetch(() => jsonResponse({ status: "ok" }));
    await client().deleteResource("history-item", `${ACCOUNT}:history-item:h1`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/history/h1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("refuses types with no delete endpoint", async () => {
    await expect(
      client().deleteResource("model", `${ACCOUNT}:model:eleven_flash_v2_5`, ACCOUNT),
    ).rejects.toThrow(/not supported/);
  });
});

describe("fetchDashboardStats", () => {
  it("leads with the used-vs-limit gauge", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/user/subscription")) {
        return jsonResponse({
          tier: "creator",
          character_count: 96000,
          character_limit: 100000,
          next_character_count_reset_unix: 1_800_000_000,
          voice_limit: 30,
          voice_slots_used: 4,
        });
      }
      if (url.includes("/v2/voices")) {
        return jsonResponse({
          voices: [{ voice_id: "v1", name: "Rachel", category: "premade" }],
          has_more: false,
        });
      }
      if (url.endsWith("/v1/models")) return jsonResponse([]);
      throw new Error(`unrouted: ${url}`);
    });

    const stats = await client().fetchDashboardStats("voice", `${ACCOUNT}:voice:v1`, ACCOUNT);

    expect(stats[0]).toEqual({
      label: "Characters Used",
      value: "96,000 / 100,000",
      variant: "status-error",
    });
    expect(stats.find((s) => s.label === "Quota Used")?.value).toBe("96%");
    expect(stats.find((s) => s.label === "Voice Slots")?.value).toBe("4 / 30");
  });
});

describe("synthesizeSpeech", () => {
  it("posts to /v1/text-to-speech/{voice_id} with mp3 output and round-trips the audio", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00]);
    installFetch(() => binaryResponse(audio, { "character-cost": "42", "request-id": "req-123" }));

    const result = await client().synthesizeSpeech("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      text: "Hello there",
      voiceId: "v9",
      modelId: "eleven_flash_v2_5",
    });

    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/v9?output_format=mp3_44100_128",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0]?.init, "xi-api-key")).toBe("sk_test_key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "Hello there",
      model_id: "eleven_flash_v2_5",
    });

    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64").equals(Buffer.from(audio))).toBe(true);
    expect(result.characters).toBe(42);
    expect(result.requestId).toBe("req-123");
    expect(result.fileName?.endsWith(".mp3")).toBe(true);
    expect(result.summary).toContain("eleven_flash_v2_5");
  });

  it("falls back to the voice in the resource id when the payload omits one", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1, 2, 3])));
    await client().synthesizeSpeech("voice", `${ACCOUNT}:voice:from-id`, ACCOUNT, {
      text: "hi",
    });
    expect(calls[0]?.url).toContain("/v1/text-to-speech/from-id?");
  });

  it("never sends a Scribe model to the synthesis endpoint", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1])));
    await client().synthesizeSpeech("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      text: "hi",
      modelId: "scribe_v2",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))["model_id"]).toBe("eleven_multilingual_v2");
  });

  it("surfaces the JSON error body returned instead of audio", async () => {
    installFetch(() => jsonResponse({ detail: { status: "quota_exceeded" } }, 401));
    await expect(
      client().synthesizeSpeech("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, { text: "hi" }),
    ).rejects.toThrow(/ElevenLabs API error 401 .*quota_exceeded/);
  });
});

describe("transcribeAudio", () => {
  it("uploads multipart to Scribe and maps the transcript", async () => {
    installFetch(() =>
      jsonResponse({
        language_code: "en",
        language_probability: 0.98,
        text: "Hello there.",
        audio_duration_secs: 1.42,
        transcription_id: "tr-1",
        words: [
          {
            text: "Hello",
            start: 0,
            end: 0.4,
            type: "word",
            speaker_id: "speaker_0",
            logprob: Math.log(0.9),
          },
          { text: " ", start: 0.4, end: 0.45, type: "spacing", logprob: Math.log(0.1) },
          {
            text: "there.",
            start: 0.45,
            end: 0.9,
            type: "word",
            speaker_id: "speaker_0",
            logprob: Math.log(0.7),
          },
        ],
      }),
    );

    const clip = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const result = await client().transcribeAudio("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      audioBase64: clip.toString("base64"),
      mimeType: "audio/webm;codecs=opus",
      modelId: "scribe_v2",
      language: "en",
    });

    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(headerOf(calls[0]?.init, "Content-Type")).toBeUndefined();

    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect(form.get("timestamps_granularity")).toBe("word");

    const file = form.get("file") as File;
    // The browser's MediaRecorder MIME type is forwarded verbatim.
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(file.name).toBe("clip.webm");
    expect(Buffer.from(await file.arrayBuffer()).equals(clip)).toBe(true);

    expect(result.text).toBe("Hello there.");
    expect(result.language).toBe("en");
    // Mean of exp(logprob) over the two *word* tokens — (0.9 + 0.7) / 2. The
    // spacing token's logprob is excluded along with the token itself, and
    // language_probability (0.98) plays no part.
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.durationSeconds).toBeCloseTo(1.42);
    expect(result.requestId).toBe("tr-1");
    // Spacing tokens are dropped from the word table.
    expect(result.words?.map((w) => w.text)).toEqual(["Hello", "there."]);
    expect(result.words?.[0]?.speaker).toBe("speaker_0");
  });

  it("omits language_code when auto-detecting and defaults to scribe_v2", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    await client().transcribeAudio("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      audioBase64: Buffer.from([0]).toString("base64"),
      mimeType: "audio/mp4",
      modelId: "eleven_multilingual_v2",
      language: "auto",
    });
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("language_code")).toBeNull();
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).name).toBe("clip.m4a");
  });

  it("never reports the language-ID score as transcript confidence", async () => {
    // The pathological case: Scribe is all but certain the audio is English
    // and all but certain every word it picked is wrong. Reporting 0.99 here
    // would render as "99% confidence" over a mangled transcript.
    installFetch(() =>
      jsonResponse({
        language_code: "en",
        language_probability: 0.99,
        text: "grbl mmf",
        words: [
          { text: "grbl", type: "word", logprob: Math.log(0.11) },
          { text: "mmf", type: "word", logprob: Math.log(0.09) },
        ],
      }),
    );

    const result = await client().transcribeAudio("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      audioBase64: "AA==",
      mimeType: "audio/wav",
    });

    expect(result.confidence).toBeCloseTo(0.1);
    expect(result.confidence).not.toBeCloseTo(0.99);
    // The language score is still reported — labelled as one, in the summary.
    expect(result.summary).toContain("en (99%)");
  });

  it("leaves confidence unset when Scribe returns no logprobs", async () => {
    installFetch(() =>
      jsonResponse({
        language_code: "fr",
        language_probability: 0.97,
        text: "Bonjour.",
        words: [{ text: "Bonjour.", type: "word" }],
      }),
    );

    const result = await client().transcribeAudio("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
      audioBase64: "AA==",
      mimeType: "audio/wav",
    });

    // Absent, not zero and not invented — the panel omits the row entirely.
    expect(result.confidence).toBeUndefined();
    expect("confidence" in result).toBe(false);
    expect(result.language).toBe("fr");
  });

  it("surfaces API errors", async () => {
    installFetch(() => jsonResponse({ detail: "bad audio" }, 422));
    await expect(
      client().transcribeAudio("voice", `${ACCOUNT}:voice:v1`, ACCOUNT, {
        audioBase64: "AA==",
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/ElevenLabs API error 422 for \/v1\/speech-to-text/);
  });
});
