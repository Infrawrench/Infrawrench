import { describe, expect, it, vi } from "vitest";

import { runWorkflow } from "./sandbox.js";
import type { WorkflowHost } from "./host.js";
import type { WorkflowFetchRequest } from "./types.js";

/**
 * The prelude is a source string, so nothing type-checks it — these run a real
 * isolate to prove the `fetch` it builds actually marshals a request and
 * rebuilds a usable Response on the other side.
 */

const utf8ToBase64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

function hostFor(
  fetchImpl: (request: WorkflowFetchRequest) => Promise<{
    status: number;
    statusText: string;
    url: string;
    headers: Record<string, string>;
    bodyBase64: string;
    redirected: boolean;
  }>,
): WorkflowHost {
  return {
    listPlugins: async () => [],
    listMetrics: async () => ({}),
    getMetric: async () => null,
    setMetric: async () => {},
    fetch: fetchImpl,
  } as unknown as WorkflowHost;
}

async function run(source: string, host: WorkflowHost) {
  return runWorkflow({ source, host, interactive: false });
}

describe("fetch in the isolate", () => {
  it("round-trips a JSON GET into a usable response", async () => {
    const seen: WorkflowFetchRequest[] = [];
    const host = hostFor(async (request) => {
      seen.push(request);
      return {
        status: 201,
        statusText: "Created",
        url: request.url,
        headers: { "content-type": "application/json", "x-request-id": "abc123" },
        bodyBase64: utf8ToBase64(JSON.stringify({ name: "prod", replicas: 3 })),
        redirected: false,
      };
    });

    const result = await run(
      [
        'const res = await fetch("https://api.example.com/clusters/prod");',
        "const body = await res.json();",
        "await infra.output({",
        "  ok: res.ok,",
        "  status: res.status,",
        '  contentType: res.headers.get("Content-Type"),',
        '  missing: res.headers.get("x-nope"),',
        "  name: body.name,",
        "  text: (await res.text()).length,",
        "});",
      ].join("\n"),
      host,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      ok: true,
      status: 201,
      // Header lookups are case-insensitive, and a missing header is null.
      contentType: "application/json",
      missing: null,
      name: "prod",
      text: '{"name":"prod","replicas":3}'.length,
    });
    expect(seen[0]).toMatchObject({ method: "GET", url: "https://api.example.com/clusters/prod" });
  });

  it("JSON-encodes a plain-object body and sets content-type", async () => {
    const seen: WorkflowFetchRequest[] = [];
    const host = hostFor(async (request) => {
      seen.push(request);
      return {
        status: 204,
        statusText: "No Content",
        url: request.url,
        headers: {},
        bodyBase64: "",
        redirected: false,
      };
    });

    const result = await run(
      [
        'await fetch("https://hooks.example.com/notify", {',
        '  method: "POST",',
        '  body: { text: "deploy finished" },',
        "});",
      ].join("\n"),
      host,
    );

    expect(result.error).toBeUndefined();
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(Buffer.from(request.bodyBase64!, "base64").toString("utf8")).toBe(
      '{"text":"deploy finished"}',
    );
  });

  it("sends a string body as-is without inventing a content-type", async () => {
    const seen: WorkflowFetchRequest[] = [];
    const host = hostFor(async (request) => {
      seen.push(request);
      return {
        status: 200,
        statusText: "OK",
        url: request.url,
        headers: {},
        bodyBase64: "",
        redirected: false,
      };
    });

    await run(
      [
        'await fetch("https://api.example.com/raw", {',
        '  method: "PUT",',
        '  headers: { "content-type": "text/plain" },',
        '  body: "hello",',
        "});",
      ].join("\n"),
      host,
    );

    const request = seen[0]!;
    expect(request.headers["content-type"]).toBe("text/plain");
    expect(Buffer.from(request.bodyBase64!, "base64").toString("utf8")).toBe("hello");
  });

  it("surfaces a host refusal as a thrown error inside the workflow", async () => {
    const host = hostFor(async () => {
      throw new Error("fetch() failed: 10.0.0.5 is a private address and is not proxied.");
    });

    const result = await run(
      [
        "try {",
        '  await fetch("http://10.0.0.5/admin");',
        '  await infra.output("reached it");',
        "} catch (e) {",
        "  await infra.output(String(e.message));",
        "}",
      ].join("\n"),
      host,
    );

    expect(result.output).toContain("is not proxied");
  });

  it("reads bytes for a binary response", async () => {
    const host = hostFor(async (request) => ({
      status: 200,
      statusText: "OK",
      url: request.url,
      headers: { "content-type": "application/octet-stream" },
      bodyBase64: Buffer.from([0x00, 0x01, 0xff, 0x7f]).toString("base64"),
      redirected: false,
    }));

    const result = await run(
      [
        'const res = await fetch("https://api.example.com/blob");',
        "const bytes = await res.bytes();",
        "await infra.output({ length: bytes.length, first: bytes[0], last: bytes[3] });",
      ].join("\n"),
      host,
    );

    expect(result.output).toEqual({ length: 4, first: 0, last: 127 });
  });

  it("stops a fetch loop at the run's budget, not many multiples of it", async () => {
    // `fetch` is deliberately not a paused method, and a loop that spends its
    // time suspended in host calls executes too few instructions for QuickJS's
    // interrupt handler to fire on time (it is instruction-counted). The
    // deadline check in `__host` is what actually bounds this: before the fix
    // the same loop ran for ~12s against a 300ms budget.
    let calls = 0;
    const host = hostFor(() => {
      calls += 1;
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 200,
              statusText: "OK",
              url: "https://slow.example.com/",
              headers: {},
              bodyBase64: "",
              redirected: false,
            }),
          50,
        ),
      );
    });

    const started = Date.now();
    const result = await runWorkflow({
      source: 'while (true) { await fetch("https://slow.example.com/"); }',
      host,
      interactive: false,
      limits: { timeoutMs: 300 },
    });

    expect(result.status).toBe("failure");
    expect(result.error?.message).toMatch(/execution budget/);
    // 300ms of 50ms calls is ~6 requests; anything near 235 means the loop ran
    // to the interrupt handler's instruction count instead.
    expect(calls).toBeLessThan(20);
    // Wall clock stretches under a loaded turbo run; the unfixed loop took ~12s,
    // so 8s still catches that regression without flaking on a 3.3s host pause.
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});

// The isolate boots a WASM module per run; give the suite room on a cold cache.
vi.setConfig({ testTimeout: 30_000 });
