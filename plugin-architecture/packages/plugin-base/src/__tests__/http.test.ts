import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from "vitest";
import {
  jsonRestFetch,
  formatBytes,
  caCertCredentialField,
  hostFetch,
  hostTransport,
  restRequest,
} from "../http.js";
import type { HttpHostServices } from "../manifest.js";

describe("formatBytes", () => {
  it("returns 0 B for zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes with no decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB/MB/GB/TB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("caps at TB for very large values", () => {
    expect(formatBytes(1024 ** 6)).toBe(`${(1024 ** 2).toFixed(1)} TB`);
  });
});

describe("caCertCredentialField", () => {
  it("is a non-sensitive multiline optional cert field", () => {
    expect(caCertCredentialField.key).toBe("caCert");
    expect(caCertCredentialField.sensitive).toBe(false);
    expect(caCertCredentialField.multiline).toBe(true);
  });
});

describe("jsonRestFetch via global fetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on ok and sets default content-type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hello: "world" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await jsonRestFetch<{ hello: string }>({
      vendor: "DigitalOcean",
      url: "https://api.do.com/v2/droplets",
      headers: { Authorization: "Bearer x" },
    });
    expect(result).toEqual({ hello: "world" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Authorization"]).toBe("Bearer x");
  });

  it("returns undefined for 204 No Content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) }),
    );
    const result = await jsonRestFetch({
      vendor: "V",
      url: "https://x/y",
      headers: {},
    });
    expect(result).toBeUndefined();
  });

  it("throws on non-ok with errorPath label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "bad input" }),
    );
    await expect(
      jsonRestFetch({
        vendor: "Hetzner",
        url: "https://api/v1/servers",
        headers: {},
        errorPath: "/v1/servers",
      }),
    ).rejects.toThrow("Hetzner API error 422 for /v1/servers: bad input");
  });

  it("throws using full url when no errorPath", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );
    await expect(jsonRestFetch({ vendor: "V", url: "https://api/x", headers: {} })).rejects.toThrow(
      "V API error 500 for https://api/x: boom",
    );
  });

  it("merges init.headers from a Headers instance", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: { A: "1" },
      init: { headers: new Headers({ B: "2" }) },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["a"] ?? init.headers["A"]).toBe("1");
    expect(init.headers["b"] ?? init.headers["B"]).toBe("2");
  });

  it("merges init.headers from an array of tuples", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: {},
      init: { headers: [["X-Custom", "v"]] },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["X-Custom"]).toBe("v");
  });

  it("merges init.headers from a plain object", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: {},
      init: { headers: { "X-Obj": "v" } },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["X-Obj"]).toBe("v");
  });
});

