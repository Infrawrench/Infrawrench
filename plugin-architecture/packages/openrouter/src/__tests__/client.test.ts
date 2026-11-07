import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostSetupError, type HostServices } from "@infrawrench/plugin-base";
import { OpenRouterClient } from "../client.js";

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
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function binaryResponse(bytes: Uint8Array, contentType = "audio/mpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
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

function client(withInferenceKey = true) {
  return hostClient(
    new OpenRouterClient({
      managementKey: "sk-or-v1-management",
      ...(withInferenceKey ? { apiKey: "sk-or-v1-inference" } : {}),
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("requires a management key", () => {
    expect(() => hostClient(new OpenRouterClient({}))).toThrow(
      /management key or an inference API key/,
    );
  });

  it("works with only a management key", () => {
    expect(() => client(false)).not.toThrow();
  });
});

describe("listResources", () => {
  it("asks for every modality and normalises prices to per-million tokens", async () => {
    installFetch((url) => {
      expect(url).toContain("output_modalities=all");
      expect(url).toContain("limit=1000");
      expect(url).toContain("offset=0");
      return jsonResponse({
        data: [
          {
            id: "openai/gpt-4",
            name: "GPT-4",
            canonical_slug: "openai/gpt-4",
            context_length: 8192,
            architecture: {
              modality: "text->text",
              input_modalities: ["text"],
              output_modalities: ["text"],
              tokenizer: "GPT",
            },
            pricing: { prompt: "0.00003", completion: "0.00006", image: "0", request: "0" },
            top_provider: { context_length: 8192, max_completion_tokens: 4096, is_moderated: true },
          },
        ],
        total_count: 1,
      });
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields["promptPricePerMillion"]).toBeCloseTo(30);
    expect(rows[0]?.fields["completionPricePerMillion"]).toBeCloseTo(60);
    expect(rows[0]?.fields["author"]).toBe("openai");
    expect(rows[0]?.id).toBe(`${ACCOUNT}:model:openai/gpt-4`);
  });

  it("pages models with offset+limit rather than a cursor", async () => {
    let page = 0;
    installFetch((url) => {
      page++;
      if (page === 1) {
        expect(url).toContain("offset=0");
        return jsonResponse({
          data: Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })),
        });
      }
      if (page === 3) return jsonResponse({ data: [] });
      expect(url).toContain("offset=1000");
      return jsonResponse({ data: [{ id: "a/last" }] });
    });

    const rows = await client().listResources("model", ACCOUNT);
    expect(rows).toHaveLength(1001);
    expect(rows[1000]?.externalId).toBe("a/last");
  });

  it("sends the management key as the bearer token", async () => {
    installFetch(() => jsonResponse({ data: [] }));
    await client().listResources("provider", ACCOUNT);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/providers");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer sk-or-v1-management");
  });

  it("caps the model-endpoint fan-out to the most popular models", async () => {
    installFetch((url) => {
      if (url.includes("/models?")) {
        expect(url).toContain("limit=25");
        expect(url).toContain("sort=most-popular");
        return jsonResponse({ data: [{ id: "openai/gpt-4" }] });
      }
      if (url.endsWith("/models/openai/gpt-4/endpoints")) {
        return jsonResponse({
          data: {
            endpoints: [
              {
                name: "OpenAI | openai/gpt-4",
                provider_name: "OpenAI",
                context_length: 8192,
                pricing: { prompt: "0.00003", completion: "0.00006" },
                uptime_last_1d: 0.999,
                latency_last_30m: { p50: 420, p75: 600, p90: 900, p99: 1800 },
                throughput_last_30m: { p50: 58.2, p90: 91.4 },
                status: 0,
              },
            ],
          },
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const rows = await client().listResources("model-endpoint", ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("openai/gpt-4|OpenAI | openai/gpt-4");
    expect(rows[0]?.parentResourceId).toBe(`${ACCOUNT}:model:openai/gpt-4`);
    expect(rows[0]?.fields["latencyP99"]).toBe(1800);
    expect(rows[0]?.fields["throughputP50"]).toBe(58.2);
    expect(rows[0]?.fields["status"]).toBe("healthy");
  });

  it("fails the endpoint list when one model's read fails, so a sync prunes nothing", async () => {
    installFetch((url) => {
      if (url.includes("/models?")) return jsonResponse({ data: [{ id: "a/b" }, { id: "a/c" }] });
      if (url.endsWith("/models/a/b/endpoints")) {
        return jsonResponse({ data: { endpoints: [{ name: "One" }] } });
      }
      return jsonResponse({ error: "busy" }, 429);
    });
    await expect(client().listResources("model-endpoint", ACCOUNT)).rejects.toThrow("429");
  });

  it("refuses an endpoints answer with its list renamed", async () => {
    installFetch((url) =>
      url.includes("/models?")
        ? jsonResponse({ data: [{ id: "a/b" }] })
        : jsonResponse({ data: { items: [] } }),
    );
    await expect(client().listResources("model-endpoint", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads a model the endpoints route no longer knows as having none", async () => {
    installFetch((url) => {
      if (url.includes("/models?")) return jsonResponse({ data: [{ id: "a/b" }, { id: "a/c" }] });
      if (url.endsWith("/models/a/b/endpoints")) {
        return jsonResponse({ data: { endpoints: [{ name: "One" }] } });
      }
      return jsonResponse({ error: "gone" }, 404);
    });
    const rows = await client().listResources("model-endpoint", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["a/b|One"]);
  });

  it("lists API keys including disabled ones", async () => {
    installFetch((url) => {
      if (url.includes("/workspaces")) return jsonResponse({ data: [], total_count: 0 });
      expect(url).toContain("include_disabled=true");
      if (!url.includes("offset=0")) return jsonResponse({ data: [] });
      return jsonResponse({
        data: [
          {
            hash: "f01d",
            name: "Prod",
            disabled: false,
            limit: 100,
            limit_remaining: 74.5,
            limit_reset: "monthly",
            usage: 25.5,
          },
        ],
      });
    });

    const rows = await client().listResources("api-key", ACCOUNT);
    expect(rows[0]?.fields["limitReset"]).toBe("monthly");
    expect(rows[0]?.fields["limitRemaining"]).toBe(74.5);
    expect(calls[0]?.url).toContain("offset=0");
  });

  it("reads API keys to an empty page, whatever size the pages are", async () => {
    // The document gives no page size for GET /keys, so a short page does not end it.
    installFetch((url) => {
      if (url.includes("/workspaces")) return jsonResponse({ data: [], total_count: 0 });
      const offset = new URL(url).searchParams.get("offset");
      if (offset === "0") return jsonResponse({ data: [{ hash: "a" }, { hash: "b" }] });
      if (offset === "2") return jsonResponse({ data: [{ hash: "c" }] });
      return jsonResponse({ data: [] });
    });
    const rows = await client().listResources("api-key", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["a", "b", "c"]);
    expect(new URL(calls[2]!.url).searchParams.get("offset")).toBe("3");
  });

  it("refuses a model catalogue longer than it reads", async () => {
    installFetch(() =>
      jsonResponse({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })) }),
    );
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(20);
  });

  it("refuses an API key list that never ends, after 500 pages", async () => {
    let next = 0;
    installFetch(() => jsonResponse({ data: [{ hash: `k${next++}` }] }));
    await expect(client().listResources("api-key", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(500);
  });

  it.each(["guardrail", "workspace", "byok-credential"])(
    "reads 10,000 rows of %s and refuses more",
    async (typeId) => {
      let next = 0;
      installFetch(() =>
        jsonResponse({
          data: Array.from({ length: 100 }, () => ({ id: `row-${next++}`, name: "x" })),
        }),
      );
      await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(100);
    },
  );

  it("ends a management list on its total_count without another request", async () => {
    installFetch(() =>
      jsonResponse({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, name: "x" })),
        total_count: 100,
      }),
    );
    expect(await client().listResources("workspace", ACCOUNT)).toHaveLength(100);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["model", "/models"],
    ["provider", "/providers"],
    ["api-key", "/keys"],
    ["guardrail", "/guardrails"],
    ["workspace", "/workspaces"],
    ["byok-credential", "/byok"],
    ["model-endpoint", "/models"],
  ])("refuses a %s page with its list renamed", async (typeId) => {
    installFetch(() => jsonResponse({ items: [{ id: "a/b", hash: "h", slug: "s" }] }));
    await expect(client().listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses a later page with its list renamed", async () => {
    installFetch((url) =>
      url.includes("offset=0")
        ? jsonResponse({ data: Array.from({ length: 1000 }, (_, i) => ({ id: `a/m${i}` })) })
        : jsonResponse({ items: [] }),
    );
    await expect(client().listResources("model", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads a list whose total is left out to its empty page", async () => {
    let page = 0;
    installFetch(() => {
      page++;
      return jsonResponse({ data: page === 1 ? [{ id: "w1", name: "x" }] : [] });
    });
    expect(await client().listResources("workspace", ACCOUNT)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("ends the model catalogue on its total_count, not a short page", async () => {
    // A server capping `limit` below 1000 would otherwise end the catalogue on page one.
    installFetch((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return jsonResponse({ data: [{ id: `a/m${offset}` }], total_count: 2 });
    });
    const rows = await client().listResources("model", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["a/m0", "a/m1"]);
  });
});

describe("getResource", () => {
  it("stashes a model's full endpoint list for the synchronous renderer", async () => {
    installFetch((url) => {
      if (url.endsWith("/models/openai/gpt-4/endpoints")) {
        return jsonResponse({
          data: {
            id: "openai/gpt-4",
            name: "GPT-4",
            architecture: { output_modalities: ["text"] },
            endpoints: [{ name: "OpenAI | openai/gpt-4", provider_name: "OpenAI" }],
          },
        });
      }
      if (url.includes("output_modalities=all")) return jsonResponse({ data: [], total_count: 0 });
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource("model", `${ACCOUNT}:model:openai/gpt-4`, ACCOUNT);
    const stashed = JSON.parse(resource.resolvedOutputs["__endpoints__"] ?? "[]");
    expect(stashed).toHaveLength(1);
    expect(resource.resolvedOutputs["__speech__"]).toBeUndefined();
  });

  it("also stashes the speech catalogue for audio models", async () => {
    installFetch((url) => {
      if (url.endsWith("/models/x-ai/grok-voice-tts-1.0/endpoints")) {
        return jsonResponse({
          data: {
            id: "x-ai/grok-voice-tts-1.0",
            architecture: { output_modalities: ["speech"] },
            endpoints: [],
          },
        });
      }
      if (url.includes("output_modalities=all")) return jsonResponse({ data: [], total_count: 0 });
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [{ id: "x-ai/grok-voice-tts-1.0", supported_voices: ["eve", "ara"] }],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const resource = await client().getResource(
      "model",
      `${ACCOUNT}:model:x-ai/grok-voice-tts-1.0`,
      ACCOUNT,
    );
    const speech = JSON.parse(resource.resolvedOutputs["__speech__"] ?? "{}");
    expect(speech.tts?.[0]?.supported_voices).toEqual(["eve", "ara"]);
    expect(speech.stt?.[0]?.id).toBe("openai/whisper-large-v3");
  });

  describe("a model's own fields", () => {
    const catalogueRow = {
      id: "openai/gpt-4",
      name: "GPT-4",
      canonical_slug: "openai/gpt-4-0613",
      context_length: 8192,
      architecture: { modality: "text->text", output_modalities: ["text"], tokenizer: "GPT" },
      pricing: { prompt: "0.00003", completion: "0.00006", image: "0.01", web_search: "0.02" },
      top_provider: { context_length: 8192, max_completion_tokens: 4096, is_moderated: true },
      supported_parameters: ["tools", "seed"],
      supported_voices: null,
      knowledge_cutoff: "2023-04",
      expiration_date: "2027-01-01",
      hugging_face_id: "openai/gpt-4",
    };
    const detail = {
      id: "openai/gpt-4",
      name: "GPT-4",
      created: 1_700_000_000,
      description: "A model.",
      architecture: { modality: "text->text", output_modalities: ["text"] },
      endpoints: [{ name: "OpenAI | openai/gpt-4", provider_name: "OpenAI" }],
    };

    function route(rows: unknown[]) {
      installFetch((url) => {
        if (url.endsWith("/models/openai/gpt-4/endpoints")) return jsonResponse({ data: detail });
        if (url.includes("output_modalities=all")) {
          return jsonResponse({ data: rows, total_count: rows.length });
        }
        throw new Error(`unrouted: ${url}`);
      });
    }

    it("come from the catalogue, which is the only route that has them", async () => {
      route([{ id: "another/model" }, catalogueRow]);
      const resource = await client().getResource(
        "model",
        `${ACCOUNT}:model:openai/gpt-4`,
        ACCOUNT,
      );
      expect(resource.fields).toMatchObject({
        canonicalSlug: "openai/gpt-4-0613",
        contextLength: 8192,
        imagePrice: 0.01,
        webSearchPrice: 0.02,
        supportedParameters: "tools, seed",
        knowledgeCutoff: "2023-04",
        expirationDate: "2027-01-01",
        huggingFaceId: "openai/gpt-4",
        topProviderMaxCompletionTokens: 4096,
        isModerated: true,
      });
      expect(resource.fields["promptPricePerMillion"]).toBeCloseTo(30);
      expect(resource.fields["completionPricePerMillion"]).toBeCloseTo(60);
      expect(JSON.parse(resource.resolvedOutputs["__endpoints__"] ?? "[]")).toHaveLength(1);
    });

    it("reach the dashboard stats", async () => {
      route([catalogueRow]);
      const stats = await client().fetchDashboardStats(
        "model",
        `${ACCOUNT}:model:openai/gpt-4`,
        ACCOUNT,
      );
      expect(stats).toEqual([
        { label: "Context", value: (8192).toLocaleString() },
        { label: "Prompt", value: "$30.00/M" },
        { label: "Completion", value: "$60.00/M" },
      ]);
    });

    it("fall back to the detail answer for a model the catalogue leaves out", async () => {
      route([{ id: "another/model" }]);
      const resource = await client().getResource(
        "model",
        `${ACCOUNT}:model:openai/gpt-4`,
        ACCOUNT,
      );
      expect(resource.fields["description"]).toBe("A model.");
      expect(resource.fields["contextLength"]).toBe(0);
    });

    it("are not replaced with zeros when the catalogue cannot be read", async () => {
      installFetch((url) =>
        url.endsWith("/endpoints")
          ? jsonResponse({ data: detail })
          : jsonResponse({ error: "busy" }, 503),
      );
      await expect(
        client().getResource("model", `${ACCOUNT}:model:openai/gpt-4`, ACCOUNT),
      ).rejects.toThrow("503");
    });
  });

  it("splits a model-endpoint id back into model and endpoint name", async () => {
    installFetch((url) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models/openai/gpt-4/endpoints");
      return jsonResponse({
        data: { endpoints: [{ name: "OpenAI | openai/gpt-4", provider_name: "OpenAI" }] },
      });
    });
    const resource = await client().getResource(
      "model-endpoint",
      `${ACCOUNT}:model-endpoint:openai/gpt-4|OpenAI | openai/gpt-4`,
      ACCOUNT,
    );
    expect(resource.fields["providerName"]).toBe("OpenAI");
  });
});

describe("api key management", () => {
  it("creates a key and surfaces the one-time plaintext", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "CI",
        limit: 50,
        limit_reset: "monthly",
      });
      return jsonResponse({ data: { hash: "h1", name: "CI" }, key: "sk-or-v1-plain" }, 201);
    });

    const created = await client().createResource("api-key", ACCOUNT, {
      name: "CI",
      limit: "50",
      limitReset: "monthly",
    });
    expect(created.resolvedOutputs["apiKey"]).toBe("sk-or-v1-plain");
  });

  it("PATCHes only the changed fields and nulls a cleared limit", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/h1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ disabled: true, limit: null });
      return jsonResponse({ data: { hash: "h1", disabled: true } });
    });

    const updated = await client().updateResource("api-key", `${ACCOUNT}:api-key:h1`, ACCOUNT, {
      disabled: "true",
      limit: "",
    });
    expect(updated.fields["disabled"]).toBe(true);
  });

  it("deletes by hash", async () => {
    installFetch((url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/keys/h1");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ deleted: true });
    });
    await client().deleteResource("api-key", `${ACCOUNT}:api-key:h1`, ACCOUNT);
  });
});

describe("fetchCostData", () => {
  it("turns /activity rows into daily CostRows inside the requested range", async () => {
    installFetch((url) => {
      expect(url).toBe("https://openrouter.ai/api/v1/activity");
      return jsonResponse({
        data: [
          {
            date: "2026-07-20",
            model: "openai/gpt-4.1",
            provider_name: "OpenAI",
            usage: 0.015,
            byok_usage_inference: 0.012,
            requests: 5,
          },
          { date: "2026-06-01", model: "old/model", provider_name: "OpenAI", usage: 9 },
        ],
      });
    });

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-28",
    });
    expect(rows).toEqual([
      {
        date: "2026-07-20",
        service: "OpenAI",
        resourceId: "openai/gpt-4.1",
        currency: "USD",
        amount: 0.027,
        usageAmount: 5,
        usageUnit: "Requests",
        tags: { "ai:provider": "openrouter", "ai:model": "gpt-4-1" },
      },
    ]);
  });

  it("refuses an /activity answer with its list renamed, so no cost rows are replaced", async () => {
    installFetch(() => jsonResponse({ items: [] }));
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-28" }),
    ).rejects.toThrow("is not a list");
  });

  it("raises a CostSetupError when /activity 403s on a non-management key", async () => {
    installFetch(() => jsonResponse({ error: { code: 403 } }, 403));
    await expect(
      client().fetchCostData(ACCOUNT, { fromDate: "2026-07-01", toDate: "2026-07-28" }),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchMetricSeries", () => {
  it("queries the analytics API filtered to the model and its permaslug", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.includes("/models?")) {
        return jsonResponse({
          data: [{ id: "openai/gpt-4.1", canonical_slug: "openai/gpt-4.1-2025-04-14" }],
          total_count: 1,
        });
      }
      if (url.endsWith("/analytics/query")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const metrics = body["metrics"] as string[];
        if (metrics.includes("request_count")) {
          return jsonResponse({
            data: {
              data: [
                {
                  date__day: "2026-07-21T00:00:00.000Z",
                  request_count: "20",
                  total_usage: 2.5,
                  byok_usage: null,
                  cache_hit_rate: 0.25,
                },
                { created_at__day: "2026-07-20", request_count: 10, total_usage: 1.5 },
              ],
              metadata: { query_time_ms: 5, row_count: 2, truncated: false },
            },
          });
        }
        return jsonResponse({
          data: {
            data: [{ date__day: "2026-07-20", p50_latency: 412, p50_throughput: 88.5 }],
            metadata: { query_time_ms: 5, row_count: 1, truncated: false },
          },
        });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:openai/gpt-4.1`,
      ACCOUNT,
      { startMs: Date.parse("2026-07-01T00:00:00Z"), endMs: Date.parse("2026-07-28T00:00:00Z") },
    );

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      granularity: "day",
      filters: [
        { field: "model", operator: "in", value: ["openai/gpt-4.1", "openai/gpt-4.1-2025-04-14"] },
      ],
      time_range: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-28T00:00:00.000Z" },
    });
    expect(bodies[1]?.["metrics"]).toEqual(["p50_latency", "p90_latency", "p50_throughput"]);

    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(byLabel["Requests"]?.points.map((p) => p.value)).toEqual([10, 20]);
    expect(byLabel["Spend"]?.unit).toBe("USD");
    expect(byLabel["Cache hit rate"]?.points).toEqual([
      { timestamp: Date.parse("2026-07-21T00:00:00Z"), value: 25 },
    ]);
    expect(byLabel["Time to first token p50"]?.unit).toBe("ms");
    expect(byLabel["Throughput p50"]?.points[0]?.value).toBe(88.5);
    // Null metrics are skipped, not charted as zero.
    expect(byLabel["BYOK spend"]).toBeUndefined();
  });

  it("skips the latency query beyond 31 days and uses hourly buckets for a week", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.endsWith("/analytics/query")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ data: { data: [], metadata: { row_count: 0, truncated: false } } });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const end = Date.parse("2026-07-28T00:00:00Z");
    await client().fetchMetricSeries("api-key", `${ACCOUNT}:api-key:abc123`, ACCOUNT, {
      startMs: end - 60 * 24 * 60 * 60 * 1000,
      endMs: end,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["filters"]).toEqual([
      { field: "api_key_id", operator: "eq", value: "abc123" },
    ]);

    bodies.length = 0;
    await client().fetchMetricSeries("workspace", `${ACCOUNT}:workspace:ws-1`, ACCOUNT, {
      startMs: end - 7 * 24 * 60 * 60 * 1000,
      endMs: end,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.["granularity"]).toBe("hour");
    expect(bodies[0]?.["filters"]).toEqual([{ field: "workspace", operator: "eq", value: "ws-1" }]);
  });

  it("falls back to /activity for a model when the analytics API refuses the key", async () => {
    installFetch((url) => {
      if (url.endsWith("/analytics/query")) {
        return jsonResponse({ error: { code: 403, message: "forbidden" } }, 403);
      }
      if (url.includes("/models?")) return jsonResponse({ data: [] });
      return jsonResponse({
        data: [
          {
            date: "2026-07-20",
            model: "openai/gpt-4.1",
            usage: 1.5,
            requests: 10,
            prompt_tokens: 100,
          },
          { date: "2026-07-21", model: "openai/gpt-4.1", usage: 2.5, requests: 20 },
          { date: "2026-07-21", model: "other/model", usage: 99, requests: 99 },
        ],
      });
    });

    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:openai/gpt-4.1`,
      ACCOUNT,
      { startMs: Date.parse("2026-07-01T00:00:00Z"), endMs: Date.parse("2026-07-28T00:00:00Z") },
    );
    expect(series.map((s) => s.label)).toEqual(["Spend", "Requests", "Prompt tokens"]);
    expect(series[0]?.points.map((p) => p.value)).toEqual([1.5, 2.5]);
    expect(series[1]?.points.map((p) => p.value)).toEqual([10, 20]);
  });

  it("returns nothing for an API key when the analytics API refuses the key", async () => {
    installFetch(() => jsonResponse({ error: { code: 403, message: "forbidden" } }, 403));
    const series = await client().fetchMetricSeries(
      "api-key",
      `${ACCOUNT}:api-key:abc123`,
      ACCOUNT,
    );
    expect(series).toEqual([]);
  });
});

describe("synthesizeSpeech", () => {
  it("requests mp3, uses the inference key, and base64-encodes the raw bytes", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [
            {
              id: "mistralai/voxtral-mini-tts-2603",
              supported_voices: ["en_paul_neutral", "gb_jane_neutral"],
            },
          ],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-or-v1-inference");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "mistralai/voxtral-mini-tts-2603",
        input: "Hello",
        voice: "gb_jane_neutral",
        response_format: "mp3",
      });
      return binaryResponse(audio);
    });

    const result = await client().synthesizeSpeech(
      "model",
      `${ACCOUNT}:model:mistralai/voxtral-mini-tts-2603`,
      ACCOUNT,
      { text: "Hello", voiceId: "gb_jane_neutral", modelId: "mistralai/voxtral-mini-tts-2603" },
    );
    expect(result.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(audio));
    expect(result.characters).toBe(5);
  });

  it("sends speech through the host's HTTP service, so it reaches a bastion", async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const fetchStub = installFetch((url) => {
      throw new Error(`global fetch reached: ${url}`);
    });
    const request = vi.fn(async (req: { url: string }) => {
      if (req.url.endsWith("/audio/speech")) {
        return {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
          body: "",
          rawBody: audio,
        };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
    });
    const hosted = hostClient(
      new OpenRouterClient({ managementKey: "m", apiKey: "sk-or-v1-inference" }, {
        http: { request },
      } as unknown as HostServices),
    );

    const result = await hosted.synthesizeSpeech("model", `${ACCOUNT}:model:x/tts`, ACCOUNT, {
      text: "Hi",
      voiceId: "eve",
      modelId: "x/tts",
    });

    expect(fetchStub).not.toHaveBeenCalled();
    const speech = request.mock.calls.find(([req]) => req.url.endsWith("/audio/speech"))?.[0];
    expect(speech).toMatchObject({ method: "POST", responseEncoding: "binary" });
    expect(speech).not.toHaveProperty("caCert");
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(Buffer.from(audio));
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("falls back to a valid TTS model when the shared picker holds an STT model", async () => {
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) {
        return jsonResponse({
          data: [{ id: "x-ai/grok-voice-tts-1.0", supported_voices: ["eve"] }],
        });
      }
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(JSON.parse(String(init?.body)).model).toBe("x-ai/grok-voice-tts-1.0");
      expect(JSON.parse(String(init?.body)).voice).toBe("eve");
      return binaryResponse(new Uint8Array([1]));
    });

    await client().synthesizeSpeech("model", `${ACCOUNT}:model:x-ai/grok-voice-tts-1.0`, ACCOUNT, {
      text: "Hi",
      modelId: "openai/whisper-large-v3",
      voiceId: "not-a-real-voice",
    });
  });

  it("refuses to synthesise with only a management key", async () => {
    await expect(
      client(false).synthesizeSpeech("model", `${ACCOUNT}:model:x/tts`, ACCOUNT, { text: "Hi" }),
    ).rejects.toThrow(/inference API key/);
  });
});

