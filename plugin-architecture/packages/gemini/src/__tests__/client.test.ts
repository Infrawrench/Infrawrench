import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiClient } from "../client.js";
import { WAV_HEADER_BYTES } from "../audio.js";

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
  }) as typeof fetch);
}

function client() {
  return new GeminiClient({ apiKey: "AIzaTestKey" });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init!.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constructor", () => {
  it("rejects a missing key", () => {
    expect(() => new GeminiClient({})).toThrow(/missing apiKey/);
  });
});

describe("auth", () => {
  it("sends the key as x-goog-api-key, never in the URL", async () => {
    installFetch(() => jsonResponse({ models: [] }));
    await client().listResources("model", ACCOUNT);

    const call = calls[0]!;
    expect(call.url.startsWith("https://generativelanguage.googleapis.com/v1beta/")).toBe(true);
    expect(headerOf(call.init, "x-goog-api-key")).toBe("AIzaTestKey");
    // The legacy ?key= form works too, but keeps the secret in logs.
    expect(call.url).not.toContain("key=AIzaTestKey");
  });
});

describe("listResources — Google-standard pagination", () => {
  it("walks pageSize/pageToken until nextPageToken is absent", async () => {
    installFetch((url) => {
      if (url.includes("pageToken=t2")) {
        return jsonResponse({ models: [{ name: "models/b" }] });
      }
      return jsonResponse({ models: [{ name: "models/a" }], nextPageToken: "t2" });
    });

    const models = await client().listResources("model", ACCOUNT);
    expect(models.map((m) => m.externalId)).toEqual(["a", "b"]);
    expect(calls[0]!.url).toContain("pageSize=1000");
    expect(calls[1]!.url).toContain("pageToken=t2");
  });

  it("uses each collection's own pageSize cap", async () => {
    const c = client();

    installFetch(() => jsonResponse({ files: [] }));
    await c.listResources("file", ACCOUNT);
    // Files cap at 100, not 1000.
    expect(calls[0]!.url).toContain("pageSize=100");

    calls = [];
    installFetch(() => jsonResponse({ fileSearchStores: [] }));
    await c.listResources("file-search-store", ACCOUNT);
    // File Search stores cap at 20.
    expect(calls[0]!.url).toContain("pageSize=20");
  });

  it("hits the right path for every type", async () => {
    const c = client();
    const paths: Record<string, string> = {
      model: "/v1beta/models?",
      "tuned-model": "/v1beta/tunedModels?",
      file: "/v1beta/files?",
      "cached-content": "/v1beta/cachedContents?",
      batch: "/v1beta/batches?",
      "file-search-store": "/v1beta/fileSearchStores?",
    };

    for (const [typeId, path] of Object.entries(paths)) {
      calls = [];
      installFetch(() => jsonResponse({}));
      await c.listResources(typeId, ACCOUNT);
      expect(calls[0]!.url).toContain(path);
    }
  });

  it("rejects an unknown type", async () => {
    await expect(client().listResources("corpora", ACCOUNT)).rejects.toThrow(
      /unknown resource type/,
    );
  });
});

describe("model mapping", () => {
  it("shortens models/x into a usable id and keeps the token limits", async () => {
    installFetch(() =>
      jsonResponse({
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            version: "2.5",
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
            thinking: true,
          },
        ],
      }),
    );

    const [model] = await client().listResources("model", ACCOUNT);
    expect(model!.externalId).toBe("gemini-2.5-flash");
    expect(model!.id).toBe(`${ACCOUNT}:model:gemini-2.5-flash`);
    expect(model!.displayName).toBe("Gemini 2.5 Flash");
    expect(model!.fields["inputTokenLimit"]).toBe(1048576);
    expect(model!.fields["outputTokenLimit"]).toBe(65536);
    expect(model!.fields["thinking"]).toBe(true);
    expect(model!.fields["supportedGenerationMethods"]).toBe("generateContent, countTokens");
  });
});

