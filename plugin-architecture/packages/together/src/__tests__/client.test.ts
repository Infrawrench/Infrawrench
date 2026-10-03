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

describe("billing usage costs", () => {
  it("walks each month, follows next_cursor, and merges duplicate line items", async () => {
    installFetch((url) => {
      if (url.includes("month=2026-05") && !url.includes("after=")) {
        return jsonResponse({
          object: "list",
          currency: "USD",
          data: [
            {
              date: "2026-05-30",
              line_items: [
                // Before the requested range: dropped.
                { product_name: "Serverless Inference - Input Tokens", cost: "9.00" },
              ],
            },
            {
              date: "2026-05-31",
              line_items: [
                {
                  product_name: "Serverless Inference - Input Tokens",
                  quantity: "1000000",
                  unit_price: "0.00000088",
                  cost: "0.88",
                  pricing_dimensions: { model: "meta/llama" },
                  attributes: { api_key_id: "key-1" },
                },
                {
                  product_name: "Serverless Inference - Input Tokens",
                  cost: "0.12",
                  pricing_dimensions: { model: "meta/llama" },
                  attributes: { api_key_id: "key-1" },
                },
                { product_name: "Zero", cost: "0" },
              ],
            },
          ],
          next_cursor: "cur-2",
        });
      }
      if (url.includes("month=2026-05") && url.includes("after=cur-2")) {
        return jsonResponse({
          data: [{ date: "2026-05-31", line_items: [{ product_name: "GPU Clusters", cost: "5" }] }],
          next_cursor: null,
        });
      }
      if (url.includes("month=2026-06")) {
        return jsonResponse({
          data: [
            { date: "2026-06-01", line_items: [{ product_name: "Fine-tuning", cost: "2.5" }] },
          ],
          next_cursor: null,
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-05-31",
      toDate: "2026-06-01",
    });
    expect(calls[0]?.url).toBe(
      "https://api.together.ai/v1/billing/usage?month=2026-05&granularity=day&limit=1000",
    );
    expect(calls.map((c) => c.url)).toHaveLength(3);
    const inference = rows.find((r) => r.service === "Serverless Inference - Input Tokens");
    expect(inference).toMatchObject({
      date: "2026-05-31",
      resourceId: "meta/llama",
      tags: { model: "meta/llama", api_key_id: "key-1" },
      currency: "USD",
    });
    expect(inference?.amount).toBeCloseTo(1.0);
    expect(rows.find((r) => r.service === "GPU Clusters")?.amount).toBe(5);
    expect(rows.find((r) => r.service === "Fine-tuning")?.date).toBe("2026-06-01");
    expect(rows.some((r) => r.service === "Zero")).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("turns the beta 404 into a setup error rather than a failure", async () => {
    installFetch(() => jsonResponse({ error: { message: "not found", type: "x" } }, 404));
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-01-01", toDate: "2026-01-02" }),
    ).rejects.toMatchObject({ name: "CostSetupError" });
  });
});

describe("managed endpoint analytics", () => {
  it("requests a time series and emits one series per metric key", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/whoami")) return jsonResponse({ project_id: "proj-1" });
      if (url.includes("/analytics")) {
        return jsonResponse({
          timeSeries: [
            { timestamp: "2026-06-01T01:00:00Z", values: { ttftP50Ms: 120, errorRate: 0.5 } },
            { timestamp: "2026-06-01T00:00:00Z", values: { ttftP50Ms: 100, customThing: 3 } },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const start = Date.parse("2026-06-01T00:00:00Z");
    const series = await client().fetchMetricSeries(
      "managed-endpoint",
      `${ACCOUNT}:managed-endpoint:e1`,
      ACCOUNT,
      { startMs: start, endMs: start + 2 * 24 * 60 * 60 * 1000 },
    );
    const url = new URL(calls[1]!.url);
    expect(url.pathname).toBe("/v2/projects/proj-1/endpoints/e1/analytics");
    expect(url.searchParams.get("includeTimeSeries")).toBe("true");
    expect(url.searchParams.get("granularity")).toBe("1h");
    expect(url.searchParams.get("startTime")).toBe("2026-06-01T00:00:00.000Z");

    const ttft = series.find((s) => s.label === "TTFT p50");
    expect(ttft?.unit).toBe("ms");
    expect(ttft?.points.map((p) => p.value)).toEqual([100, 120]);
    expect(series.find((s) => s.label === "Error Rate")?.unit).toBe("%");
    expect(series.find((s) => s.label === "Custom Thing")).toBeDefined();
  });

  it("renders the 24-hour aggregate on the detail page and advertises metrics", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/whoami")) return jsonResponse({ project_id: "proj-1" });
      if (url.includes("/analytics")) {
        expect(url).not.toContain("includeTimeSeries");
        return jsonResponse({
          metrics: {
            requestMetrics: { totalRequests: "12345" },
            latencyMetrics: { ttftP50Ms: 80, ttftP90Ms: 150, ttftP99Ms: 400 },
            errorMetrics: { errorRate: 1.25 },
            resourceUtilization: { gpuUtilization: 72.4 },
            tokenMetrics: { totalInputTokens: "1000", totalOutputTokens: "2000" },
          },
        });
      }
      return jsonResponse({ data: [{ id: "e1", name: "acme/one" }] });
    });
    const c = client();
    const resource = await c.getResource(
      "managed-endpoint",
      `${ACCOUNT}:managed-endpoint:e1`,
      ACCOUNT,
    );
    const detail = c.renderDetail(await c.enrichDetail(resource));
    expect(detail.metricsCapability).toBeDefined();
    const json = JSON.stringify(detail.sections);
    expect(json).toContain("12,345");
    expect(json).toContain("80 ms / 150 ms / 400 ms");
    expect(json).toContain("1.3%");
    expect(json).toContain("72.4%");
  });
});

describe("managed endpoint events", () => {
  it("renders the event feed oldest first as the Logs tab", async () => {
    installFetch((url) => {
      if (url.endsWith("/v1/whoami")) return jsonResponse({ project_id: "proj-1" });
      if (url.includes("/events")) {
        return jsonResponse({
          object: "list",
          data: [
            {
              id: "ev2",
              createdAt: "2026-06-01T00:05:00Z",
              level: "LEVEL_WARN",
              type: "pod.oom",
              source: "worker",
              sourceKind: "SOURCE_KIND_DEPLOYMENT",
              endpointId: "e1",
              deploymentId: "d1",
              message: "Replica ran out of memory",
              logExcerpt: "CUDA out of memory\nretrying",
            },
            {
              id: "ev1",
              createdAt: "2026-06-01T00:00:00Z",
              level: "LEVEL_INFO",
              type: "deployment.scaled",
              source: "autoscaler",
              sourceKind: "SOURCE_KIND_DEPLOYMENT",
              endpointId: "e1",
              deploymentId: "d1",
              oldReplicas: 1,
              newReplicas: 2,
            },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const result = await client().getLogs(
      "managed-endpoint",
      `${ACCOUNT}:managed-endpoint:e1`,
      ACCOUNT,
      { tailLines: 100 },
    );
    const url = new URL(calls[1]!.url);
    expect(url.pathname).toBe("/v2/projects/proj-1/endpoints/e1/events");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(result.text).toBe(
      "2026-06-01T00:00:00Z INFO  deployment.scaled [autoscaler] (deployment=d1, replicas=1->2)\n" +
        "2026-06-01T00:05:00Z WARN  pod.oom [worker] Replica ran out of memory (deployment=d1)\n" +
        "    CUDA out of memory\n    retrying\n",
    );
  });

  it("advertises a Logs tab on managed endpoints only", () => {
    const c = client();
    const base = {
      pluginId: "together",
      accountId: ACCOUNT,
      status: "healthy" as const,
      fields: {},
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    expect(
      c.renderDetail({
        ...base,
        id: `${ACCOUNT}:managed-endpoint:e1`,
        resourceTypeId: "managed-endpoint",
        displayName: "e1",
      }).logs,
    ).toEqual({ defaultTailLines: 500 });
    expect(
      c.renderDetail({
        ...base,
        id: `${ACCOUNT}:endpoint:x`,
        resourceTypeId: "endpoint",
        displayName: "x",
      }).logs,
    ).toBeUndefined();
  });
});

describe("GPU clusters", () => {
  const cluster = {
    cluster_id: "c-1",
    cluster_name: "trainer",
    cluster_type: "KUBERNETES",
    region: "us-central-8",
    gpu_type: "H100_SXM",
    status: "Ready",
    num_gpus: 16,
    billing_type: "ON_DEMAND",
    cuda_version: "12.8",
    nvidia_driver_version: "570",
    kube_config: "apiVersion: v1\nkind: Config",
    volumes: [{ volume_id: "v-1", volume_name: "data", size_tib: 2, status: "bound" }],
    control_plane_nodes: [{ node_id: "cp" }],
    gpu_worker_nodes: [{ node_id: "n1", host_name: "gpu-1", num_gpus: 8, status: "Ready" }],
  };

  it("maps clusters without ever storing the kubeconfig on the listing", async () => {
    installFetch(() => jsonResponse({ clusters: [cluster] }));
    const [item] = await client().listResources("gpu-cluster", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.together.ai/v1/compute/clusters");
    expect(item?.fields).toMatchObject({
      clusterId: "c-1",
      numGpus: 16,
      gpuWorkerCount: 1,
      controlPlaneCount: 1,
      volumeId: "v-1",
    });
    expect(JSON.stringify(item)).not.toContain("kind: Config");
  });

  it("serves the kubeconfig on demand through resolveOutput", async () => {
    installFetch(() => jsonResponse(cluster));
    const value = await client().resolveOutput(
      "gpu-cluster",
      `${ACCOUNT}:gpu-cluster:c-1`,
      "kubeconfig",
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://api.together.ai/v1/compute/clusters/c-1");
    expect(value).toContain("kind: Config");
  });

  it("offers region-scoped driver pickers built from /compute/regions", async () => {
    installFetch((url) => {
      if (url.endsWith("/compute/regions")) {
        return jsonResponse({
          regions: [
            {
              name: "us-central-8",
              supported_instance_types: ["H100_SXM", "H200_SXM"],
              driver_versions: [
                {
                  id: "nv-570",
                  cuda_version: "12.8",
                  nvidia_driver_version: "570",
                  os: "ubuntu-22.04",
                },
              ],
            },
          ],
        });
      }
      return jsonResponse({ volumes: [{ volume_id: "v-1", volume_name: "data", size_tib: 2 }] });
    });
    const config = await client().getCreateConfig("gpu-cluster");
    const byKey = new Map(config.fields.map((field) => [field.key, field]));
    expect(byKey.get("gpu_type")?.options?.map((o) => o.id)).toEqual(["H100_SXM", "H200_SXM"]);
    expect(byKey.get("region")?.regions?.[0]).toMatchObject({
      id: "us-central-8",
      availableFor: ["H100_SXM", "H200_SXM"],
    });
    const driver = byKey.get("nvidia_version_id@us-central-8");
    expect(driver?.options?.[0]?.id).toBe("nv-570");
    expect(driver?.showWhen).toEqual({ fieldKey: "region", fieldValue: "us-central-8" });
    expect(byKey.get("shared_volume")?.options?.map((o) => o.id)).toEqual(["none", "new", "v-1"]);
  });

  it("builds the create body with the region's driver id and an inline volume", async () => {
    installFetch(() => jsonResponse(cluster));
    await client().createResource("gpu-cluster", ACCOUNT, {
      cluster_name: "trainer",
      gpu_type: "H100_SXM",
      region: "us-central-8",
      "nvidia_version_id@us-central-8": "nv-570",
      "nvidia_version_id@eu-north-1": "other",
      num_gpus: "16",
      cluster_type: "SLURM",
      slurm_shm_size_gib: "64",
      billing_type: "RESERVED",
      duration_days: "30",
      shared_volume: "new",
      volume_name: "data",
      volume_size_tib: "2",
    });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      cluster_name: "trainer",
      region: "us-central-8",
      gpu_type: "H100_SXM",
      num_gpus: 16,
      cluster_type: "SLURM",
      billing_type: "RESERVED",
      nvidia_version_id: "nv-570",
      slurm_shm_size_gib: 64,
      duration_days: 30,
      shared_volume: { volume_name: "data", size_tib: 2, region: "us-central-8" },
    });
  });

  it("rejects a GPU count that is not a multiple of 8 before calling Together", async () => {
    installFetch(() => jsonResponse(cluster));
    await expect(
      client().createResource("gpu-cluster", ACCOUNT, {
        cluster_name: "x",
        gpu_type: "H100_SXM",
        region: "us-central-8",
        "nvidia_version_id@us-central-8": "nv-570",
        num_gpus: "12",
        billing_type: "ON_DEMAND",
      }),
    ).rejects.toThrow(/multiple of 8/);
    expect(calls).toHaveLength(0);
  });

  it("PUTs only the fields that changed", async () => {
    installFetch((_url, init) =>
      jsonResponse(init?.method === "PUT" ? { ...cluster, num_gpus: 24 } : cluster),
    );
    await client().updateResource("gpu-cluster", `${ACCOUNT}:gpu-cluster:c-1`, ACCOUNT, {
      clusterType: "KUBERNETES",
      numGpus: "24",
      desiredPreemptibleGpus: "",
    });
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(put?.url).toBe("https://api.together.ai/v1/compute/clusters/c-1");
    expect(JSON.parse(put!.init!.body as string)).toEqual({ num_gpus: 24 });
  });
});

describe("shared volumes", () => {
  it("resizes by PUT to the collection with the id in the body", async () => {
    installFetch(() => jsonResponse({ volume_id: "v-1", volume_name: "data", size_tib: 4 }));
    const updated = await client().updateResource(
      "shared-volume",
      `${ACCOUNT}:shared-volume:v-1`,
      ACCOUNT,
      { sizeTib: "4" },
    );
    expect(calls[0]?.url).toBe("https://api.together.ai/v1/compute/clusters/storage/volumes");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ volume_id: "v-1", size_tib: 4 });
    expect(updated.fields["sizeTib"]).toBe(4);
  });
});

describe("fine-tune detail", () => {
  it("shows checkpoints and the newest events first", async () => {
    installFetch((url) => {
      if (url.endsWith("/events")) {
        return jsonResponse({
          data: [
            { created_at: "2026-06-01T00:00:00Z", type: "job_start", message: "started" },
            { created_at: "2026-06-01T02:00:00Z", type: "job_complete", message: "done" },
          ],
        });
      }
      if (url.endsWith("/checkpoints")) {
        return jsonResponse({
          data: [{ step: 100, checkpoint_type: "Final", object_name: "acme/tuned-final" }],
        });
      }
      return jsonResponse({ id: "ft-1", status: "completed" });
    });
    const c = client();
    const resource = await c.getResource("fine-tune", `${ACCOUNT}:fine-tune:ft-1`, ACCOUNT);
    const detail = c.renderDetail(await c.enrichDetail(resource));
    const titles = detail.sections.map((section) => section.title);
    expect(titles).toContain("Checkpoints");
    const events = detail.sections.find((section) => section.title === "Events");
    const table = events?.children[0] as { rows: Array<{ cells: Record<string, string> }> };
    expect(table.rows[0]?.cells["message"]).toBe("done");
  });
});