describe("transcribeAudio", () => {
  it("posts base64 JSON rather than multipart, with the container derived from the MIME type", async () => {
    const audioBase64 = Buffer.from("webm-bytes").toString("base64");
    installFetch((url, init) => {
      if (url.includes("output_modalities=speech")) return jsonResponse({ data: [] });
      if (url.includes("output_modalities=transcription")) {
        return jsonResponse({ data: [{ id: "openai/whisper-large-v3" }] });
      }
      expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-or-v1-inference");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("openai/whisper-large-v3");
      // The clip already arrives base64: it must go out untouched.
      expect(body.input_audio).toEqual({ data: audioBase64, format: "webm" });
      expect(body.language).toBe("en");
      expect(body.response_format).toBe("verbose_json");
      return jsonResponse({
        text: "hello world",
        language: "english",
        duration: 2.5,
        words: [
          { word: "hello", start: 0, end: 0.4 },
          { word: "world", start: 0.4, end: 0.8, speaker: 1 },
        ],
        usage: { cost: 0.000508, seconds: 2.5 },
      });
    });

    const result = await client().transcribeAudio(
      "model",
      `${ACCOUNT}:model:openai/whisper-large-v3`,
      ACCOUNT,
      { audioBase64, mimeType: "audio/webm;codecs=opus", language: "en" },
    );
    expect(result.text).toBe("hello world");
    expect(result.language).toBe("english");
    expect(result.durationSeconds).toBe(2.5);
    expect(result.words?.[1]).toEqual({
      text: "world",
      start: 0.4,
      end: 0.8,
      speaker: "Speaker 2",
    });
    expect(result.summary).toContain("$0.000508");
  });

  it("retries with the plain json shape when verbose_json is unsupported", async () => {
    let attempt = 0;
    installFetch((url, init) => {
      if (url.includes("output_modalities=")) return jsonResponse({ data: [] });
      attempt++;
      if (attempt === 1) {
        expect(JSON.parse(String(init?.body)).response_format).toBe("verbose_json");
        return jsonResponse("verbose_json unsupported", 400);
      }
      expect(JSON.parse(String(init?.body)).response_format).toBeUndefined();
      return jsonResponse({ text: "plain" });
    });

    const result = await client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/wav",
    });
    expect(result.text).toBe("plain");
    expect(attempt).toBe(2);
  });

  it("omits the language field when the picker is on auto", async () => {
    installFetch((url, init) => {
      if (url.includes("output_modalities=")) return jsonResponse({ data: [] });
      expect(JSON.parse(String(init?.body)).language).toBeUndefined();
      return jsonResponse({ text: "" });
    });
    await client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
      audioBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
      language: "auto",
    });
  });

  it("refuses a clip over the 25 MB host cap", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    await expect(
      client().transcribeAudio("model", `${ACCOUNT}:model:a/b`, ACCOUNT, {
        audioBase64: big,
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(/over the 25 MB limit/);
  });
});