describe("batches are an Operations API", () => {
  it("reads operations[] and flattens metadata into fields", async () => {
    installFetch(() =>
      jsonResponse({
        operations: [
          {
            name: "batches/abc123",
            done: false,
            metadata: {
              displayName: "nightly",
              model: "models/gemini-2.5-flash",
              state: "BATCH_STATE_RUNNING",
              createTime: "2026-01-01T00:00:00Z",
              batchStats: {
                requestCount: "100",
                successfulRequestCount: "40",
                failedRequestCount: "2",
                pendingRequestCount: "58",
              },
              output: { responsesFile: "files/out1" },
            },
          },
        ],
      }),
    );

    const [batch] = await client().listResources("batch", ACCOUNT);
    expect(batch!.displayName).toBe("nightly");
    expect(batch!.externalId).toBe("abc123");
    expect(batch!.fields["state"]).toBe("BATCH_STATE_RUNNING");
    // The int64-as-string counts become real numbers.
    expect(batch!.fields["requestCount"]).toBe(100);
    expect(batch!.fields["successfulRequestCount"]).toBe(40);
    expect(batch!.fields["failedRequestCount"]).toBe(2);
    expect(batch!.fields["pendingRequestCount"]).toBe(58);
    expect(batch!.fields["outputFileName"]).toBe("files/out1");
  });

  it("does not look for a batches[] key", async () => {
    installFetch(() => jsonResponse({ batches: [{ name: "batches/wrong" }] }));
    const batches = await client().listResources("batch", ACCOUNT);
    expect(batches).toEqual([]);
  });
});

describe("file-search documents fan out over stores", () => {
  it("lists documents for every store", async () => {
    installFetch((url) => {
      if (url.includes("/documents")) {
        return jsonResponse({
          documents: [{ name: `${url.split("/documents")[0]!.split("v1beta/")[1]}/documents/d1` }],
        });
      }
      return jsonResponse({
        fileSearchStores: [{ name: "fileSearchStores/s1" }, { name: "fileSearchStores/s2" }],
      });
    });

    const docs = await client().listResources("file-search-document", ACCOUNT);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.fields["storeName"]).toBe("fileSearchStores/s1");
    expect(docs[0]!.parentResourceId).toBe(`${ACCOUNT}:file-search-store:s1`);
  });

  it("does not let one unreadable store blank the whole listing", async () => {
    installFetch((url) => {
      if (url.includes("fileSearchStores/s1/documents")) return jsonResponse("nope", 403);
      if (url.includes("/documents")) {
        return jsonResponse({ documents: [{ name: "fileSearchStores/s2/documents/d1" }] });
      }
      return jsonResponse({
        fileSearchStores: [{ name: "fileSearchStores/s1" }, { name: "fileSearchStores/s2" }],
      });
    });

    const docs = await client().listResources("file-search-document", ACCOUNT);
    expect(docs).toHaveLength(1);
  });
});

