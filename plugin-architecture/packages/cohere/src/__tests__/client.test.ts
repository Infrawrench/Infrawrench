import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohereClient } from "../client.js";

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
  return new CohereClient({ apiKey: "test-key" });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constructor", () => {
  it("rejects a missing key rather than failing later on the wire", () => {
    expect(() => new CohereClient({})).toThrow(/missing apiKey/);
  });
});

describe("auth and base URL", () => {
  it("hits api.cohere.com with a Bearer token and X-Client-Name", async () => {
    installFetch(() => jsonResponse({ models: [] }));
    await client().listResources("model", ACCOUNT);

    const call = calls[0]!;
    expect(call.url.startsWith("https://api.cohere.com/")).toBe(true);
    // Not api.cohere.ai — that host only survives on stale pages.
    expect(call.url).not.toContain("api.cohere.ai");
    expect(headerOf(call.init, "Authorization")).toBe("Bearer test-key");
    expect(headerOf(call.init, "X-Client-Name")).toBe("infrawrench");
  });
});

describe("check-api-key", () => {
  it("POSTs to the v1 path with no body", async () => {
    installFetch(() => jsonResponse({ valid: true, organization_id: "org-1", owner_id: "own-1" }));
    const result = await client().checkApiKey();

    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/check-api-key");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBeUndefined();
    expect(result).toEqual({ valid: true, organization_id: "org-1", owner_id: "own-1" });
  });

  it("throws when the key is reported invalid", async () => {
    installFetch(() => jsonResponse({ valid: false }));
    await expect(client().validateCredentials()).rejects.toThrow(/rejected as invalid/);
  });
});

