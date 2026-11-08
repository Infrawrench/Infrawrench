import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, apiPost, apiDelete, apiPatch } from "../api";

// Stub window.location. `pathname`/`search` are read by the 401 redirect to
// build its `return_to`, so a stub without them silently produces "undefined".
const locationMock = { href: "", pathname: "/org/o1/resources", search: "?tab=all" };
vi.stubGlobal("window", { location: locationMock });

function mockFetch(response: Partial<Response>) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "",
    ...response,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("apiFetch", () => {
  beforeEach(() => {
    locationMock.href = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on success", async () => {
    mockFetch({ ok: true, status: 200, text: async () => '{"id":1}' });
    const result = await apiFetch("/api/test");
    expect(result).toEqual({ id: 1 });
  });

  it("sends credentials: include", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => "" });
    await apiFetch("/api/test");
    expect(fn).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("redirects to sign-in on 401, keeping where the user was", async () => {
    mockFetch({ ok: false, status: 401, text: async () => "" });
    const promise = apiFetch("/api/test");
    // Should set location but never resolve. The `return_to` matters for pages
    // whose URL carries single-use state: `/claim?code=…` is handed over once
    // by an agent and cannot be reissued, so losing it spends the link.
    await vi.waitFor(() => {
      expect(locationMock.href).toBe(
        `/api/auth/sign-in?return_to=${encodeURIComponent("/org/o1/resources?tab=all")}`,
      );
    });
    // The promise should not resolve, but we can't await it forever.
    // Just confirm it's pending by racing with a timeout.
    const result = await Promise.race([
      promise.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(result).toBe("pending");
  });

  it("throws with JSON error message on non-OK response", async () => {
    mockFetch({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}',
    });
    await expect(apiFetch("/api/test")).rejects.toThrow("bad request");
  });

  it("throws with plain text on non-OK response without JSON", async () => {
    mockFetch({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    await expect(apiFetch("/api/test")).rejects.toThrow("Internal Server Error");
  });

  it("returns undefined for empty body", async () => {
    mockFetch({ ok: true, status: 200, text: async () => "" });
    const result = await apiFetch("/api/test");
    expect(result).toBeUndefined();
  });
});

describe("apiPost", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends POST with JSON body", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => '{"ok":true}' });
    await apiPost("/api/test", { name: "foo" });
    expect(fn).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "foo" }),
      }),
    );
  });
});

describe("apiDelete", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends DELETE request", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => "" });
    await apiDelete("/api/test/1");
    expect(fn).toHaveBeenCalledWith("/api/test/1", expect.objectContaining({ method: "DELETE" }));
  });
});

describe("apiPatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends PATCH with JSON body", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => '{"ok":true}' });
    await apiPatch("/api/test/1", { name: "bar" });
    expect(fn).toHaveBeenCalledWith(
      "/api/test/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "bar" }),
      }),
    );
  });
});

describe("responses index.html started at boot", () => {
  type BootWindow = { __IW_BOOT__?: { at: number; responses: Record<string, unknown> } };
  const bootWindow = window as unknown as BootWindow;
  const bootResponse = (body: string, status = 200) =>
    Promise.resolve({ ok: status < 400, status, text: async () => body } as Response);

  beforeEach(() => {
    locationMock.href = "";
  });

  afterEach(() => {
    delete bootWindow.__IW_BOOT__;
    vi.restoreAllMocks();
  });

  it("answers the first plain GET of a path from boot, and only the first", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => '{"from":"network"}' });
    bootWindow.__IW_BOOT__ = {
      at: Date.now(),
      responses: { "/api/auth/me": bootResponse('{"from":"boot"}') },
    };
    expect(await apiFetch("/api/auth/me")).toEqual({ from: "boot" });
    expect(fn).not.toHaveBeenCalled();
    expect(await apiFetch("/api/auth/me")).toEqual({ from: "network" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats a boot 401 like any other: back through sign-in", async () => {
    mockFetch({ ok: true, status: 200, text: async () => "" });
    bootWindow.__IW_BOOT__ = {
      at: Date.now(),
      responses: { "/api/auth/me": bootResponse("", 401) },
    };
    void apiFetch("/api/auth/me");
    await vi.waitFor(() => expect(locationMock.href).toMatch(/^\/api\/auth\/sign-in\?return_to=/));
  });

  it("never answers a write or a stale boot response", async () => {
    const fn = mockFetch({ ok: true, status: 200, text: async () => '{"from":"network"}' });
    bootWindow.__IW_BOOT__ = {
      at: Date.now(),
      responses: { "/api/x": bootResponse('{"from":"boot"}') },
    };
    expect(await apiPost("/api/x", {})).toEqual({ from: "network" });
    bootWindow.__IW_BOOT__ = {
      at: Date.now() - 60_000,
      responses: { "/api/y": bootResponse('{"from":"boot"}') },
    };
    expect(await apiFetch("/api/y")).toEqual({ from: "network" });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
