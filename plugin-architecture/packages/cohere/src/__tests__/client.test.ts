import { hostClient } from "@infrawrench/plugin-base/effect";
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
  return hostClient(new CohereClient({ apiKey: "test-key" }));
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
    expect(() => hostClient(new CohereClient({}))).toThrow(/missing apiKey/);
  });
});

describe("auth and base URL", () => {
  it("hits api.cohere.com with a Bearer token and X-Client-Name", async () => {
    installFetch(() => jsonResponse({ models: [] }));
    await client().listResources("model", ACCOUNT);

    const call = calls[0]!;
    expect(call.url.startsWith("https://api.cohere.com/")).toBe(true);
    // Not api.cohere.ai: that host only survives on stale pages.
    expect(call.url).not.toContain("api.cohere.ai");
    expect(headerOf(call.init, "Authorization")).toBe("Bearer test-key");
    expect(headerOf(call.init, "X-Client-Name")).toBe("infrawrench");
  });
});

describe("host transport and the CA certificate", () => {
  const clip = {
    audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
    mimeType: "audio/wav",
    fileName: "clip.wav",
    language: "en",
  };

  function hostedRequest() {
    return vi.fn(async (_req: { url: string; caCert?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ models: [], text: "hi" }),
    }));
  }

  it("hands the certificate to the host on JSON and multipart calls", async () => {
    const request = hostedRequest();
    const fetchSpy = installFetch(() => jsonResponse({}));
    const hosted = hostClient(
      new CohereClient({ apiKey: "k", caCert: "PEM" }, { http: { request } }),
    );

    await hosted.listResources("model", ACCOUNT);
    await hosted.transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, clip);

    expect(request.mock.calls.map(([req]) => req.caCert)).toEqual(["PEM", "PEM"]);
    expect(request.mock.calls[1]![0].url).toContain("/v2/audio/transcriptions");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends no caCert when none is set, and never falls back to fetch", async () => {
    const request = hostedRequest();
    const fetchSpy = installFetch(() => jsonResponse({}));
    const hosted = hostClient(new CohereClient({ apiKey: "k" }, { http: { request } }));

    await hosted.listResources("model", ACCOUNT);
    await hosted.transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, clip);

    expect(request).toHaveBeenCalledTimes(2);
    for (const [req] of request.mock.calls) expect(req).not.toHaveProperty("caCert");
    expect(fetchSpy).not.toHaveBeenCalled();
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