describe("guardrails", () => {
  const guardrail = {
    id: "gr_1",
    name: "Prod policy",
    limit_usd: 50,
    reset_interval: "monthly",
    include_byok_in_budgets: false,
    allowed_providers: ["openai", "anthropic"],
    allowed_models: [],
    enforce_zdr: true,
    content_filter_builtins: [{ slug: "email", action: "redact" }],
    workspace_id: "ws_1",
    created_at: "2026-09-01T00:00:00Z",
  };

  it("lists with offset + limit and flattens the policy lists", async () => {
    installFetch(() => jsonResponse({ data: [guardrail], total_count: 1 }));
    const [resource] = await client().listResources("guardrail", ACCOUNT);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/guardrails?limit=100&offset=0");
    const auth = (calls[0]?.init?.headers as Record<string, string>)["Authorization"];
    expect(auth).toBe("Bearer sk-or-v1-management");
    expect(resource?.fields).toMatchObject({
      allowedProviders: "openai, anthropic",
      allowedModels: "",
      resetInterval: "monthly",
      enforceZdr: true,
      contentFilters: 1,
    });
  });

  it("offers every page of API keys in the create form's key picker", async () => {
    installFetch((url) => {
      if (url.includes("/keys")) {
        const offset = new URL(url).searchParams.get("offset");
        if (offset === "0") return jsonResponse({ data: [{ hash: "h1", name: "one" }] });
        if (offset === "1") return jsonResponse({ data: [{ hash: "h2", name: "two" }] });
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ data: [], total_count: 0 });
    });
    const config = await client().getCreateConfig("guardrail");
    const picker = config.fields.find((field) => field.key === "assignedKeys");
    expect(picker?.policies?.map((policy) => policy.id)).toEqual(["h1", "h2"]);
    const read = calls.filter((call) => call.url.includes("/keys"));
    // Disabled keys cannot be picked, so the picker still leaves them out.
    expect(read.every((call) => !call.url.includes("include_disabled"))).toBe(true);
  });

  it("offers what it read of a key list too long to finish", async () => {
    let next = 0;
    installFetch((url) =>
      url.includes("/keys")
        ? jsonResponse({ data: [{ hash: `h${next++}` }] })
        : jsonResponse({ data: [], total_count: 0 }),
    );
    const config = await client().getCreateConfig("guardrail");
    const picker = config.fields.find((field) => field.key === "assignedKeys");
    expect(picker?.policies).toHaveLength(500);
  });

  it("creates the guardrail, then assigns the picked keys", async () => {
    installFetch((url) =>
      url.endsWith("/assignments/keys")
        ? jsonResponse({ assigned_count: 2 })
        : jsonResponse({ data: guardrail }, 201),
    );
    await client().createResource("guardrail", ACCOUNT, {
      name: "Prod policy",
      limitUsd: "50",
      resetInterval: "monthly",
      allowedProviders: JSON.stringify(["openai", "anthropic"]),
      allowedDataRegions: JSON.stringify(["europe"]),
      enforceZdr: "true",
      workspaceId: "ws_1",
      assignedKeys: JSON.stringify(["hash_a", "hash_b"]),
    });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/guardrails");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Prod policy",
      limit_usd: 50,
      reset_interval: "monthly",
      allowed_providers: ["openai", "anthropic"],
      allowed_data_regions: ["europe"],
      enforce_zdr: true,
      workspace_id: "ws_1",
    });
    expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/guardrails/gr_1/assignments/keys");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      key_hashes: ["hash_a", "hash_b"],
    });
  });

  it("patches only the edited fields, mapping never to a null reset", async () => {
    installFetch((url, init) => {
      if (init?.method === "PATCH") return jsonResponse({ data: guardrail });
      if (url.includes("/assignments/keys")) {
        return jsonResponse({
          data: [{ key_hash: "hash_a", key_name: "ci" }],
          total_count: 1,
        });
      }
      return jsonResponse({ data: guardrail });
    });
    const updated = await client().updateResource(
      "guardrail",
      `${ACCOUNT}:guardrail:gr_1`,
      ACCOUNT,
      {
        resetInterval: "never",
        ignoredModels: "openai/gpt-4o, x-ai/grok-4",
      },
    );
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe("https://openrouter.ai/api/v1/guardrails/gr_1");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      reset_interval: null,
      ignored_models: ["openai/gpt-4o", "x-ai/grok-4"],
    });
    expect(updated.fields["assignedKeys"]).toBe("ci");
  });
});

