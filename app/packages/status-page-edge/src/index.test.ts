import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { isAssetPath, normalizeHost, type Env } from "./index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function kv(map: Record<string, string | null>): KVNamespace {
  return {
    get: async (key: string) => map[key] ?? null,
  } as unknown as KVNamespace;
}

const env: Env = {
  STATUS_HOSTS: kv({ "status.acme.com": "slugabc123" }),
  ORIGIN: "https://app.infrawrench.com",
};

describe("normalizeHost", () => {
  it("strips port and lowercases", () => {
    expect(normalizeHost("Status.Acme.COM:443")).toBe("status.acme.com");
  });
  it("returns null for empty", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost("")).toBeNull();
  });
});

describe("isAssetPath", () => {
  it("recognises hashed assets and extensioned paths", () => {
    expect(isAssetPath("/assets/index-abc.js")).toBe(true);
    expect(isAssetPath("/favicon.ico")).toBe(true);
    expect(isAssetPath("/")).toBe(false);
    expect(isAssetPath("/api/status")).toBe(false);
  });
});

describe("worker", () => {
  it("404s when the hostname is unknown", async () => {
    const res = await worker.fetch(
      new Request("https://unknown.example/"),
      { ...env, STATUS_HOSTS: kv({}) },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("proxies /api/status to ORIGIN with the slug", async () => {
    const stub = vi.fn().mockResolvedValue(new Response('{"title":"ok"}', { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;

    const res = await worker.fetch(
      new Request("https://status.acme.com/api/status", {
        headers: { host: "status.acme.com", accept: "application/json" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledOnce();
    const called = stub.mock.calls[0]![0] as string;
    expect(called).toBe("https://app.infrawrench.com/api/status/slugabc123");
  });

  it("proxies document requests to the SPA shell", async () => {
    const stub = vi.fn().mockResolvedValue(
      new Response("<html><head></head><body></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    globalThis.fetch = stub as unknown as typeof fetch;

    const res = await worker.fetch(
      new Request("https://status.acme.com/", { headers: { host: "status.acme.com" } }),
      env,
      {} as ExecutionContext,
    );
    const called = stub.mock.calls[0]![0] as string;
    expect(called).toBe("https://app.infrawrench.com/");
    const html = await res.text();
    expect(html).toContain('name="iw-status-host"');
  });

  it("leaves non-HTML responses unmarked", async () => {
    const { markStatusHostHtml } = await import("./index.js");
    const upstream = new Response("ok", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    const out = await markStatusHostHtml(upstream);
    expect(await out.text()).toBe("ok");
  });

  it("proxies assets unchanged", async () => {
    const stub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;

    await worker.fetch(
      new Request("https://status.acme.com/assets/app.js", {
        headers: { host: "status.acme.com" },
      }),
      env,
      {} as ExecutionContext,
    );
    const called = stub.mock.calls[0]![0] as string;
    expect(called).toBe("https://app.infrawrench.com/assets/app.js");
  });
});