describe("listResources — pagination styles differ per resource", () => {
  it("models use page_size/page_token and stop on an empty next_page_token", async () => {
    installFetch((url) => {
      if (url.includes("page_token=tok2")) {
        return jsonResponse({ models: [{ name: "b" }], next_page_token: "" });
      }
      return jsonResponse({ models: [{ name: "a" }], next_page_token: "tok2" });
    });

    const models = await client().listResources("model", ACCOUNT);
    expect(models.map((m) => m.displayName)).toEqual(["a", "b"]);
    expect(calls[0]!.url).toContain("page_size=1000");
    expect(calls[1]!.url).toContain("page_token=tok2");
  });

  it("datasets use limit/offset and stop on a short page", async () => {
    installFetch(() => jsonResponse({ datasets: [{ id: "d1", name: "one" }] }));
    const datasets = await client().listResources("dataset", ACCOUNT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("limit=100");
    expect(calls[0]!.url).toContain("offset=0");
    expect(datasets[0]!.id).toBe(`${ACCOUNT}:dataset:d1`);
  });

  it("embed jobs are fetched with no query parameters at all", async () => {
    installFetch(() => jsonResponse({ embed_jobs: [{ job_id: "j1", status: "processing" }] }));
    await client().listResources("embed-job", ACCOUNT);

    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/embed-jobs");
  });

  it("fine-tunes stay on the v1 management path", async () => {
    installFetch(() => jsonResponse({ finetuned_models: [{ id: "ft1", name: "mine" }] }));
    await client().listResources("finetuned-model", ACCOUNT);

    expect(calls[0]!.url).toContain("/v1/finetuning/finetuned-models?");
  });

  it("batches are the one management-shaped surface on v2", async () => {
    installFetch(() => jsonResponse({ batches: [{ id: "b1", name: "nightly" }] }));
    await client().listResources("batch", ACCOUNT);

    expect(calls[0]!.url).toContain("/v2/batches?");
  });

  it("rejects an unknown type", async () => {
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("field mapping", () => {
  it("sums per-part byte sizes and num_rows onto the dataset", async () => {
    installFetch(() =>
      jsonResponse({
        datasets: [
          {
            id: "d1",
            name: "training",
            dataset_type: "chat-finetune-input",
            validation_status: "validated",
            dataset_parts: [
              { size_bytes: 1000, num_rows: 10 },
              { size_bytes: 500, num_rows: 5 },
            ],
          },
        ],
      }),
    );

    const [dataset] = await client().listResources("dataset", ACCOUNT);
    expect(dataset!.fields["sizeBytes"]).toBe("1500");
    expect(dataset!.fields["numRows"]).toBe(15);
    expect(dataset!.fields["partCount"]).toBe(2);
  });

  it("flattens the nested fine-tune base_model settings", async () => {
    installFetch(() =>
      jsonResponse({
        finetuned_models: [
          {
            id: "ft1",
            name: "mine",
            status: "STATUS_READY",
            settings: {
              dataset_id: "d1",
              base_model: { name: "command", version: "1", base_type: "BASE_TYPE_CHAT" },
              hyperparameters: { train_epochs: 3 },
            },
          },
        ],
      }),
    );

    const [ft] = await client().listResources("finetuned-model", ACCOUNT);
    expect(ft!.fields["baseType"]).toBe("BASE_TYPE_CHAT");
    expect(ft!.fields["baseModel"]).toBe("command");
    expect(ft!.fields["datasetId"]).toBe("d1");
    expect(JSON.parse(String(ft!.fields["hyperparameters"]))).toEqual({ train_epochs: 3 });
  });
});

describe("getResource enrichment", () => {
  it("stashes transcription models for the synchronous Speech panel", async () => {
    installFetch(() =>
      jsonResponse({
        models: [
          { name: "command-a-03-2025", endpoints: ["chat"] },
          { name: "cohere-transcribe-03-2026" },
          { name: "cohere-transcribe-old", is_deprecated: true },
        ],
      }),
    );

    const resource = await client().getResource(
      "model",
      `${ACCOUNT}:model:command-a-03-2025`,
      ACCOUNT,
    );
    const stashed = JSON.parse(resource.resolvedOutputs["__speechModels__"]!);
    // Discovered by name prefix — there is no `transcribe` value in the
    // CompatibleEndpoint enum to filter on — and the deprecated one is dropped.
    expect(stashed.map((m: { id: string }) => m.id)).toEqual(["cohere-transcribe-03-2026"]);
  });

  it("stashes org storage usage on a dataset", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/datasets/usage")) return jsonResponse({ organization_usage: 4096 });
      return jsonResponse({ datasets: [{ id: "d1", name: "one" }] });
    });

    const resource = await client().getResource("dataset", `${ACCOUNT}:dataset:d1`, ACCOUNT);
    expect(resource.resolvedOutputs["__datasetUsage__"]).toBe("4096");
  });

  it("does not let a failing enrichment call break the detail page", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/datasets/usage")) return jsonResponse("boom", 500);
      return jsonResponse({ datasets: [{ id: "d1", name: "one" }] });
    });

    const resource = await client().getResource("dataset", `${ACCOUNT}:dataset:d1`, ACCOUNT);
    expect(resource.resolvedOutputs["__datasetUsage__"]).toBe("null");
  });

  it("fetches events and training-step-metrics for a fine-tune", async () => {
    installFetch((url) => {
      if (url.includes("/events")) {
        return jsonResponse({ events: [{ status: "STATUS_READY", created_at: "t", user_id: "" }] });
      }
      if (url.includes("/training-step-metrics")) {
        return jsonResponse({ step_metrics: [{ step_number: 1, metrics: { loss: 0.25 } }] });
      }
      return jsonResponse({ finetuned_models: [{ id: "ft1", name: "mine" }] });
    });

    const resource = await client().getResource(
      "finetuned-model",
      `${ACCOUNT}:finetuned-model:ft1`,
      ACCOUNT,
    );

    // The metrics path is `training-step-metrics`, not `metrics`.
    expect(calls.some((c) => c.url.includes("/training-step-metrics?"))).toBe(true);
    const events = JSON.parse(resource.resolvedOutputs["__events__"]!);
    // An empty user_id means "initiated by the system".
    expect(events[0].userId).toBe("system");
    const metrics = JSON.parse(resource.resolvedOutputs["__stepMetrics__"]!);
    expect(metrics[0]).toEqual({ step: 1, createdAt: "", metrics: { loss: 0.25 } });
  });
});