describe("workspaces", () => {
  const workspace = {
    id: "ws_1",
    name: "Production",
    slug: "production",
    default_provider_sort: null,
    is_observability_io_logging_enabled: false,
    io_logging_sampling_rate: 1,
    created_at: "2026-09-01T00:00:00Z",
  };

  it("loads budgets and the member count on the detail read", async () => {
    installFetch((url) => {
      if (url.endsWith("/budgets")) {
        return jsonResponse({
          data: [
            { limit_usd: 100, reset_interval: "monthly" },
            { limit_usd: 500, reset_interval: null },
          ],
          include_byok_in_budgets: true,
        });
      }
      if (url.includes("/members")) return jsonResponse({ data: [{}], total_count: 7 });
      return jsonResponse({ data: workspace });
    });
    const resource = await client().getResource("workspace", `${ACCOUNT}:workspace:ws_1`, ACCOUNT);
    expect(resource.fields).toMatchObject({
      budgetMonthly: 100,
      budgetLifetime: 500,
      budgetDaily: 0,
      includeByokInBudgets: true,
      memberCount: 7,
      defaultProviderSort: "default",
    });
  });

  it("puts a changed budget and deletes a cleared one", async () => {
    installFetch((url, init) => {
      if (init?.method === "PUT" || init?.method === "DELETE") return jsonResponse({ data: {} });
      if (url.endsWith("/budgets")) return jsonResponse({ data: [] });
      if (url.includes("/members")) return jsonResponse({ data: [], total_count: 0 });
      return jsonResponse({ data: workspace });
    });
    await client().updateResource("workspace", `${ACCOUNT}:workspace:ws_1`, ACCOUNT, {
      budgetWeekly: "25",
      budgetMonthly: "",
      includeByokInBudgets: "true",
    });
    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put?.url).toBe("https://openrouter.ai/api/v1/workspaces/ws_1/budgets/weekly");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      limit_usd: 25,
      include_byok_in_budgets: true,
    });
    const del = calls.find((call) => call.init?.method === "DELETE");
    expect(del?.url).toBe("https://openrouter.ai/api/v1/workspaces/ws_1/budgets/monthly");
    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);
  });
});