describe("resolveOutput", () => {
  it("answers the endpoint without a network call", async () => {
    installFetch(() => jsonResponse({}));
    const value = await client().resolveOutput("model", `${ACCOUNT}:model:m`, "endpoint", ACCOUNT);
    expect(value).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(calls).toHaveLength(0);
  });

  it("resolves a file URI", async () => {
    installFetch(() =>
      jsonResponse({
        files: [
          { name: "files/f1", uri: "https://generativelanguage.googleapis.com/v1beta/files/f1" },
        ],
      }),
    );
    const value = await client().resolveOutput("file", `${ACCOUNT}:file:f1`, "fileUri", ACCOUNT);
    expect(value).toBe("https://generativelanguage.googleapis.com/v1beta/files/f1");
  });

  it("throws for an output it does not own", async () => {
    installFetch(() => jsonResponse({ models: [{ name: "models/m" }] }));
    await expect(
      client().resolveOutput("model", `${ACCOUNT}:model:m`, "nope", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("mutations", () => {
  it("creates a File Search store", async () => {
    installFetch(() => jsonResponse({ name: "fileSearchStores/s9", displayName: "docs" }));
    const created = await client().createResource("file-search-store", ACCOUNT, {
      displayName: "docs",
    });

    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/fileSearchStores");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(bodyOf(calls[0]!.init)).toEqual({ displayName: "docs" });
    expect(created.externalId).toBe("s9");
  });

  it("patches only a cache's ttl, with the required updateMask", async () => {
    installFetch(() => jsonResponse({ name: "cachedContents/c1", ttl: "7200s" }));
    await client().updateResource("cached-content", `${ACCOUNT}:cached-content:c1`, ACCOUNT, {
      ttl: "7200s",
    });

    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/c1?updateMask=ttl",
    );
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(bodyOf(calls[0]!.init)).toEqual({ ttl: "7200s" });
  });

  it("refuses to update anything else", async () => {
    await expect(
      client().updateResource("model", `${ACCOUNT}:model:m`, ACCOUNT, { name: "x" }),
    ).rejects.toThrow(/cannot update type/);
  });

  it("uses the right delete path for each type", async () => {
    const c = client();
    const cases: Array<[string, string, string]> = [
      ["file", "f1", "/v1beta/files/f1"],
      ["cached-content", "c1", "/v1beta/cachedContents/c1"],
      ["tuned-model", "t1", "/v1beta/tunedModels/t1"],
      ["batch", "b1", "/v1beta/batches/b1"],
    ];

    for (const [typeId, externalId, path] of cases) {
      calls = [];
      installFetch(() => jsonResponse({}));
      await c.deleteResource(typeId, `${ACCOUNT}:${typeId}:${externalId}`, ACCOUNT);
      expect(calls[0]!.url).toBe(`https://generativelanguage.googleapis.com${path}`);
      expect(calls[0]!.init?.method).toBe("DELETE");
    }
  });

  it("passes force=true when deleting File Search stores and documents", async () => {
    const c = client();

    installFetch(() => jsonResponse({}));
    await c.deleteResource("file-search-store", `${ACCOUNT}:file-search-store:s1`, ACCOUNT);
    // Without force, a store holding documents returns FAILED_PRECONDITION.
    expect(calls[0]!.url).toContain("/v1beta/fileSearchStores/s1?force=true");

    calls = [];
    installFetch(() => jsonResponse({}));
    await c.deleteResource(
      "file-search-document",
      `${ACCOUNT}:file-search-document:fileSearchStores/s1/documents/d1`,
      ACCOUNT,
    );
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/fileSearchStores/s1/documents/d1?force=true",
    );
  });

  it("refuses to delete a base model", async () => {
    await expect(
      client().deleteResource("model", `${ACCOUNT}:model:gemini-2.5-flash`, ACCOUNT),
    ).rejects.toThrow(/cannot delete type/);
  });

  it("cancels a batch with the colon verb", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction("batch", `${ACCOUNT}:batch:b1`, "cancel", ACCOUNT);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/batches/b1:cancel",
    );
    expect(calls[0]!.init?.method).toBe("POST");
  });
});

describe("getResource enrichment", () => {
  it("stashes audio-capable models for the synchronous Speech panel", async () => {
    installFetch(() =>
      jsonResponse({
        models: [
          {
            name: "models/gemini-2.5-flash",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-2.5-flash-preview-tts",
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["generateContent"] },
        ],
      }),
    );

    const resource = await client().getResource(
      "model",
      `${ACCOUNT}:model:gemini-2.5-flash`,
      ACCOUNT,
    );
    const stashed = JSON.parse(resource.resolvedOutputs["__sttModels__"]!) as Array<{ id: string }>;
    // TTS models, embedding models, and anything without generateContent are
    // all excluded from the transcription picker.
    expect(stashed.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
  });
});

describe("synthesizeSpeech", () => {
  // 4 bytes of "PCM" — the actual samples don't matter, the framing does.
  const pcm = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const pcmBase64 = Buffer.from(pcm).toString("base64");

  function interactionResponse(audio: Record<string, unknown>) {
    return jsonResponse({
      interaction: { id: "int-1", output_audio: audio, usage: { total_tokens: 42 } },
    });
  }

  it("POSTs the documented Interactions body — not generateContent", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64, mime_type: "audio/l16" }));

    await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hello there",
      voiceId: "Puck",
      modelId: "gemini-2.5-flash-preview-tts",
    });

    const call = calls[0]!;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call.init?.method).toBe("POST");
    expect(bodyOf(call.init)).toEqual({
      model: "gemini-2.5-flash-preview-tts",
      input: "Hello there",
      response_format: { type: "audio" },
      // speech_config is an ARRAY of speaker configs, not a single object.
      generation_config: { speech_config: [{ voice: "Puck" }] },
    });
  });

  it("wraps the raw PCM in a WAV header and reports audio/wav", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64, mime_type: "audio/l16" }));

    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hi",
    });

    // Raw PCM cannot be played by a browser <audio> element; the header is
    // what makes the Speech tab work at all.
    expect(result.mimeType).toBe("audio/wav");
    const wav = new Uint8Array(Buffer.from(result.audioBase64, "base64"));
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    // Payload survives the round-trip byte for byte.
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual(Array.from(pcm));

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
    expect(result.fileName).toMatch(/\.wav$/);
  });

  it("wraps when the response reports no mime_type at all", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64 }));
    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hi",
    });
    expect(result.mimeType).toBe("audio/wav");
  });

  it("honours a reported sample rate and channel count instead of assuming", async () => {
    installFetch(() =>
      interactionResponse({
        data: Buffer.from(new Uint8Array(8)).toString("base64"),
        mime_type: "audio/l16",
        sample_rate: 48000,
        channels: 2,
      }),
    );

    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hi",
    });
    const wav = new Uint8Array(Buffer.from(result.audioBase64, "base64"));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(2);
  });

  it("passes a real container straight through rather than double-wrapping", async () => {
    const mp3 = Buffer.from("fake-mp3").toString("base64");
    installFetch(() => interactionResponse({ data: mp3, mime_type: "audio/mp3" }));

    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hi",
    });
    expect(result.mimeType).toBe("audio/mp3");
    expect(result.audioBase64).toBe(mp3);
    expect(result.fileName).toMatch(/\.mp3$/);
  });

  it("falls back to a TTS model when the picker is left on a chat model", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64 }));
    await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hi",
      modelId: "gemini-2.5-flash",
    });
    expect(bodyOf(calls[0]!.init)["model"]).toBe("gemini-3.1-flash-tts-preview");
  });

  it("defaults the voice to Kore", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64 }));
    await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, { text: "Hi" });
    const config = bodyOf(calls[0]!.init)["generation_config"] as {
      speech_config: Array<{ voice: string }>;
    };
    expect(config.speech_config[0]!.voice).toBe("Kore");
  });

  it("reports characters and a useful summary", async () => {
    installFetch(() => interactionResponse({ data: pcmBase64, mime_type: "audio/l16" }));
    const result = await client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      text: "Hello there",
      voiceId: "Leda",
    });
    expect(result.characters).toBe(11);
    expect(result.summary).toContain("Leda");
    expect(result.summary).toContain("24000 Hz mono");
    expect(result.requestId).toBe("int-1");
  });

  it("explains itself when a model returns no audio", async () => {
    installFetch(() => jsonResponse({ interaction: { id: "int-2" } }));
    await expect(
      client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, { text: "Hi" }),
    ).rejects.toThrow(/only available on the \*-tts models/);
  });

  it("refuses empty text before hitting the network", async () => {
    await expect(
      client().synthesizeSpeech("model", `${ACCOUNT}:model:m`, ACCOUNT, { text: "   " }),
    ).rejects.toThrow(/nothing to synthesize/);
    expect(calls).toHaveLength(0);
  });
});

