import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TogetherClient } from "../client.js";

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

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => "binary",
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
  return new TogetherClient({ apiKey: "tk_test" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("v1 listing", () => {
  it("reads the `{data}` envelope for fine-tunes and sends no pagination params", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          { id: "ft-1", status: "completed", model: "meta/llama", model_output_name: "acme/tuned" },
        ],
      }),
    );
    const items = await client().listResources("fine-tune", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.together.ai/v1/fine-tunes");
    expect(items[0]?.displayName).toBe("acme/tuned");
    // `model_output_name` is the wire name; `output_name` is a Python-SDK alias.
    expect(items[0]?.resolvedOutputs["outputName"]).toBe("acme/tuned");
  });

  it("reads batches as a bare array, not a `{data}` envelope", async () => {
    installFetch(() => jsonResponse([{ id: "b-1", status: "IN_PROGRESS", progress: 42 }]));
    const items = await client().listResources("batch", ACCOUNT);
    expect(items).toHaveLength(1);
    // Together reports progress on a 0–100 scale.
    expect(items[0]?.fields["progress"]).toBe(42);
  });

  it("prefers the undocumented LineCount but falls back to validation_report.nlines", async () => {
    installFetch(() =>
      jsonResponse({
        data: [
          { id: "f-1", filename: "a.jsonl", LineCount: 10 },
          { id: "f-2", filename: "b.jsonl", validation_report: { valid: true, nlines: 20 } },
        ],
      }),
    );
    const items = await client().listResources("file", ACCOUNT);
    expect(items[0]?.fields["lineCount"]).toBe(10);
    expect(items[1]?.fields["lineCount"]).toBe(20);
  });
});

describe("v2 DMI endpoints", () => {
  it("discovers the project from /whoami and follows the next_cursor", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/whoami")) {
        return jsonResponse({ project_id: "proj-1", project_slug: "acme" });
      }
      if (url.includes("/v2/projects/proj-1/endpoints") && !url.includes("after=")) {
        return jsonResponse({ data: [{ id: "e1", name: "acme/one" }], next_cursor: "cur-2" });
      }
      if (url.includes("after=cur-2")) {
        return jsonResponse({ data: [{ id: "e2", name: "acme/two" }], next_cursor: null });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const items = await client().listResources("managed-endpoint", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["e1", "e2"]);
    // The v2 operations override the server to api.together.ai, not
    // api-inference.together.ai.
    expect(calls[1]?.url).toContain(
      "https://api.together.ai/v2/projects/proj-1/endpoints?limit=100",
    );
  });

  it("deletes deployments before the endpoint itself", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/v1/whoami")) return jsonResponse({ project_id: "proj-1" });
      if (url.includes("/endpoints/e1/deployments?limit=500")) {
        return jsonResponse({ data: [{ id: "d1" }, { id: "d2" }] });
      }
      if (init?.method === "DELETE") return jsonResponse({}, 204);
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().deleteResource("managed-endpoint", `${ACCOUNT}:managed-endpoint:e1`, ACCOUNT);
    const deletes = calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
    expect(deletes).toEqual([
      "https://api.together.ai/v2/projects/proj-1/endpoints/e1/deployments/d1",
      "https://api.together.ai/v2/projects/proj-1/endpoints/e1/deployments/d2",
      "https://api.together.ai/v2/projects/proj-1/endpoints/e1",
    ]);
  });
});

describe("dedicated endpoints", () => {
  it("nests replica counts under `autoscaling` on create", async () => {
    installFetch(() =>
      jsonResponse({
        id: "endpoint-abc",
        name: "acme/llama",
        model: "meta/llama",
        hardware: "1x_nvidia_h100_80gb_sxm",
        state: "STARTED",
        autoscaling: { min_replicas: 1, max_replicas: 4 },
      }),
    );
    await client().createResource("endpoint", ACCOUNT, {
      display_name: "prod",
      model: "meta/llama",
      hardware: "1x_nvidia_h100_80gb_sxm",
      min_replicas: "1",
      max_replicas: "4",
      state: "STARTED",
      inactive_timeout: "0",
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      model: "meta/llama",
      hardware: "1x_nvidia_h100_80gb_sxm",
      autoscaling: { min_replicas: 1, max_replicas: 4 },
      display_name: "prod",
      state: "STARTED",
    });
  });

  it("rejects a state the PATCH route does not accept", async () => {
    installFetch(() => jsonResponse({ id: "e1", autoscaling: {} }));
    await expect(
      client().updateResource("endpoint", `${ACCOUNT}:endpoint:e1`, ACCOUNT, {
        state: "STARTING",
      }),
    ).rejects.toThrow(/STARTED or STOPPED/);
  });

  it("merges a partial replica edit against the current autoscaling window", async () => {
    installFetch((url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ id: "e1", autoscaling: { min_replicas: 2, max_replicas: 9 } });
      }
      return jsonResponse({ id: "e1", autoscaling: { min_replicas: 1, max_replicas: 9 } });
    });
    await client().updateResource("endpoint", `${ACCOUNT}:endpoint:e1`, ACCOUNT, {
      minReplicas: "2",
    });
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      autoscaling: { min_replicas: 2, max_replicas: 9 },
    });
  });
});