describe("BYOK credentials", () => {
  it("creates with the provider and workspace, and never echoes the key", async () => {
    installFetch(() =>
      jsonResponse(
        {
          data: {
            id: "byok_1",
            provider: "anthropic",
            label: "sk-ant-...abcd",
            disabled: false,
            is_fallback: true,
            workspace_id: "ws_1",
            created_at: "2026-09-01T00:00:00Z",
          },
        },
        201,
      ),
    );
    const resource = await client().createResource("byok-credential", ACCOUNT, {
      provider: "anthropic",
      key: "sk-ant-secret",
      workspaceId: "ws_1",
      isFallback: "true",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      provider: "anthropic",
      workspace_id: "ws_1",
      key: "sk-ant-secret",
      is_fallback: true,
    });
    expect(JSON.stringify(resource)).not.toContain("sk-ant-secret");
    expect(resource.fields["isFallback"]).toBe(true);
  });

  it("deletes through /byok/{id}", async () => {
    installFetch(() => jsonResponse({ deleted: true }));
    await client().deleteResource("byok-credential", `${ACCOUNT}:byok-credential:byok_1`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/byok/byok_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("guardrail assignments", () => {
  const assignedText = (detail: ReturnType<OpenRouterClient["renderDetail"]>) =>
    JSON.stringify(detail.sections.find((section) => section.title === "Assigned API keys"));

  it("does not claim none are assigned when the read failed", async () => {
    installFetch((url) =>
      url.includes("/assignments/")
        ? jsonResponse({ error: "busy" }, 503)
        : jsonResponse({ data: { id: "gr_1", name: "Policy" } }),
    );
    const resource = await client().getResource("guardrail", `${ACCOUNT}:guardrail:gr_1`, ACCOUNT);
    const detail = new OpenRouterClient({ managementKey: "m" }).renderDetail(resource);
    expect(assignedText(detail)).not.toContain("No API keys are assigned");
    expect(assignedText(detail)).toContain("Refresh");
  });

  it("says none are assigned when the read found none", async () => {
    installFetch((url) =>
      url.includes("/assignments/")
        ? jsonResponse({ data: [], total_count: 0 })
        : jsonResponse({ data: { id: "gr_1", name: "Policy" } }),
    );
    const resource = await client().getResource("guardrail", `${ACCOUNT}:guardrail:gr_1`, ACCOUNT);
    const detail = new OpenRouterClient({ managementKey: "m" }).renderDetail(resource);
    expect(assignedText(detail)).toContain("No API keys are assigned");
  });
});

describe("a blank resource id", () => {
  const blank = `${ACCOUNT}:api-key:`;

  it.each(["api-key", "guardrail", "workspace", "byok-credential"])(
    "refuses to delete or update %s and sends nothing",
    async (typeId) => {
      installFetch((url) => {
        throw new Error(`reached ${url}`);
      });
      await expect(client().deleteResource(typeId, blank, ACCOUNT)).rejects.toThrow(/no id/);
      await expect(client().updateResource(typeId, blank, ACCOUNT, { name: "x" })).rejects.toThrow(
        /no id/,
      );
      expect(calls).toHaveLength(0);
    },
  );
});

describe("expired API keys", () => {
  const past = "2020-01-01T00:00:00Z";

  it("stay in the inventory", async () => {
    installFetch((url) => {
      if (url.includes("/workspaces")) return jsonResponse({ data: [], total_count: 0 });
      expect(url).toContain("include_expired=true");
      return url.includes("offset=0")
        ? jsonResponse({ data: [{ hash: "old", expires_at: past }] })
        : jsonResponse({ data: [] });
    });
    const rows = await client().listResources("api-key", ACCOUNT);
    expect(rows.map((r) => r.fields["expiresAt"])).toEqual([past]);
  });

  it("read as expired in the detail, the sidebar and the stats", async () => {
    installFetch((url) =>
      url.includes("/credits")
        ? jsonResponse({ data: { total_credits: 1, total_usage: 0 } })
        : jsonResponse({ data: { hash: "old", expires_at: past } }),
    );
    const id = `${ACCOUNT}:api-key:old`;
    const stats = await client().fetchDashboardStats("api-key", id, ACCOUNT);
    expect(stats.find((stat) => stat.label === "Status")).toMatchObject({
      value: "expired",
      variant: "status-degraded",
    });

    const resource = await client().getResource("api-key", id, ACCOUNT);
    const sync = new OpenRouterClient({ managementKey: "m" });
    const detail = sync.renderDetail(resource);
    expect(detail.status).toMatchObject({ status: "degraded" });
    expect(JSON.stringify(detail.sections)).toContain('"Status","value":"Expired"');
    expect(sync.renderSidebarItem(resource).status).toMatchObject({ status: "degraded" });
  });

  it("leaves a key expiring later reading as active", async () => {
    installFetch((url) =>
      url.includes("/credits")
        ? jsonResponse({ data: { total_credits: 1, total_usage: 0 } })
        : jsonResponse({ data: { hash: "new", expires_at: "2999-01-01T00:00:00Z" } }),
    );
    const stats = await client().fetchDashboardStats("api-key", `${ACCOUNT}:api-key:new`, ACCOUNT);
    expect(stats.find((stat) => stat.label === "Status")?.value).toBe("active");
  });

  it("are left out of the guardrail key picker", async () => {
    installFetch((url) => {
      if (url.includes("/keys")) expect(url).not.toContain("include_expired");
      return jsonResponse({ data: [], total_count: 0 });
    });
    await client().getCreateConfig("guardrail");
  });
});

describe("workspaces beyond the default", () => {
  const search = (url: string) => new URL(url).searchParams;

  it.each([
    ["api-key", "/keys", "hash"],
    ["guardrail", "/guardrails", "id"],
    ["byok-credential", "/byok", "id"],
  ])("lists %s from every workspace, each row once", async (typeId, route, idKey) => {
    installFetch((url) => {
      if (url.includes("/workspaces")) {
        return jsonResponse({
          data: [
            { id: "ws_default", name: "Default" },
            { id: "ws_2", name: "Second" },
          ],
          total_count: 2,
        });
      }
      expect(url).toContain(route);
      if (search(url).get("offset") !== "0") return jsonResponse({ data: [], total_count: 1 });
      const workspace = search(url).get("workspace_id");
      const id = workspace === "ws_2" ? "in-second" : "in-default";
      return jsonResponse({ data: [{ [idKey]: id, name: id }], total_count: 1 });
    });
    const rows = await client().listResources(typeId, ACCOUNT);
    expect(rows.map((r) => r.externalId).sort()).toEqual(["in-default", "in-second"]);
    // The read with no workspace still goes first: it is what a narrower key can make.
    expect(search(calls[0]!.url).get("workspace_id")).toBeNull();
  });

  it("keeps the default workspace's rows for a key that cannot list workspaces", async () => {
    installFetch((url) => {
      if (url.includes("/workspaces")) return jsonResponse({ error: "no" }, 403);
      return jsonResponse({ data: [{ id: "g1", name: "g" }], total_count: 1 });
    });
    expect(await client().listResources("guardrail", ACCOUNT)).toHaveLength(1);
  });

  it("skips one workspace the key is refused, and keeps the rest", async () => {
    installFetch((url) => {
      if (url.includes("/workspaces")) {
        return jsonResponse({ data: [{ id: "ws_2", name: "Second" }], total_count: 1 });
      }
      if (search(url).get("workspace_id")) return jsonResponse({ error: "no" }, 403);
      return jsonResponse({ data: [{ id: "g1", name: "g" }], total_count: 1 });
    });
    expect(await client().listResources("guardrail", ACCOUNT)).toHaveLength(1);
  });

  it.each([
    ["the workspace list", (url: string) => url.includes("/workspaces")],
    ["one workspace's list", (url: string) => url.includes("workspace_id=ws_2")],
  ])("fails the sync when %s cannot be read, so nothing is pruned", async (_name, failing) => {
    installFetch((url) => {
      if (failing(url)) return jsonResponse({ error: "busy" }, 503);
      if (url.includes("/workspaces")) {
        return jsonResponse({ data: [{ id: "ws_2", name: "Second" }], total_count: 1 });
      }
      return jsonResponse({ data: [{ id: "g1", name: "g" }], total_count: 1 });
    });
    await expect(client().listResources("guardrail", ACCOUNT)).rejects.toThrow("503");
  });

  it("fails rather than skip the workspaces past 1,000", async () => {
    let next = 0;
    installFetch((url) => {
      if (url.includes("/workspaces")) {
        return jsonResponse({
          data: Array.from({ length: 100 }, () => ({ id: `ws_${next++}`, name: "w" })),
          total_count: 1001,
        });
      }
      return jsonResponse({ data: [], total_count: 0 });
    });
    await expect(client().listResources("guardrail", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("offers keys from every workspace in the guardrail form", async () => {
    installFetch((url) => {
      if (url.includes("/workspaces")) {
        return jsonResponse({ data: [{ id: "ws_2", name: "Second" }], total_count: 1 });
      }
      if (url.includes("/keys") && search(url).get("offset") === "0") {
        const workspace = search(url).get("workspace_id");
        return jsonResponse({ data: [{ hash: workspace ? "in-second" : "in-default" }] });
      }
      return jsonResponse({ data: [], total_count: 0 });
    });
    const config = await client().getCreateConfig("guardrail");
    const picker = config.fields.find((field) => field.key === "assignedKeys");
    expect(picker?.policies?.map((policy) => policy.id)).toEqual(["in-default", "in-second"]);
  });
});

describe("api key workspace", () => {
  it("offers a workspace picker and sends workspace_id on create", async () => {
    installFetch((url, init) => {
      if (url.includes("/workspaces")) {
        return jsonResponse({ data: [{ id: "ws_1", name: "Production" }], total_count: 1 });
      }
      if (init?.method === "POST") {
        return jsonResponse({ data: { hash: "h1", name: "ci", workspace_id: "ws_1" }, key: "sk" });
      }
      return jsonResponse({});
    });
    const config = await client().getCreateConfig("api-key");
    const picker = config.fields.find((field) => field.key === "workspaceId");
    expect(picker?.options?.map((option) => option.id)).toEqual(["", "ws_1"]);

    await client().createResource("api-key", ACCOUNT, { name: "ci", workspaceId: "ws_1" });
    const post = calls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ name: "ci", workspace_id: "ws_1" });
  });
});