describe("jsonRestFetch via host http service", () => {
  function makeHttp(status: number, body: string): { http: HttpHostServices; request: Mock } {
    const request = vi.fn().mockResolvedValue({ status, body, headers: {} });
    return { http: { request } as unknown as HttpHostServices, request };
  }

  it("uses http.request and parses JSON on 2xx", async () => {
    const { http, request } = makeHttp(200, JSON.stringify({ ok: true }));
    const result = await jsonRestFetch<{ ok: boolean }>({
      vendor: "V",
      url: "https://x",
      headers: { A: "1" },
      http,
      init: { method: "POST", body: "payload" },
      caCert: "PEM",
    });
    expect(result).toEqual({ ok: true });
    const arg = request.mock.calls[0]![0];
    expect(arg.method).toBe("POST");
    expect(arg.body).toBe("payload");
    expect(arg.caCert).toBe("PEM");
    expect(arg.headers["A"]).toBe("1");
  });

  it("defaults method to GET and omits body when none given", async () => {
    const { http, request } = makeHttp(200, "{}");
    await jsonRestFetch({ vendor: "V", url: "https://x", headers: {}, http });
    const arg = request.mock.calls[0]![0];
    expect(arg.method).toBe("GET");
    expect("body" in arg).toBe(false);
    expect("caCert" in arg).toBe(false);
  });

  it("returns undefined for 204 via host", async () => {
    const { http } = makeHttp(204, "");
    expect(
      await jsonRestFetch({ vendor: "V", url: "https://x", headers: {}, http }),
    ).toBeUndefined();
  });

  it("returns undefined when body is empty even on 200", async () => {
    const { http } = makeHttp(200, "");
    expect(
      await jsonRestFetch({ vendor: "V", url: "https://x", headers: {}, http }),
    ).toBeUndefined();
  });

  it("throws on non-2xx via host", async () => {
    const { http } = makeHttp(404, "missing");
    await expect(
      jsonRestFetch({ vendor: "V", url: "https://x", headers: {}, http, errorPath: "/x" }),
    ).rejects.toThrow("V API error 404 for /x: missing");
  });

  it("coerces Uint8Array body", async () => {
    const { http, request } = makeHttp(200, "{}");
    const bytes = new Uint8Array([1, 2, 3]);
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: {},
      http,
      init: { body: bytes },
    });
    expect(request.mock.calls[0]![0]!.body).toBe(bytes);
  });

  it("coerces ArrayBuffer body to Uint8Array", async () => {
    const { http, request } = makeHttp(200, "{}");
    const buf = new ArrayBuffer(4);
    await jsonRestFetch({ vendor: "V", url: "https://x", headers: {}, http, init: { body: buf } });
    expect(request.mock.calls[0]![0]!.body).toBeInstanceOf(Uint8Array);
  });

  it("coerces a typed-array view body to Uint8Array", async () => {
    const { http, request } = makeHttp(200, "{}");
    const view = new Int16Array([1, 2]);
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: {},
      http,
      init: { body: view as unknown as BodyInit },
    });
    expect(request.mock.calls[0]![0]!.body).toBeInstanceOf(Uint8Array);
  });

  it("coerces URLSearchParams body to string", async () => {
    const { http, request } = makeHttp(200, "{}");
    await jsonRestFetch({
      vendor: "V",
      url: "https://x",
      headers: {},
      http,
      init: { body: new URLSearchParams({ a: "1" }) },
    });
    expect(request.mock.calls[0]![0]!.body).toBe("a=1");
  });
});

describe("hostTransport", () => {
  const http = { request: vi.fn() };

  it("always carries the host's service, and a CA only when there is one", () => {
    expect(hostTransport(http)).toEqual({ http });
    expect(hostTransport(http, "")).toEqual({ http });
    expect(hostTransport(http, "PEM")).toEqual({ http, caCert: "PEM" });
  });

  it("carries nothing without a host", () => {
    expect(hostTransport(undefined)).toEqual({});
  });
});