describe("resolveOutput", () => {
  it("answers the model endpoint without a network call", async () => {
    installFetch(() => jsonResponse({}));
    const value = await client().resolveOutput("model", `${ACCOUNT}:model:m`, "endpoint", ACCOUNT);
    expect(value).toBe("https://api.cohere.com");
    expect(calls).toHaveLength(0);
  });

  it("resolves a dataset id from the resource", async () => {
    installFetch(() => jsonResponse({ datasets: [{ id: "d1", name: "one" }] }));
    const value = await client().resolveOutput(
      "dataset",
      `${ACCOUNT}:dataset:d1`,
      "datasetId",
      ACCOUNT,
    );
    expect(value).toBe("d1");
  });

  it("throws for an output it does not own", async () => {
    installFetch(() => jsonResponse({ models: [{ name: "m" }] }));
    await expect(
      client().resolveOutput("model", `${ACCOUNT}:model:m`, "nonsense", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("deleteResource", () => {
  it("deletes a dataset", async () => {
    installFetch(() => jsonResponse({}));
    await client().deleteResource("dataset", `${ACCOUNT}:dataset:d1`, ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/datasets/d1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("deletes a fine-tuned model on the v1 path", async () => {
    installFetch(() => jsonResponse({}));
    await client().deleteResource("finetuned-model", `${ACCOUNT}:finetuned-model:ft1`, ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/finetuning/finetuned-models/ft1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("refuses to delete things Cohere cannot delete", async () => {
    await expect(
      client().deleteResource("model", `${ACCOUNT}:model:command`, ACCOUNT),
    ).rejects.toThrow(/cannot delete/);
    await expect(client().deleteResource("batch", `${ACCOUNT}:batch:b1`, ACCOUNT)).rejects.toThrow(
      /cannot delete/,
    );
  });
});

describe("invokeAction — cancel", () => {
  it("cancels an embed job with the v1 slash path", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction("embed-job", `${ACCOUNT}:embed-job:j1`, "cancel", ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/embed-jobs/j1/cancel");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("cancels a batch with the v2 colon verb", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction("batch", `${ACCOUNT}:batch:b1`, "cancel", ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.cohere.com/v2/batches/b1:cancel");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("rejects an unknown action", async () => {
    await expect(
      client().invokeAction("batch", `${ACCOUNT}:batch:b1`, "explode", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("transcribeAudio", () => {
  const wavBytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);
  const wavBase64 = Buffer.from(wavBytes).toString("base64");

  it("POSTs multipart to the v2 path with model, language and file", async () => {
    installFetch(() => jsonResponse({ text: "hello world" }));

    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64: wavBase64,
      mimeType: "audio/wav",
      fileName: "clip.wav",
      language: "fr",
    });

    const call = calls[0]!;
    expect(call.url).toBe("https://api.cohere.com/v2/audio/transcriptions");
    expect(call.init?.method).toBe("POST");
    expect(headerOf(call.init, "Content-Type")).toMatch(/^multipart\/form-data; boundary=/);

    const body = Buffer.from(call.init!.body as Uint8Array).toString("binary");
    expect(body).toContain('name="model"\r\n\r\ncohere-transcribe-03-2026');
    expect(body).toContain('name="language"\r\n\r\nfr');
    expect(body).toContain('name="file"; filename="clip.wav"');
    expect(body).toContain("Content-Type: audio/wav");

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("fr");
    // Cohere returns only `{ text }` — no timings to report.
    expect(result.words).toBeUndefined();
    expect(result.durationSeconds).toBeUndefined();
  });

  it("round-trips the audio bytes through base64 without corruption", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    const payloadBytes = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f]);

    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64: Buffer.from(payloadBytes).toString("base64"),
      mimeType: "audio/wav",
      fileName: "clip.wav",
    });

    const body = new Uint8Array(calls[0]!.init!.body as Uint8Array);
    const marker = Buffer.from("audio/wav\r\n\r\n", "binary");
    const start = Buffer.from(body).indexOf(marker) + marker.length;
    expect(Array.from(body.subarray(start, start + payloadBytes.length))).toEqual(
      Array.from(payloadBytes),
    );
  });

  it("defaults language to en because the API requires the field", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64: wavBase64,
      mimeType: "audio/wav",
    });

    const body = Buffer.from(calls[0]!.init!.body as Uint8Array).toString("binary");
    expect(body).toContain('name="language"\r\n\r\nen');
  });

  it("honours a model chosen in the picker", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64: wavBase64,
      mimeType: "audio/wav",
      modelId: "cohere-transcribe-99-2027",
    });

    const body = Buffer.from(calls[0]!.init!.body as Uint8Array).toString("binary");
    expect(body).toContain('name="model"\r\n\r\ncohere-transcribe-99-2027');
  });

  it("rejects browser recording formats with an actionable message", async () => {
    installFetch(() => jsonResponse({ text: "" }));

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: wavBase64,
        mimeType: "audio/webm;codecs=opus",
      }),
    ).rejects.toThrow(/WebM on Chrome/);

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: wavBase64,
        mimeType: "audio/mp4",
      }),
    ).rejects.toThrow(/MP4 on Safari/);

    expect(calls).toHaveLength(0);
  });

  it("falls back to the filename extension when the MIME type is generic", async () => {
    installFetch(() => jsonResponse({ text: "ok" }));
    await client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
      audioBase64: wavBase64,
      mimeType: "application/octet-stream",
      fileName: "voice.flac",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses a clip over Cohere's 25 MB cap before hitting the network", async () => {
    installFetch(() => jsonResponse({ text: "" }));
    const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: big,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/at most 25 MB/);
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
});

describe("error surfacing", () => {
  it("includes the vendor, status and path", async () => {
    installFetch(() => jsonResponse("rate limited", 429));
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow(
      /Cohere API error 429 for \/v1\/models/,
    );
  });
});
