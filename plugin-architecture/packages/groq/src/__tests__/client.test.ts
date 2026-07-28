import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroqClient } from "../client.js";

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
    headers: new Headers({ "x-request-id": "req_123" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "x-request-id": "req_tts" }),
    arrayBuffer: async () => buffer,
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
  return new GroqClient({ apiKey: "gsk_test" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listResources", () => {
  it("lists models from the OpenAI-compatible base and derives modality", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "whisper-large-v3-turbo",
            owned_by: "OpenAI",
            active: true,
            context_window: 448,
            created: 1728000000,
          },
          { id: "llama-3.1-8b-instant", owned_by: "Meta", active: true, context_window: 131072 },
        ],
      }),
    );

    const models = await client().listResources("groq-model", ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
    expect(models.map((m) => m.fields["modality"])).toEqual(["Transcription", "Chat"]);
    expect(models[0]?.id).toBe(`${ACCOUNT}:groq-model:whisper-large-v3-turbo`);
  });

  it("lists fine-tunings from the root base, without the /openai segment", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          {
            id: "ft_1",
            name: "support-lora",
            type: "lora",
            base_model: "llama-3.1-8b-instant",
            fine_tuned_model: "ft:llama-3.1-8b-instant:support-lora",
            status: "succeeded",
            created_at: 1728000000,
          },
        ],
      }),
    );

    const tunings = await client().listResources("groq-fine-tuning", ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.groq.com/v1/fine_tunings");
    expect(calls[0]?.url).not.toContain("/openai/");
    expect(tunings[0]?.fields["fineTunedModel"]).toBe("ft:llama-3.1-8b-instant:support-lora");
  });

  it("sends the bearer token", async () => {
    installFetch(() => jsonResponse({ data: [] }));
    await client().listResources("groq-file", ACCOUNT);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer gsk_test");
  });
});

describe("getResource", () => {
  it("stashes the live audio-model split for the synchronous renderer", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          { id: "whisper-large-v3", active: true },
          { id: "canopylabs/orpheus-v1-english", active: true },
          { id: "llama-3.3-70b-versatile", active: true },
        ],
      }),
    );

    const resource = await client().getResource(
      "groq-model",
      `${ACCOUNT}:groq-model:whisper-large-v3`,
      ACCOUNT,
    );

    expect(JSON.parse(resource.resolvedOutputs["__audioModels__"] ?? "{}")).toEqual({
      stt: ["whisper-large-v3"],
      tts: ["canopylabs/orpheus-v1-english"],
    });
  });
});

describe("deleteResource", () => {
  it("routes fine-tuning deletes to the root base and files to /openai", async () => {
    installFetch(() => jsonResponse({}, 204));

    await client().deleteResource("groq-fine-tuning", `${ACCOUNT}:groq-fine-tuning:ft_1`, ACCOUNT);
    await client().deleteResource("groq-file", `${ACCOUNT}:groq-file:file_1`, ACCOUNT);

    expect(calls[0]?.url).toBe("https://api.groq.com/v1/fine_tunings/ft_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(calls[1]?.url).toBe("https://api.groq.com/openai/v1/files/file_1");
  });
});

describe("invokeAction", () => {
  it("cancels a batch", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction("groq-batch", `${ACCOUNT}:groq-batch:batch_1`, "cancel", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/batches/batch_1/cancel");
    expect(calls[0]?.init?.method).toBe("POST");
  });
});

describe("synthesizeSpeech", () => {
  it("posts JSON and base64-encodes the raw WAV response", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]);
    installFetch(() => binaryResponse(wav));

    const result = await client().synthesizeSpeech("groq-model", "id", ACCOUNT, {
      text: "hello there",
      voiceId: "troy",
      modelId: "canopylabs/orpheus-v1-english",
    });

    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/audio/speech");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "canopylabs/orpheus-v1-english",
      input: "hello there",
      voice: "troy",
      response_format: "wav",
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(wav));
    expect(result.characters).toBe(11);
    expect(result.requestId).toBe("req_tts");
  });

  it("switches to the Arabic checkpoint when an Arabic voice is picked", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1])));

    await client().synthesizeSpeech("groq-model", "id", ACCOUNT, {
      text: "مرحبا",
      voiceId: "fahad",
      // Deliberately mismatched: the shared model dropdown was left on English.
      modelId: "canopylabs/orpheus-v1-english",
    });

    expect(JSON.parse(String(calls[0]?.init?.body)).model).toBe("canopylabs/orpheus-arabic-saudi");
  });

  it("rejects input over the 200-character Orpheus limit before spending a request", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1])));
    await expect(
      client().synthesizeSpeech("groq-model", "id", ACCOUNT, { text: "a".repeat(201) }),
    ).rejects.toThrow(/200 characters/);
    expect(calls).toHaveLength(0);
  });
});

describe("transcribeAudio", () => {
  it("uploads multipart with the browser's own MIME type and parses verbose_json", async () => {
    installFetch(() =>
      jsonResponse({
        text: "hello world",
        language: "english",
        duration: 2.4,
        x_groq: { id: "req_abc" },
        words: [{ word: "hello", start: 0, end: 0.5 }],
        segments: [{ text: "hello world", start: 0, end: 2.4, avg_logprob: -0.2 }],
      }),
    );

    const audio = Buffer.from("fake-opus-bytes").toString("base64");
    const result = await client().transcribeAudio("groq-model", "id", ACCOUNT, {
      audioBase64: audio,
      mimeType: "audio/webm;codecs=opus",
      modelId: "whisper-large-v3-turbo",
      language: "en",
    });

    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("en");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);

    const uploaded = form.get("file") as Blob & { name?: string };
    expect(uploaded.type).toBe("audio/webm;codecs=opus");
    expect(uploaded.name).toBe("clip.webm");
    expect(Buffer.from(await uploaded.arrayBuffer()).toString()).toBe("fake-opus-bytes");

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("english");
    expect(result.durationSeconds).toBe(2.4);
    expect(result.words?.[0]).toEqual({ text: "hello", start: 0, end: 0.5 });
    expect(result.confidence).toBeCloseTo(Math.exp(-0.2), 5);
    expect(result.requestId).toBe("req_abc");
    // Under the 10 s floor, so the summary has to say what is actually billed.
    expect(result.summary).toContain("billed as 10 s");
  });

  it("falls back to a transcription model when the shared picker holds a TTS model", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    await client().transcribeAudio("groq-model", "id", ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
      modelId: "canopylabs/orpheus-v1-english",
    });
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect((form.get("file") as Blob & { name?: string }).name).toBe("clip.mp4");
  });
});