describe("list reads the sync prunes from", () => {
  /** Answers every request with a full page and more to come. */
  function endless(key: string, rows: number, idField = "id") {
    let served = 0;
    installFetch(() => {
      served += 1;
      const items = Array.from({ length: rows }, (_, i) => ({
        [idField]: `r${served}-${i}`,
      }));
      return jsonResponse({ [key]: items, next_page_token: `tok${served}` });
    });
  }

  it.each([
    ["model", "models", 1000, "name", 20],
    ["batch", "batches", 1000, "id", 20],
    ["finetuned-model", "finetuned_models", 100, "id", 100],
    ["dataset", "datasets", 100, "id", 100],
  ])("%s throws once it reaches its cap with more to read", async (type, key, size, id, pages) => {
    endless(key, size, id);
    await expect(client().listResources(type, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(pages);
  });

  it("reads fine-tunes and datasets past the old 2,000 row caps", async () => {
    let page = 0;
    installFetch(() => {
      page += 1;
      const rows = Array.from({ length: 100 }, (_, i) => ({ id: `f${page}-${i}` }));
      return jsonResponse({
        finetuned_models: rows,
        next_page_token: page < 21 ? `tok${page}` : "",
      });
    });
    expect(await client().listResources("finetuned-model", ACCOUNT)).toHaveLength(2100);

    page = 0;
    calls = [];
    vi.restoreAllMocks();
    installFetch(() => {
      page += 1;
      const size = page < 21 ? 100 : 1;
      return jsonResponse({
        datasets: Array.from({ length: size }, (_, i) => ({ id: `d${page}-${i}` })),
      });
    });
    expect(await client().listResources("dataset", ACCOUNT)).toHaveLength(2001);
    expect(calls[20]!.url).toContain("offset=2000");
  });

  it("follows a token past an empty page, because the token is what ends a list", async () => {
    let page = 0;
    installFetch(() => {
      page += 1;
      if (page === 1) return jsonResponse({ batches: [], next_page_token: "tok" });
      return jsonResponse({ batches: [{ id: "b1" }] });
    });
    const batches = await client().listResources("batch", ACCOUNT);
    expect(batches.map((b) => b.externalId)).toEqual(["b1"]);
  });

  it("refuses a models answer with no list, the one key the document requires", async () => {
    installFetch(() => jsonResponse({ data: [{ name: "a" }] }));
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses a later page that stops being a list", async () => {
    let page = 0;
    installFetch(() => {
      page += 1;
      return page === 1
        ? jsonResponse({ models: [{ name: "a" }], next_page_token: "tok" })
        : jsonResponse({ data: [{ name: "b" }] });
    });
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([
    ["batch", "batches"],
    ["finetuned-model", "finetuned_models"],
    ["dataset", "datasets"],
    ["embed-job", "embed_jobs"],
  ])(
    "%s reads a left out key as none, and a key that is not a list as a failure",
    async (type, key) => {
      installFetch(() => jsonResponse({}));
      expect(await client().listResources(type, ACCOUNT)).toEqual([]);

      vi.restoreAllMocks();
      installFetch(() => jsonResponse({ [key]: { message: "busy" } }));
      await expect(client().listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    },
  );

  it("still offers what it read in a picker when a list runs past its cap", async () => {
    let served = 0;
    installFetch((url) => {
      served += 1;
      if (url.includes("/v1/models")) {
        return jsonResponse({
          models: [{ name: `m${served}`, endpoints: ["embed"] }],
          next_page_token: `tok${served}`,
        });
      }
      return jsonResponse({ datasets: [] });
    });
    const config = await client().getCreateConfig("embed-job");
    const model = config.fields.find((f) => f.key === "model");
    expect(model?.options?.length).toBe(20);
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
    // Discovered by name prefix (there is no `transcribe` value in the
    // CompatibleEndpoint enum to filter on) and the deprecated one is dropped.
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

describe("fine-tune events and training metrics", () => {
  const FINETUNE = `${ACCOUNT}:finetuned-model:ft1`;
  const tab = (detail: { customTabs?: Array<{ id: string }> }, id: string) =>
    JSON.stringify(detail.customTabs!.find((t) => t.id === id));

  /** Answers the fine-tune list, and hands the two history routes to `history`. */
  function installHistory(history: (url: string, route: "events" | "metrics") => Response) {
    installFetch((url) => {
      if (url.includes("/events")) return history(url, "events");
      if (url.includes("/training-step-metrics")) return history(url, "metrics");
      return jsonResponse({ finetuned_models: [{ id: "ft1", name: "mine" }] });
    });
  }

  const urlsOf = (route: string) => calls.map((c) => c.url).filter((u) => u.includes(route));

  it("reads every page of both, at the sizes it has always asked for", async () => {
    installHistory((url, route) => {
      const key = route === "events" ? "events" : "step_metrics";
      const row = (n: number) =>
        route === "events" ? { status: `S${n}` } : { step_number: n, metrics: { loss: n } };
      return url.includes("page_token=more")
        ? jsonResponse({ [key]: [row(2)], next_page_token: "" })
        : jsonResponse({ [key]: [row(1)], next_page_token: "more" });
    });

    const resource = await client().getResource("finetuned-model", FINETUNE, ACCOUNT);

    const events = JSON.parse(resource.resolvedOutputs["__events__"]!);
    expect(events.map((e: { status: string }) => e.status)).toEqual(["S1", "S2"]);
    const metrics = JSON.parse(resource.resolvedOutputs["__stepMetrics__"]!);
    expect(metrics.map((m: { step: number }) => m.step)).toEqual([1, 2]);

    expect(urlsOf("/events")[0]).toContain("page_size=50");
    expect(urlsOf("/events")[1]).toContain("page_token=more");
    expect(urlsOf("/training-step-metrics")[0]).toContain("page_size=100");
    expect(urlsOf("/training-step-metrics")[1]).toContain("page_token=more");

    const detail = client().renderDetail(resource);
    expect(tab(detail, "events")).not.toContain("more than Infrawrench reads");
    expect(tab(detail, "training-metrics")).not.toContain("more than Infrawrench reads");
  });

  it("keeps what it read at the cap, and says there is more", async () => {
    let served = 0;
    installHistory((_url, route) => {
      served += 1;
      return route === "events"
        ? jsonResponse({ events: [{ status: `S${served}` }], next_page_token: `t${served}` })
        : jsonResponse({
            step_metrics: [{ step_number: served, metrics: { loss: 1 } }],
            next_page_token: `t${served}`,
          });
    });

    const resource = await client().getResource("finetuned-model", FINETUNE, ACCOUNT);

    // 10,000 rows at each route's page size.
    expect(urlsOf("/events")).toHaveLength(200);
    expect(urlsOf("/training-step-metrics")).toHaveLength(100);
    expect(JSON.parse(resource.resolvedOutputs["__events__"]!)).toHaveLength(200);
    expect(JSON.parse(resource.resolvedOutputs["__stepMetrics__"]!)).toHaveLength(100);

    const detail = client().renderDetail(resource);
    expect(tab(detail, "events")).toContain("Showing 200 events");
    expect(tab(detail, "training-metrics")).toContain("Showing 100 steps");
  });

  it("says a failed read failed, rather than that there is no history", async () => {
    installHistory((url, route) => {
      if (route === "metrics") return jsonResponse("boom", 500);
      return url.includes("page_token=more")
        ? jsonResponse("boom", 429)
        : jsonResponse({ events: [{ status: "S1" }], next_page_token: "more" });
    });

    const resource = await client().getResource("finetuned-model", FINETUNE, ACCOUNT);
    const detail = client().renderDetail(resource);

    expect(tab(detail, "events")).toContain("could not be read");
    expect(tab(detail, "events")).not.toContain("No events reported");
    expect(tab(detail, "training-metrics")).toContain("could not be read");
    expect(tab(detail, "training-metrics")).not.toContain("No training-step metrics");
  });

  it("still says so when a fine-tune really has no history", async () => {
    installHistory(() => jsonResponse({}));
    const resource = await client().getResource("finetuned-model", FINETUNE, ACCOUNT);
    const detail = client().renderDetail(resource);
    expect(tab(detail, "events")).toContain("No events reported");
    expect(tab(detail, "training-metrics")).toContain("No training-step metrics");
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

describe("a blank id", () => {
  it.each([
    ["dataset", `${ACCOUNT}:dataset:`],
    ["finetuned-model", `${ACCOUNT}:finetuned-model:`],
  ])("refuses to delete a %s without sending anything", async (type, id) => {
    installFetch(() => jsonResponse({}));
    await expect(client().deleteResource(type, id, ACCOUNT)).rejects.toThrow(/no id/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["embed-job", `${ACCOUNT}:embed-job:`],
    ["batch", `${ACCOUNT}:batch:`],
  ])("refuses to cancel a %s without sending anything", async (type, id) => {
    installFetch(() => jsonResponse({}));
    await expect(client().invokeAction(type, id, "cancel", ACCOUNT)).rejects.toThrow(/no id/);
    expect(calls).toHaveLength(0);
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
    // Cohere returns only `{ text }`: no timings to report.
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
    ).rejects.toThrow(/browser recordings/);

    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:m`, ACCOUNT, {
        audioBase64: wavBase64,
        mimeType: "audio/mp4",
      }),
    ).rejects.toThrow(/browser recordings/);

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
    ).rejects.toThrow(/over the 25 MB/);
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

describe("create: batches and embed jobs", () => {
  const models = {
    models: [
      { name: "command-a-plus-05-2026", endpoints: ["chat"] },
      { name: "embed-v5.0-pro", endpoints: ["embed"] },
      { name: "embed-english-v2.0", endpoints: ["embed"], is_deprecated: true },
      { name: "rerank-v4.0-pro", endpoints: ["rerank"] },
    ],
    next_page_token: "",
  };
  const datasets = {
    datasets: [
      {
        id: "ds-batch",
        name: "requests",
        dataset_type: "batch-chat-v2-input",
        validation_status: "validated",
      },
      {
        id: "ds-embed",
        name: "corpus",
        dataset_type: "embed-input",
        validation_status: "validated",
      },
      {
        id: "ds-pending",
        name: "pending",
        dataset_type: "embed-input",
        validation_status: "processing",
      },
    ],
  };

  function routes(url: string): Response {
    if (url.includes("/v1/models")) return jsonResponse(models);
    if (url.includes("/v1/datasets")) return jsonResponse(datasets);
    throw new Error(`unrouted: ${url}`);
  }

  it("offers only validated datasets of the right type and live, non-deprecated models", async () => {
    installFetch(routes);
    const c = client();

    const batch = await c.getCreateConfig("batch");
    const batchField = (key: string) => batch.fields.find((f) => f.key === key)!;
    expect(batchField("inputDatasetId").options?.map((o) => o.id)).toEqual(["ds-batch"]);
    expect(batchField("model").options?.map((o) => o.id)).toEqual([
      "command-a-plus-05-2026",
      "embed-v5.0-pro",
    ]);

    const embed = await c.getCreateConfig("embed-job");
    const embedField = (key: string) => embed.fields.find((f) => f.key === key)!;
    expect(embedField("datasetId").options?.map((o) => o.id)).toEqual(["ds-embed"]);
    expect(embedField("model").options?.map((o) => o.id)).toEqual(["embed-v5.0-pro"]);
    expect(embedField("inputType").defaultValue).toBe("search_document");
  });

  it("creates a batch on the v2 path and maps the returned batch", async () => {
    installFetch(() =>
      jsonResponse({
        batch: {
          id: "b-1",
          name: "nightly",
          model: "command-a-plus-05-2026",
          input_dataset_id: "ds-batch",
          status: "BATCH_STATUS_QUEUED",
        },
      }),
    );
    const created = await client().createResource("batch", ACCOUNT, {
      name: "nightly",
      inputDatasetId: "ds-batch",
      model: "command-a-plus-05-2026",
    });
    expect(calls[0]!.url).toBe("https://api.cohere.com/v2/batches");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      name: "nightly",
      input_dataset_id: "ds-batch",
      model: "command-a-plus-05-2026",
    });
    expect(created.id).toBe(`${ACCOUNT}:batch:b-1`);
    expect(created.fields["status"]).toBe("BATCH_STATUS_QUEUED");
  });

  it("creates an embed job on v1 and reads it back by id", async () => {
    installFetch((url, init) => {
      if (init?.method === "POST") return jsonResponse({ job_id: "ej-1" });
      if (url.endsWith("/v1/embed-jobs/ej-1")) {
        return jsonResponse({
          job_id: "ej-1",
          name: "index",
          status: "processing",
          model: "embed-v5.0-pro",
          input_dataset_id: "ds-embed",
          truncate: "END",
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const created = await client().createResource("embed-job", ACCOUNT, {
      name: "index",
      datasetId: "ds-embed",
      model: "embed-v5.0-pro",
      inputType: "search_document",
      embeddingType: "int8",
      truncate: "END",
    });
    expect(calls[0]!.url).toBe("https://api.cohere.com/v1/embed-jobs");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      model: "embed-v5.0-pro",
      dataset_id: "ds-embed",
      input_type: "search_document",
      name: "index",
      embedding_types: ["int8"],
      truncate: "END",
    });
    expect(created.id).toBe(`${ACCOUNT}:embed-job:ej-1`);
    expect(created.fields["status"]).toBe("processing");
  });

  it("refuses a batch without a dataset before calling the API", async () => {
    const spy = installFetch(() => jsonResponse({}));
    await expect(
      client().createResource("batch", ACCOUNT, { name: "x", model: "m" }),
    ).rejects.toThrow(/input dataset/);
    expect(spy).not.toHaveBeenCalled();
  });
});
