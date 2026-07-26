import { describe, expect, it, vi } from "vitest";

import {
  dispatch,
  WorkflowCapabilityError,
  type WorkflowHost,
  type WorkflowRunContext,
} from "./host.js";
import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_HEADERS,
  MAX_FETCH_MAX_BYTES,
  MAX_FETCH_TIMEOUT_MS,
  type WorkflowFetchRequest,
  type WorkflowFetchResponse,
} from "./types.js";

/**
 * `fetch` requests are normalized and validated in dispatch, not per host, so
 * the cloud proxy and the desktop's direct call can never disagree about what
 * a workflow is allowed to ask for. These lock that contract down.
 */

const OK: WorkflowFetchResponse = {
  status: 200,
  statusText: "OK",
  url: "https://api.example.com/",
  headers: { "content-type": "application/json" },
  bodyBase64: "",
  redirected: false,
};

const ctx: WorkflowRunContext = {
  interactive: false,
  log: () => {},
  setOutput: () => {},
};

function hostWithFetch(impl = vi.fn(async (_r: WorkflowFetchRequest) => OK)) {
  return { host: { fetch: impl } as unknown as WorkflowHost, fetch: impl };
}

/** Dispatch one `fetch` and return the normalized request the host received. */
async function normalize(request: Record<string, unknown>): Promise<WorkflowFetchRequest> {
  const { host, fetch } = hostWithFetch();
  await dispatch(host, ctx, "fetch", { request });
  return fetch.mock.calls[0]![0]!;
}

describe("fetch dispatch", () => {
  it("applies the default method, timeout, byte cap, and redirect mode", async () => {
    const req = await normalize({ url: "https://api.example.com/things" });
    expect(req).toEqual({
      url: "https://api.example.com/things",
      method: "GET",
      headers: {},
      timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      maxBytes: DEFAULT_FETCH_MAX_BYTES,
      redirect: "follow",
    });
  });

  it("uppercases the method and lowercases header names", async () => {
    const req = await normalize({
      url: "https://api.example.com/",
      method: "post",
      headers: { "X-API-Key": "abc", Accept: "application/json" },
      bodyBase64: Buffer.from("{}").toString("base64"),
    });
    expect(req.method).toBe("POST");
    expect(req.headers).toEqual({ "x-api-key": "abc", accept: "application/json" });
  });

  it("clamps timeoutMs and maxBytes to their ceilings", async () => {
    const req = await normalize({
      url: "https://api.example.com/",
      timeoutMs: 60 * 60_000,
      maxBytes: 1024 * 1024 * 1024,
    });
    expect(req.timeoutMs).toBe(MAX_FETCH_TIMEOUT_MS);
    expect(req.maxBytes).toBe(MAX_FETCH_MAX_BYTES);
  });

  it("falls back to defaults for nonsense timeouts", async () => {
    const req = await normalize({ url: "https://api.example.com/", timeoutMs: -1, maxBytes: 0 });
    expect(req.timeoutMs).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    expect(req.maxBytes).toBe(DEFAULT_FETCH_MAX_BYTES);
  });

  const rejects = async (request: Record<string, unknown>, match: RegExp) => {
    const { host } = hostWithFetch();
    await expect(dispatch(host, ctx, "fetch", { request })).rejects.toThrow(match);
  };

  it("rejects non-HTTP schemes", async () => {
    await rejects({ url: "file:///etc/passwd" }, /only supports http and https/);
    await rejects({ url: "data:text/plain,hi" }, /only supports http and https/);
  });

  it("rejects a relative URL", async () => {
    await rejects({ url: "/things" }, /absolute URL/);
  });

  it("rejects methods a workflow has no business sending", async () => {
    await rejects(
      { url: "https://api.example.com/", method: "TRACE" },
      /does not support the TRACE/,
    );
  });

  it("rejects hop-by-hop headers", async () => {
    await rejects(
      { url: "https://api.example.com/", headers: { Host: "internal.svc" } },
      /cannot set the host header/,
    );
    await rejects(
      { url: "https://api.example.com/", headers: { "Transfer-Encoding": "chunked" } },
      /cannot set the transfer-encoding header/,
    );
  });

  it("rejects a header value containing a newline (request splitting)", async () => {
    await rejects(
      { url: "https://api.example.com/", headers: { "x-a": "b\r\nX-Injected: 1" } },
      /may not contain a newline/,
    );
  });

  it("rejects more headers than the cap", async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i <= MAX_FETCH_HEADERS; i++) headers[`x-h${i}`] = "v";
    await rejects({ url: "https://api.example.com/", headers }, /at most 50 headers/);
  });

  it("rejects a body on GET", async () => {
    await rejects(
      { url: "https://api.example.com/", bodyBase64: Buffer.from("hi").toString("base64") },
      /cannot send a body with GET/,
    );
  });

  it("rejects an oversized request body", async () => {
    await rejects(
      {
        url: "https://api.example.com/",
        method: "POST",
        bodyBase64: "A".repeat(4 * 1024 * 1024),
      },
      /request bodies are limited/,
    );
  });

  it("surfaces a capability error when the host has no fetch", async () => {
    await expect(
      dispatch({} as WorkflowHost, ctx, "fetch", { request: { url: "https://a.example.com/" } }),
    ).rejects.toBeInstanceOf(WorkflowCapabilityError);
  });
});