describe("transcribeAudio", () => {
  const audio = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
  const audioBase64 = Buffer.from(audio).toString("base64");

  it("sends inline_data to generateContent with the clip's real MIME type", async () => {
    installFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hello world" }] } }],
        usageMetadata: { promptTokenCount: 320 },
        responseId: "resp-1",
      }),
    );

    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      fileName: "clip.wav",
      modelId: "gemini-2.5-flash",
    });

    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    const body = bodyOf(calls[0]!.init) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const inline = body.contents[0]!.parts.find((p) => "inline_data" in p) as {
      inline_data: { mime_type: string; data: string };
    };
    expect(inline.inline_data.mime_type).toBe("audio/wav");
    // Base64 must survive untouched — no transcoding, no re-encoding.
    expect(inline.inline_data.data).toBe(audioBase64);

    expect(result.text).toBe("hello world");
    expect(result.requestId).toBe("resp-1");
    // 32 tokens per second of audio → 320 tokens ≈ 10 s.
    expect(result.summary).toContain("~10.0s of audio");
    // Gemini returns prose, not a timed transcript.
    expect(result.words).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  it("forwards a browser recording's MIME type rather than refusing it outright", async () => {
    installFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));

    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm;codecs=opus",
    });

    const body = bodyOf(calls[0]!.init) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const inline = body.contents[0]!.parts.find((p) => "inline_data" in p) as {
      inline_data: { mime_type: string };
    };
    expect(inline.inline_data.mime_type).toBe("audio/webm;codecs=opus");
  });

  it("explains the undocumented-format situation when Gemini rejects a recording", async () => {
    installFetch(() => jsonResponse("INVALID_ARGUMENT: unsupported mime type", 400));

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64,
        mimeType: "audio/webm;codecs=opus",
      }),
    ).rejects.toThrow(/documents WAV, MP3, AIFF, AAC, OGG and FLAC/);
  });

  it("leaves a documented-format failure as the plain API error", async () => {
    installFetch(() => jsonResponse("INVALID_ARGUMENT: something else", 400));

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/Gemini API error 400/);
  });

  it("falls back to a multimodal model when the picker is left on a TTS model", async () => {
    installFetch(() => jsonResponse({ candidates: [] }));
    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
      modelId: "gemini-2.5-pro-preview-tts",
    });
    expect(calls[0]!.url).toContain("/models/gemini-2.5-flash:generateContent");
  });

  it("refuses a clip that would blow the 20 MB inline request cap", async () => {
    const big = Buffer.alloc(15 * 1024 * 1024).toString("base64");
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: big,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/Files API/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty clip", async () => {
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: "",
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/empty/);
  });

  it("concatenates multi-part candidate text", async () => {
    installFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }],
      }),
    );
    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64,
      mimeType: "audio/wav",
    });
    expect(result.text).toBe("hello world");
  });
});

describe("error surfacing", () => {
  it("includes the vendor, status and path", async () => {
    installFetch(() => jsonResponse("quota exceeded", 429));
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow(
      /Gemini API error 429 for \/models/,
    );
  });
});
