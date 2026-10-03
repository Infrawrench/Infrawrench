import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplicateClient } from "../client.js";

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
  return new ReplicateClient({ apiToken: "r8_test" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("sends the Bearer scheme, not the legacy Token scheme", async () => {
    installFetch(() => jsonResponse([]));
    await client().listResources("hardware", ACCOUNT);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer r8_test");
  });
});

describe("pagination", () => {
  it("follows the opaque `next` URL verbatim instead of rebuilding a cursor", async () => {
    const nextUrl =
      "https://api.replicate.com/v1/predictions?cursor=cD0yMDIzLTA2LTA2KzIzJTNBNDAlM0EwOC45NjMwMDAlMkIwMCUzQTAw";
    installFetch((url) => {
      if (url === "https://api.replicate.com/v1/predictions") {
        return jsonResponse({ next: nextUrl, results: [{ id: "p1", status: "succeeded" }] });
      }
      if (url === nextUrl) {
        return jsonResponse({ next: null, results: [{ id: "p2", status: "failed" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const items = await client().listResources("prediction", ACCOUNT);
    expect(calls.map((c) => c.url)).toEqual(["https://api.replicate.com/v1/predictions", nextUrl]);
    expect(items.map((i) => i.externalId)).toEqual(["p1", "p2"]);
  });
});

describe("prediction status mapping", () => {
  it("keeps `aborted` distinct from `canceled`", async () => {
    installFetch((url) => {
      if (url.endsWith("/predictions/aborted-one")) {
        return jsonResponse({ id: "aborted-one", status: "aborted", model: "meta/llama" });
      }
      if (url.endsWith("/predictions/canceled-one")) {
        return jsonResponse({ id: "canceled-one", status: "canceled", model: "meta/llama" });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const c = client();
    const aborted = await c.getResource("prediction", `${ACCOUNT}:prediction:aborted-one`, ACCOUNT);
    const canceled = await c.getResource(
      "prediction",
      `${ACCOUNT}:prediction:canceled-one`,
      ACCOUNT,
    );

    expect(c.renderSidebarItem(aborted).status).toEqual({
      kind: "status-dot",
      status: "degraded",
      label: "Aborted before start",
    });
    expect(c.renderSidebarItem(canceled).status).toEqual({
      kind: "status-dot",
      status: "unknown",
      label: "Canceled",
    });
  });

  it("renders `hidden` versions readably instead of as an opaque id", async () => {
    installFetch(() =>
      jsonResponse({ id: "p1", status: "succeeded", model: "openai/whisper", version: "hidden" }),
    );
    const c = client();
    const resource = await c.getResource("prediction", `${ACCOUNT}:prediction:p1`, ACCOUNT);
    const detail = c.renderDetail(resource);
    const first = detail.sections[0]?.children[0];
    expect(first?.kind).toBe("key-value-list");
    const items = first?.kind === "key-value-list" ? first.items : [];
    expect(items.find((i) => i.key === "Version")?.value).toBe("hidden (official model)");
  });
});

describe("deployments", () => {
  it("resolves the latest version when the user leaves it blank", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/models/stability-ai/sdxl") && init?.method !== "POST") {
        return jsonResponse({
          owner: "stability-ai",
          name: "sdxl",
          latest_version: { id: "ver-abc" },
        });
      }
      if (url.endsWith("/deployments") && init?.method === "POST") {
        return jsonResponse({
          owner: "acme",
          name: "sdxl-prod",
          current_release: {
            number: 1,
            model: "stability-ai/sdxl",
            version: "ver-abc",
            configuration: { hardware: "gpu-a40-large", min_instances: 0, max_instances: 3 },
          },
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const created = await client().createResource("deployment", ACCOUNT, {
      name: "sdxl-prod",
      model: "stability-ai/sdxl",
      version: "",
      hardware: "gpu-a40-large",
      min_instances: "0",
      max_instances: "3",
    });

    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(post!.init!.body as string)).toEqual({
      name: "sdxl-prod",
      model: "stability-ai/sdxl",
      version: "ver-abc",
      hardware: "gpu-a40-large",
      min_instances: 0,
      max_instances: 3,
    });
    expect(created.externalId).toBe("acme/sdxl-prod");
  });

  it("clamps instance counts to Replicate's asymmetric bounds", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/deployments/acme/sdxl-prod") && init?.method === "PATCH") {
        return jsonResponse({
          owner: "acme",
          name: "sdxl-prod",
          current_release: {
            number: 2,
            configuration: { hardware: "gpu-a40-large", min_instances: 5, max_instances: 20 },
          },
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().updateResource("deployment", `${ACCOUNT}:deployment:acme/sdxl-prod`, ACCOUNT, {
      minInstances: "99",
      maxInstances: "99",
    });

    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      min_instances: 5,
      max_instances: 20,
    });
  });
});

describe("cancel", () => {
  it("POSTs the cancel sub-path for predictions and trainings", async () => {
    installFetch(() => jsonResponse({}));
    const c = client();
    await c.invokeAction("prediction", `${ACCOUNT}:prediction:p1`, "cancel", ACCOUNT);
    await c.invokeAction("training", `${ACCOUNT}:training:t1`, "cancel", ACCOUNT);
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      "POST https://api.replicate.com/v1/predictions/p1/cancel",
      "POST https://api.replicate.com/v1/trainings/t1/cancel",
    ]);
  });
});

describe("models", () => {
  it("derives the account's models from deployments, trainings and predictions", async () => {
    installFetch((url) => {
      if (url.endsWith("/account")) return jsonResponse({ type: "user", username: "acme" });
      if (url.endsWith("/deployments")) {
        return jsonResponse({
          results: [{ owner: "acme", name: "d1", current_release: { model: "acme/sdxl-lora" } }],
        });
      }
      if (url.endsWith("/trainings")) {
        return jsonResponse({
          results: [
            {
              id: "t1",
              model: "stability-ai/sdxl",
              input: { destination: "acme/trained" },
              output: { version: "ver-trained" },
            },
          ],
        });
      }
      if (url.endsWith("/predictions")) {
        return jsonResponse({ results: [{ id: "p1", model: "meta/llama-3", version: "hidden" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const models = await client().listResources("model", ACCOUNT);
    // Account-owned models sort first, then everything else alphabetically.
    expect(models.map((m) => m.externalId)).toEqual([
      "acme/sdxl-lora",
      "acme/trained",
      "meta/llama-3",
      "stability-ai/sdxl",
    ]);
    // `"hidden"` is a placeholder, not a real version: it must not leak out.
    const llama = models.find((m) => m.externalId === "meta/llama-3");
    expect(llama?.resolvedOutputs["latestVersion"]).toBe("");
    const trained = models.find((m) => m.externalId === "acme/trained");
    expect(trained?.resolvedOutputs["latestVersion"]).toBe("ver-trained");
  });
});

describe("files", () => {
  it("maps the checksum and the per-object expiry", async () => {
    installFetch(() =>
      jsonResponse({
        id: "file-1",
        content_type: "audio/wav",
        size: 2048,
        checksums: { sha256: "abc123" },
        created_at: "2026-02-21T12:54:18Z",
        expires_at: "2026-02-21T13:54:18Z",
        urls: { get: "https://api.replicate.com/v1/files/file-1/download" },
      }),
    );
    const resource = await client().getResource("file", `${ACCOUNT}:file:file-1`, ACCOUNT);
    expect(resource.fields["sha256"]).toBe("abc123");
    expect(resource.fields["expiresAt"]).toBe("2026-02-21T13:54:18Z");
    expect(resource.resolvedOutputs["fileUrl"]).toBe(
      "https://api.replicate.com/v1/files/file-1/download",
    );
  });

  it("DELETEs the file endpoint", async () => {
    installFetch(() => jsonResponse({}, 204));
    await client().deleteResource("file", `${ACCOUNT}:file:file-1`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.replicate.com/v1/files/file-1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("model management", () => {
  it("creates a model owned by the token's account with picked hardware", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/account")) return jsonResponse({ username: "acme" });
      if (url.endsWith("/models") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ...body, url: "https://replicate.com/acme/detector" }, 201);
      }
      throw new Error(`unrouted: ${url}`);
    });
    const created = await client().createResource("model", ACCOUNT, {
      name: "detector",
      visibility: "private",
      hardware: "gpu-t4",
      description: "Finds hot dogs",
      github_url: "",
    });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      owner: "acme",
      name: "detector",
      visibility: "private",
      hardware: "gpu-t4",
      description: "Finds hot dogs",
    });
    expect(created.externalId).toBe("acme/detector");
  });

  it("offers a hardware picker and pre-fills the owner on the create form", async () => {
    installFetch((url) => {
      if (url.endsWith("/hardware")) {
        return jsonResponse([
          { sku: "gpu-t4", name: "Nvidia T4 GPU" },
          { sku: "cpu", name: "CPU" },
        ]);
      }
      if (url.endsWith("/account")) return jsonResponse({ username: "acme" });
      throw new Error(`unrouted: ${url}`);
    });
    const config = await client().getCreateConfig("model");
    const hardware = config.fields.find((field) => field.key === "hardware");
    expect(hardware?.kind).toBe("select");
    expect(hardware?.defaultValue).toBe("cpu");
    expect(config.fields.find((field) => field.key === "owner")?.defaultValue).toBe("acme");
  });

  it("PATCHes only the editable metadata, translated to the API's keys", async () => {
    installFetch((url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ owner: "acme", name: "detector", description: "new" });
      }
      throw new Error(`unrouted: ${url}`);
    });
    await client().updateResource("model", `${ACCOUNT}:model:acme/detector`, ACCOUNT, {
      description: "new",
      weightsUrl: "https://huggingface.co/acme/detector",
    });
    expect(calls[0]?.url).toBe("https://api.replicate.com/v1/models/acme/detector");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      description: "new",
      weights_url: "https://huggingface.co/acme/detector",
    });
  });

  it("DELETEs models and versions, tolerating the version delete's empty 202", async () => {
    installFetch(
      (url) =>
        ({
          ok: true,
          status: url.includes("/versions/") ? 202 : 204,
          text: async () => "",
        }) as unknown as Response,
    );
    await client().deleteResource("model", `${ACCOUNT}:model:acme/detector`, ACCOUNT);
    await client().deleteResource(
      "model-version",
      `${ACCOUNT}:model-version:acme/detector/abc123`,
      ACCOUNT,
    );
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["DELETE", "https://api.replicate.com/v1/models/acme/detector"],
      ["DELETE", "https://api.replicate.com/v1/models/acme/detector/versions/abc123"],
    ]);
  });

  it("lists versions only for models the account owns, newest marked latest", async () => {
    installFetch((url) => {
      if (url.endsWith("/account")) return jsonResponse({ username: "acme" });
      if (url.endsWith("/deployments")) return jsonResponse({ results: [] });
      if (url.endsWith("/trainings")) {
        return jsonResponse({
          results: [
            {
              id: "t1",
              model: "ostris/flux-dev-lora-trainer",
              version: "trainerv",
              input: { destination: "acme/detector" },
            },
          ],
        });
      }
      if (url.endsWith("/predictions")) return jsonResponse({ results: [] });
      if (url.endsWith("/models/acme/detector/versions")) {
        return jsonResponse({
          results: [
            { id: "v2", created_at: "2026-09-02T00:00:00Z", cog_version: "0.14.0" },
            { id: "v1", created_at: "2026-08-01T00:00:00Z" },
          ],
        });
      }
      throw new Error(`unrouted: ${url}`);
    });
    const versions = await client().listResources("model-version", ACCOUNT);
    expect(versions.map((v) => [v.externalId, v.fields["isLatest"]])).toEqual([
      ["acme/detector/v2", true],
      ["acme/detector/v1", false],
    ]);
    expect(versions[0]?.parentResourceId).toBe(`${ACCOUNT}:model:acme/detector`);
    expect(calls.some((c) => c.url.includes("ostris"))).toBe(false);
  });

  it("serves the README as the model's describe output", async () => {
    installFetch(
      () =>
        ({
          ok: true,
          status: 200,
          text: async () => "# Detector\n\nFinds hot dogs.",
        }) as unknown as Response,
    );
    const readme = await client().describeResource(
      "model",
      `${ACCOUNT}:model:acme/detector`,
      ACCOUNT,
    );
    expect(calls[0]?.url).toBe("https://api.replicate.com/v1/models/acme/detector/readme");
    expect(readme).toBe("# Detector\n\nFinds hot dogs.");
  });
});

describe("trainings", () => {
  it("starts a training on the trainer's latest version with parsed JSON input", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/models/ostris/trainer")) {
        return jsonResponse({ owner: "ostris", name: "trainer", latest_version: { id: "tv1" } });
      }
      if (init?.method === "POST") {
        return jsonResponse(
          { id: "tr1", status: "starting", model: "ostris/trainer", input: { steps: 1000 } },
          201,
        );
      }
      throw new Error(`unrouted: ${url}`);
    });
    const created = await client().createResource("training", ACCOUNT, {
      model: "ostris/trainer",
      destination: "acme/detector",
      input: '{"steps": 1000}',
      webhook: "https://example.com/hook",
      webhook_events_filter: '["completed"]',
    });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(
      "https://api.replicate.com/v1/models/ostris/trainer/versions/tv1/trainings",
    );
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      destination: "acme/detector",
      input: { steps: 1000 },
      webhook: "https://example.com/hook",
      webhook_events_filter: ["completed"],
    });
    expect(created.externalId).toBe("tr1");
  });

  it("rejects training input that is not a JSON object", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().createResource("training", ACCOUNT, {
        model: "ostris/trainer",
        destination: "acme/detector",
        input: "[1, 2]",
      }),
    ).rejects.toThrow(/JSON object/);
    expect(calls).toHaveLength(0);
  });
});

