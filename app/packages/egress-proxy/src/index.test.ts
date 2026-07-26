import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { assertAllowedUrl, type Env } from "./index.js";

/**
 * The proxy is the only thing between a workflow's `fetch` and the internet, so
 * what it refuses matters more than what it forwards. Most of these are the
 * refusals.
 */

const env: Env = { PROXY_TOKEN: "test-token" };

interface ProxiedResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string;
  redirected: boolean;
}

/** Base64 helpers, so the test needs no Node types (this builds for Workers). */
const toBase64 = (text: string): string => btoa(text);
const fromBase64 = (base64: string): string => atob(base64);

/** Unwrap a success envelope, failing loudly if the Worker returned an error. */
async function proxied(res: Response): Promise<ProxiedResponse> {
  const body = (await res.json()) as { response?: ProxiedResponse; error?: unknown };
  if (!body.response) throw new Error(`expected a response, got ${JSON.stringify(body)}`);
  return body.response;
}

/** Unwrap an error envelope. */
async function proxyError(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error?: { code: string; message: string } };
  if (!body.error) throw new Error("expected an error envelope");
  return body.error;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function post(body: unknown, token: string | null = "test-token"): Request {
  return new Request("https://egress.infrawrench.com/fetch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Stub the upstream call the Worker makes. */
function stubUpstream(...responses: Response[]): ReturnType<typeof vi.fn> {
  const stub = vi.fn();
  for (const response of responses) stub.mockResolvedValueOnce(response);
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

describe("assertAllowedUrl", () => {
  it("allows ordinary public URLs", () => {
    expect(assertAllowedUrl("https://api.github.com/repos/a/b").hostname).toBe("api.github.com");
    expect(assertAllowedUrl("http://example.com:8080/x").port).toBe("8080");
  });

  const blocked = [
    // The one that matters most: cloud metadata, which hands out node creds.
    "http://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/",
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://10.1.2.3/",
    "http://172.16.5.5/",
    "http://192.168.0.1/",
    "http://100.64.0.1/", // CGNAT
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fd00::1]/", // unique-local
    "http://[::ffff:10.0.0.1]/", // IPv4-mapped private
    // Cluster-internal names — the reason the proxy is outside the cluster.
    "http://web.default.svc.cluster.local/",
    "http://poller.default.svc/",
    "http://kubernetes.default/",
    "http://printer.local/",
    "http://web/", // resolvable only through a search domain
  ];
  for (const url of blocked) {
    it(`refuses ${url}`, () => {
      expect(() => assertAllowedUrl(url)).toThrow(/not proxied|not a public hostname/);
    });
  }

  it("refuses non-HTTP schemes and garbage", () => {
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => assertAllowedUrl("ftp://example.com/x")).toThrow(/Only http and https/);
    expect(() => assertAllowedUrl("not a url")).toThrow(/Not an absolute URL/);
  });
});

describe("worker", () => {
  it("requires a bearer token", async () => {
    const res = await worker.fetch(post({ url: "https://example.com/" }, null), env);
    expect(res.status).toBe(401);
    expect((await proxyError(res)).code).toBe("unauthorized");
  });

  it("rejects a wrong token", async () => {
    const res = await worker.fetch(post({ url: "https://example.com/" }, "nope-nope-nope"), env);
    expect(res.status).toBe(401);
  });

  it("answers /health without a token", async () => {
    const res = await worker.fetch(new Request("https://egress.infrawrench.com/health"), env);
    expect(res.status).toBe(200);
  });

  it("forwards a request and returns the body base64-encoded", async () => {
    const stub = stubUpstream(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", "set-cookie": "a=b" },
      }),
    );

    const res = await worker.fetch(
      post({
        url: "https://api.example.com/v1/thing",
        method: "POST",
        headers: { authorization: "Bearer upstream-token", host: "spoofed" },
        bodyBase64: toBase64('{"q":1}'),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const response = await proxied(res);
    expect(response).toMatchObject({ status: 200, redirected: false });
    expect(fromBase64(response.bodyBase64)).toBe('{"hello":"world"}');
    // set-cookie never comes back; content-type does.
    expect(response.headers).toEqual({ "content-type": "application/json" });

    const [, init] = stub.mock.calls[0]!;
    const sent = new Headers((init as RequestInit).headers);
    expect(sent.get("authorization")).toBe("Bearer upstream-token");
    // The caller doesn't get to forge Host.
    expect(sent.get("host")).toBeNull();
  });

  it("re-validates every redirect hop", async () => {
    // The classic SSRF: a public host that bounces you at the metadata server.
    stubUpstream(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/token" } }),
    );

    const res = await worker.fetch(post({ url: "https://redirector.example.com/" }), env);
    expect(res.status).toBe(400);
    const error = await proxyError(res);
    expect(error.code).toBe("blocked_host");
    expect(error.message).toMatch(/169\.254\.169\.254/);
  });

  it("follows a redirect to another public host", async () => {
    stubUpstream(
      new Response(null, { status: 301, headers: { location: "https://b.example.com/final" } }),
      new Response("done", { status: 200 }),
    );

    const response = await proxied(
      await worker.fetch(post({ url: "https://a.example.com/" }), env),
    );
    expect(response.url).toBe("https://b.example.com/final");
    expect(response.redirected).toBe(true);
    expect(fromBase64(response.bodyBase64)).toBe("done");
  });

  it("returns the 3xx itself when redirect is manual", async () => {
    stubUpstream(
      new Response(null, { status: 302, headers: { location: "https://b.example.com/" } }),
    );
    const response = await proxied(
      await worker.fetch(post({ url: "https://a.example.com/", redirect: "manual" }), env),
    );
    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe("https://b.example.com/");
  });

  it("fails rather than truncating an over-large body", async () => {
    stubUpstream(new Response("x".repeat(5000), { status: 200 }));
    const res = await worker.fetch(
      post({ url: "https://api.example.com/big", maxBytes: 1000 }),
      env,
    );
    expect(res.status).toBe(502);
    expect((await proxyError(res)).code).toBe("body_too_large");
  });

  it("reports an upstream connection failure as request_failed", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) as never;
    const res = await worker.fetch(post({ url: "https://nope.example.com/" }), env);
    expect(res.status).toBe(502);
    const error = await proxyError(res);
    expect(error.code).toBe("request_failed");
    expect(error.message).toMatch(/ENOTFOUND/);
  });

  it("404s anything that isn't /fetch", async () => {
    const res = await worker.fetch(new Request("https://egress.infrawrench.com/"), env);
    expect(res.status).toBe(404);
  });
});