describe("hostFetch", () => {
  const ok = { status: 200, headers: { "content-type": "audio/mpeg" }, body: "" };
  const bytes = new Uint8Array([1, 2, 3]);

  afterEach(() => vi.unstubAllGlobals());

  function directFetch(answer?: Response) {
    const direct = answer
      ? vi.fn(async () => answer)
      : vi.fn(async () => {
          throw new Error("reached a real provider");
        });
    vi.stubGlobal("fetch", direct);
    return direct;
  }
  const noDirectFetch = () => directFetch();

  it("goes through the host when there is one, answering a real Response", async () => {
    const direct = noDirectFetch();
    const request = vi.fn(async () => ({ ...ok, rawBody: bytes }));
    const res = await hostFetch({ http: { request } }, "https://a/x", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "payload",
    });
    expect(direct).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith({
      url: "https://a/x",
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: "payload",
      responseEncoding: "binary",
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("takes the CA only when it is set", async () => {
    noDirectFetch();
    const request = vi.fn(async () => ok);
    await hostFetch({ http: { request }, caCert: "" }, "https://a/x");
    expect(request.mock.calls[0]).not.toEqual([
      expect.objectContaining({ caCert: expect.anything() }),
    ]);
    await hostFetch({ http: { request }, caCert: "PEM" }, "https://a/x");
    expect(request.mock.calls[1]).toEqual([expect.objectContaining({ caCert: "PEM" })]);
  });

  it("uses fetch only when there is no host", async () => {
    const direct = directFetch(new Response("hi"));
    const res = await hostFetch({}, "https://a/x", { method: "PUT" });
    expect(direct).toHaveBeenCalledExactlyOnceWith("https://a/x", { method: "PUT" });
    expect(await res.text()).toBe("hi");
  });

  it("reports a failure as a Response, as fetch does", async () => {
    noDirectFetch();
    const request = vi.fn(async () => ({ status: 503, headers: {}, body: "down" }));
    const res = await hostFetch({ http: { request } }, "https://a/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("down");
  });

  it("copes with an answer that has no body", async () => {
    noDirectFetch();
    const request = vi.fn(async () => ({ status: 204, headers: {}, body: "" }));
    const res = await hostFetch({ http: { request } }, "https://a/x");
    expect(res.status).toBe(204);
  });

  it("encodes a FormData, keeping the boundary it chose", async () => {
    noDirectFetch();
    const request = vi.fn(async (_req: { headers: Record<string, string>; body?: unknown }) => ok);
    const form = new FormData();
    form.set("file", new Blob([bytes]), "a.mp3");
    await hostFetch({ http: { request } }, "https://a/x", { method: "POST", body: form });
    const sent = request.mock.calls[0]![0];
    expect(sent.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(new TextDecoder().decode(sent.body as Uint8Array)).toContain('filename="a.mp3"');
  });

  it("keeps the type the caller set over the one a body would choose", async () => {
    noDirectFetch();
    const request = vi.fn(async (_req: { headers: Record<string, string> }) => ok);
    await hostFetch({ http: { request } }, "https://a/x", {
      method: "POST",
      headers: { "Content-Type": "application/x-custom" },
      body: new URLSearchParams({ a: "b" }),
    });
    expect(request.mock.calls[0]![0].headers["content-type"]).toBe("application/x-custom");
  });

  it("stops waiting for the host when the caller aborts", async () => {
    noDirectFetch();
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<typeof ok>(() => {}));
    const pending = hostFetch({ http: { request } }, "https://a/x", { signal: controller.signal });
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
  });

  describe("with stream", () => {
    const sse = () => new Response("data: x\n\n").body;

    it("streams through the host when it can, and never buffers", async () => {
      const direct = noDirectFetch();
      const requestStream = vi.fn(async () => ({ status: 200, headers: {}, body: sse() }));
      const request = vi.fn();
      const res = await hostFetch(
        { http: { request, requestStream }, stream: true },
        "https://a/x",
      );
      expect(await res.text()).toBe("data: x\n\n");
      expect(request).not.toHaveBeenCalled();
      expect(direct).not.toHaveBeenCalled();
    });

    it("uses fetch on a host that cannot stream, so the renderer keeps streaming", async () => {
      const direct = directFetch(new Response("hi"));
      const request = vi.fn();
      await hostFetch({ http: { request }, stream: true }, "https://a/x");
      expect(direct).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    });

    it("buffers through the host when a custom CA needs it and it cannot stream", async () => {
      const direct = noDirectFetch();
      const request = vi.fn(async () => ({ ...ok, body: "buffered" }));
      const res = await hostFetch(
        { http: { request }, caCert: "PEM", stream: true },
        "https://a/x",
      );
      expect(await res.text()).toBe("buffered");
      expect(direct).not.toHaveBeenCalled();
    });
  });
});

describe("restRequest through the host", () => {
  it("stops waiting when the caller aborts, as fetch would", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<never>(() => {}));
    const pending = restRequest({
      vendor: "Test",
      url: "https://a/x",
      headers: {},
      http: { request },
      init: { signal: controller.signal },
    });
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
  });
});