describe("logs and metrics", () => {
  it("tails the log text carried on the prediction", async () => {
    installFetch(() => jsonResponse({ id: "p1", logs: "one\ntwo\nthree\n" }));
    const result = await client().getLogs("prediction", `${ACCOUNT}:prediction:p1`, ACCOUNT, {
      tailLines: 2,
    });
    expect(result.text).toBe("two\nthree\n");
  });

  it("keeps model-specific metrics beyond the two timings", async () => {
    installFetch(() =>
      jsonResponse({
        id: "p1",
        status: "succeeded",
        metrics: {
          predict_time: 1.5,
          total_time: 2,
          input_token_count: 12,
          tokens_per_second: 41.2346,
        },
      }),
    );
    const prediction = await client().getResource(
      "prediction",
      `${ACCOUNT}:prediction:p1`,
      ACCOUNT,
    );
    expect(prediction.fields["metrics"]).toBe("input_token_count=12 · tokens_per_second=41.235");
    const detail = client().renderDetail(prediction);
    expect(detail.logs).toBeDefined();
    expect(detail.sections.some((section) => section.title === "Metrics")).toBe(true);
  });
});

describe("fetchMetricSeries", () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const end = start + 24 * 60 * 60 * 1000;

  it("aggregates predictions for one deployment from the time-filtered list", async () => {
    installFetch(() =>
      jsonResponse({
        next: null,
        results: [
          {
            id: "a",
            model: "acme/sdxl",
            deployment: "acme/prod",
            status: "succeeded",
            created_at: "2026-10-01T01:00:00Z",
            started_at: "2026-10-01T01:00:04Z",
            metrics: { predict_time: 2 },
          },
          {
            id: "b",
            model: "acme/sdxl",
            deployment: "prod",
            status: "failed",
            created_at: "2026-10-01T01:10:00Z",
            started_at: "2026-10-01T01:10:02Z",
            metrics: { predict_time: 4 },
          },
          {
            id: "c",
            model: "acme/sdxl",
            status: "succeeded",
            created_at: "2026-10-01T01:20:00Z",
          },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "deployment",
      `${ACCOUNT}:deployment:acme/prod`,
      ACCOUNT,
      { startMs: start, endMs: end },
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/predictions");
    expect(url.searchParams.get("created_after")).toBe("2026-10-01T00:00:00.000Z");
    expect(url.searchParams.get("created_before")).toBe("2026-10-02T00:00:00.000Z");

    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    const sum = (label: string) =>
      byLabel[label]!.points.reduce((total, point) => total + point.value, 0);
    expect(sum("Predictions")).toBe(2);
    expect(sum("Failed predictions")).toBe(1);
    expect(byLabel["Avg predict time"]!.points).toEqual([
      { timestamp: Date.parse("2026-10-01T01:00:00Z"), value: 3 },
    ]);
    expect(byLabel["Avg queue time"]!.points[0]!.value).toBe(3);
  });

  it("matches models by owner/name and ignores other types", async () => {
    installFetch(() =>
      jsonResponse({
        next: null,
        results: [
          { id: "a", model: "acme/sdxl", status: "succeeded", created_at: "2026-10-01T03:00:00Z" },
          { id: "b", model: "other/llm", status: "succeeded", created_at: "2026-10-01T03:00:00Z" },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:acme/sdxl`,
      ACCOUNT,
      { startMs: start, endMs: end },
    );
    const predictions = series.find((s) => s.label === "Predictions")!;
    expect(predictions.points.reduce((t, p) => t + p.value, 0)).toBe(1);
    expect(await client().fetchMetricSeries("file", `${ACCOUNT}:file:f1`, ACCOUNT)).toEqual([]);
  });

  it("starts the chart at the oldest prediction read when the page cap cuts the walk", async () => {
    let page = 0;
    installFetch(() => {
      page += 1;
      const created = new Date(end - page * 60 * 1000).toISOString();
      return jsonResponse({
        next: `https://api.replicate.com/v1/predictions?cursor=${page}`,
        results: [{ id: `p${page}`, model: "acme/sdxl", status: "succeeded", created_at: created }],
      });
    });
    const series = await client().fetchMetricSeries(
      "model",
      `${ACCOUNT}:model:acme/sdxl`,
      ACCOUNT,
      { startMs: start, endMs: end },
    );
    expect(calls).toHaveLength(20);
    const first = series.find((s) => s.label === "Predictions")!.points[0]!;
    expect(first.timestamp).toBeGreaterThan(end - 60 * 60 * 1000);
  });

  it("declares the Metrics tab on deployments and models", () => {
    const resource = {
      id: `${ACCOUNT}:deployment:acme/prod`,
      pluginId: "replicate",
      resourceTypeId: "deployment",
      accountId: ACCOUNT,
      displayName: "acme/prod",
      fields: { owner: "acme", name: "prod" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    expect(client().renderDetail(resource).metricsCapability).toEqual({
      defaultTimeRangeMs: 24 * 60 * 60 * 1000,
    });
  });
});
