import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudFetch, CloudApiError } from "../fetch";
import type { TokenManager } from "../tokens";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return this;
    },
  } as unknown as Response;
}

describe("createCloudFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getAccessToken: ReturnType<typeof vi.fn>;
  let forceRefreshAccessToken: ReturnType<typeof vi.fn>;
  let tokens: TokenManager;

  beforeEach(() => {
    fetchMock = vi.fn();
    getAccessToken = vi.fn().mockResolvedValue("tok1");
    forceRefreshAccessToken = vi.fn().mockResolvedValue("tok2");
    tokens = { getAccessToken, forceRefreshAccessToken } as unknown as TokenManager;
  });

  function api() {
    return createCloudFetch({
      tokens,
      baseUrl: "https://cloud.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
  }

  it("sends Bearer auth to the org-scoped URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const out = await api().org<{ ok: boolean }>("org 1", "/accounts");
    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cloud.test/api/org/org%201/accounts");
    expect(init.headers.Authorization).toBe("Bearer tok1");
  });

  it("sets JSON content-type only for string bodies", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api().org("o", "/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(fetchMock.mock.calls[0]![1].headers["Content-Type"]).toBe("application/json");
  });

  it("retries once with a refreshed token on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await api().org<{ ok: boolean }>("o", "/accounts");
    expect(out).toEqual({ ok: true });
    expect(forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe("Bearer tok2");
  });

  it("throws when the refresh after 401 fails", async () => {
    forceRefreshAccessToken.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(api().org("o", "/accounts")).rejects.toThrow(/expired/);
  });

  it("throws CloudApiError with status on non-OK", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 403));
    const err = await api()
      .org("o", "/accounts")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect((err as CloudApiError).status).toBe(403);
  });

  it("returns null on 204", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
      clone() {
        return this;
      },
    } as unknown as Response);
    expect(await api().org("o", "/x", { method: "DELETE" })).toBeNull();
  });

  it("throws when not authenticated", async () => {
    getAccessToken.mockResolvedValue(null);
    await expect(api().org("o", "/x")).rejects.toThrow(/Not authenticated/);
  });

  it("invokes on409 and retries when the handler resolves the conflict", async () => {
    const on409 = vi.fn().mockResolvedValue(true);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "ssh_host_key_trust_required" }, 409))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createCloudFetch({
      tokens,
      baseUrl: "https://cloud.test",
      fetch: fetchMock as unknown as typeof fetch,
      on409,
    });
    const out = await client.org<{ ok: boolean }>("o", "/sftp/list");
    expect(out).toEqual({ ok: true });
    expect(on409).toHaveBeenCalledWith({ error: "ssh_host_key_trust_required" });
  });
});