describe("models", () => {
  it("unions in the documented speech models when the catalogue omits them", async () => {
    installFetch(() => jsonResponse([{ id: "meta/llama", type: "chat" }]));
    const items = await client().listResources("model", ACCOUNT);
    const ids = items.map((i) => i.externalId);
    expect(ids).toContain("cartesia/sonic");
    expect(ids).toContain("hexgrad/Kokoro-82M");
    expect(ids).toContain("canopylabs/orpheus-3b-0.1-ft");
    expect(ids).toContain("openai/whisper-large-v3");
  });

  it("renders a Speech tab on a speech model only", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/voices")) {
        return jsonResponse({
          data: [{ model: "hexgrad/Kokoro-82M", voices: [{ id: "v1", name: "af_heart" }] }],
        });
      }
      return jsonResponse([
        { id: "meta/llama", type: "chat" },
        { id: "hexgrad/Kokoro-82M", type: "audio" },
      ]);
    });
    const c = client();
    const speech = await c.getResource("model", `${ACCOUNT}:model:hexgrad/Kokoro-82M`, ACCOUNT);
    const chat = await c.getResource("model", `${ACCOUNT}:model:meta/llama`, ACCOUNT);

    const panel = c.renderDetail(speech).speechPanel;
    expect(panel?.modes).toEqual(["tts", "stt"]);
    // Voices come from the live catalogue, keyed by name for non-Cartesia models.
    expect(panel?.voices?.[0]).toEqual({ id: "af_heart", label: "af_heart" });
    expect(c.renderDetail(chat).speechPanel).toBeUndefined();
  });

  it("addresses Cartesia voices by id, everything else by name", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/voices")) {
        return jsonResponse({
          data: [
            { model: "cartesia/sonic", voices: [{ id: "uuid-1", name: "Barbershop Man" }] },
            { model: "hexgrad/Kokoro-82M", voices: [{ id: "k-1", name: "af_heart" }] },
          ],
        });
      }
      return jsonResponse([{ id: "cartesia/sonic", type: "audio" }]);
    });
    const c = client();
    const resource = await c.getResource("model", `${ACCOUNT}:model:cartesia/sonic`, ACCOUNT);
    const panel = c.renderDetail(resource).speechPanel;
    expect(panel?.voices).toEqual([{ id: "uuid-1", label: "Barbershop Man" }]);
  });
});

describe("speech", () => {
  it("requests mp3 and round-trips the raw bytes as base64", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00]);
    installFetch(() => binaryResponse(audio));

    const result = await client().synthesizeSpeech(
      "model",
      `${ACCOUNT}:model:hexgrad/Kokoro-82M`,
      ACCOUNT,
      { text: "hello", voiceId: "af_heart", modelId: "hexgrad/Kokoro-82M" },
    );

    expect(calls[0]?.url).toBe("https://api.together.ai/v1/audio/speech");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      model: "hexgrad/Kokoro-82M",
      input: "hello",
      voice: "af_heart",
      response_format: "mp3",
    });
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(audio));
  });

  it("falls back to a real TTS model when the shared picker had Whisper selected", async () => {
    installFetch(() => binaryResponse(new Uint8Array([1, 2, 3])));
    await client().synthesizeSpeech("model", `${ACCOUNT}:model:x`, ACCOUNT, {
      text: "hi",
      modelId: "openai/whisper-large-v3",
    });
    expect(JSON.parse(calls[0]!.init!.body as string).model).toBe("hexgrad/Kokoro-82M");
  });

  it("posts multipart with diarization and maps speaker-labelled words", async () => {
    installFetch(() =>
      jsonResponse({
        text: "hello there",
        language: "en",
        duration: 1.5,
        segments: [{ id: 0, start: 0, end: 1.5, text: "hello there" }],
        words: [
          { word: "hello", start: 0, end: 0.5, speaker_id: "SPEAKER_00" },
          { word: "there", start: 0.6, end: 1.1, speaker_id: "SPEAKER_01" },
        ],
        speaker_segments: [
          { speaker_id: "SPEAKER_00", start: 0, end: 0.5, text: "hello", id: 0 },
          { speaker_id: "SPEAKER_01", start: 0.6, end: 1.1, text: "there", id: 1 },
        ],
      }),
    );

    const audioBase64 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64");
    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:x`, ACCOUNT, {
      audioBase64,
      mimeType: "audio/webm;codecs=opus",
      language: "auto",
    });

    expect(calls[0]?.url).toBe("https://api.together.ai/v1/audio/transcriptions");
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("model")).toBe("openai/whisper-large-v3");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("timestamp_granularities")).toBe("word");
    // The recorder's MIME type is forwarded verbatim, never transcoded.
    const file = form.get("file") as Blob;
    expect(file.type).toBe("audio/webm;codecs=opus");

    expect(result.text).toBe("hello there");
    expect(result.durationSeconds).toBe(1.5);
    expect(result.words).toEqual([
      { text: "hello", start: 0, end: 0.5, speaker: "SPEAKER_00" },
      { text: "there", start: 0.6, end: 1.1, speaker: "SPEAKER_01" },
    ]);
    expect(result.summary).toContain("2 speakers");
  });

  it("surfaces a non-JSON error body rather than trying to parse it", async () => {
    installFetch(() => jsonResponse("<html>Request Entity Too Large</html>", 413));
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:x`, ACCOUNT, {
        audioBase64: "AAAA",
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/413/);
  });
});

describe("evaluations", () => {
  it("keys evaluations on workflow_id and hits the singular path", async () => {
    installFetch(() =>
      jsonResponse([
        { workflow_id: "eval-1", type: "score", status: "completed", parameters: { model: "m" } },
      ]),
    );
    const items = await client().listResources("evaluation", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.together.ai/v1/evaluation?limit=100");
    expect(items[0]?.externalId).toBe("eval-1");
    expect(items[0]?.fields["model"]).toBe("m");
  });
});
