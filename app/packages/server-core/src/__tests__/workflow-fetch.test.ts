import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowFetchRequest } from "@infrawrench/workflow-runtime";

import {
  buildWorkflowFetch,
  fetchFromWorkflow,
  isWorkflowFetchConfigured,
  MAX_FETCHES_PER_RUN,
} from "../workflows/fetch";

/**
 * A workflow's outbound HTTP must leave through the egress proxy, never from
 * the pod the isolate runs in. These pin the two halves of that: the request we
 * hand the proxy, and the refusal when no proxy is configured.
 */

const REQUEST: WorkflowFetchRequest = {
  url: "https://api.example.com/v1/things",
  method: "GET",
  headers: { accept: "application/json" },
  timeoutMs: 30_000,
  maxBytes: 5 * 1024 * 1024,
  redirect: "follow",
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env["WORKFLOW_FETCH_PROXY_URL"] = "https://egress.infrawrench.com/";
  process.env["WORKFLOW_FETCH_PROXY_TOKEN"] = "proxy-secret";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["WORKFLOW_FETCH_PROXY_URL"];
  delete process.env["WORKFLOW_FETCH_PROXY_TOKEN"];
  vi.restoreAllMocks();
});

function stubProxy(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

describe("isWorkflowFetchConfigured", () => {
  it("needs both the URL and the token", () => {
    expect(isWorkflowFetchConfigured()).toBe(true);
    delete process.env["WORKFLOW_FETCH_PROXY_TOKEN"];
    expect(isWorkflowFetchConfigured()).toBe(false);
  });
});

describe("fetchFromWorkflow", () => {
  it("posts the request to the proxy with the bearer token", async () => {
    const stub = stubProxy({
      response: {
        status: 200,
        statusText: "OK",
        url: REQUEST.url,
        headers: {},
        bodyBase64: "",
        redirected: false,
      },
    });

    const response = await fetchFromWorkflow(REQUEST);
    expect(response.status).toBe(200);

    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash on the configured base must not double up.
    expect(url).toBe("https://egress.infrawrench.com/fetch");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer proxy-secret");
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it("refuses to fetch at all when no proxy is configured", async () => {
    // The important failure mode: never quietly fall back to a request that
    // leaves from inside the cluster.
    delete process.env["WORKFLOW_FETCH_PROXY_URL"];
    const stub = stubProxy({});
    await expect(fetchFromWorkflow(REQUEST)).rejects.toThrow(/no workflow egress proxy configured/);
    expect(stub).not.toHaveBeenCalled();
  });

  it("surfaces the proxy's own refusal to the workflow author", async () => {
    stubProxy(
      {
        error: {
          code: "blocked_host",
          message: "10.0.0.5 is a private address and is not proxied.",
        },
      },
      400,
    );
    await expect(fetchFromWorkflow(REQUEST)).rejects.toThrow(/is not proxied/);
  });

  it("reports an unreachable proxy distinctly from a refused request", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) as never;
    await expect(fetchFromWorkflow(REQUEST)).rejects.toThrow(/could not reach the egress proxy/);
  });

  it("handles a non-JSON reply from the proxy", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 }),
    ) as never;
    await expect(fetchFromWorkflow(REQUEST)).rejects.toThrow(/malformed reply/);
  });
});

describe("buildWorkflowFetch", () => {
  it("caps how many requests one run may make", async () => {
    stubProxy({
      response: {
        status: 200,
        statusText: "OK",
        url: REQUEST.url,
        headers: {},
        bodyBase64: "",
        redirected: false,
      },
    });
    const runFetch = buildWorkflowFetch();
    for (let i = 0; i < MAX_FETCHES_PER_RUN; i++) await runFetch(REQUEST);
    await expect(runFetch(REQUEST)).rejects.toThrow(/maximum of 250 fetch\(\) calls/);
  });

  it("gives each run its own budget", async () => {
    stubProxy({
      response: {
        status: 200,
        statusText: "OK",
        url: REQUEST.url,
        headers: {},
        bodyBase64: "",
        redirected: false,
      },
    });
    const first = buildWorkflowFetch();
    for (let i = 0; i < MAX_FETCHES_PER_RUN; i++) await first(REQUEST);
    await expect(buildWorkflowFetch()(REQUEST)).resolves.toMatchObject({ status: 200 });
  });
});
