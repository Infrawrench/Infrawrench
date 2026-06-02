import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  listKVNamespaces,
  createKVNamespace,
  deleteKVNamespace,
  listKVKeys,
  getKVValue,
  putKVValue,
  deleteKVKey,
} from "../clients/kv-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

function kvApi() {
  const namespaces = {
    list: vi.fn(() => asyncIter([{ id: "ns1", title: "My NS", supports_url_encoding: true }])),
    create: vi.fn(async () => ({ id: "ns2", title: "Made" })),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { kv: { namespaces } } });
}

describe("kv-client namespaces", () => {
  it("listKVNamespaces maps namespaces", async () => {
    const api = kvApi();
    const out = await listKVNamespaces(api, "acct");
    expect(out[0]!.id).toBe("acct:kv-namespace:ns1");
    expect(out[0]!.displayName).toBe("My NS");
    expect(out[0]!.fields.supportsUrlEncoding).toBe(true);
  });

  it("createKVNamespace creates with title", async () => {
    const api = kvApi();
    await createKVNamespace(api, "acct", { title: "Made" });
    expect(api.cf.kv.namespaces.create).toHaveBeenCalledWith({
      account_id: "acct-cf",
      title: "Made",
    });
  });

  it("deleteKVNamespace calls SDK delete", async () => {
    const api = kvApi();
    await deleteKVNamespace(api, "ns1");
    expect(api.cf.kv.namespaces.delete).toHaveBeenCalledWith("ns1", { account_id: "acct-cf" });
  });
});

describe("kv-client key/value (raw fetch)", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listKVKeys returns items and nextCursor", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: [{ name: "k1", expiration: 99, metadata: { a: 1 } }, { name: "k2" }],
        result_info: { cursor: "next" },
      }),
    });
    const out = await listKVKeys(makeApi(), "ns1", { prefix: "p", cursor: "c", limit: 10 });
    expect(out.items[0]).toEqual({ name: "k1", expiration: 99, metadata: { a: 1 } });
    expect(out.items[1]).toEqual({ name: "k2" });
    expect(out.nextCursor).toBe("next");
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("prefix=p");
    expect(url).toContain("cursor=c");
    expect(url).toContain("limit=10");
  });

  it("listKVKeys without params omits query string and cursor", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [], result_info: {} }),
    });
    const out = await listKVKeys(makeApi(), "ns1", {});
    expect(out).toEqual({ items: [] });
    expect((fetchMock.mock.calls[0]![0] as string).endsWith("/keys")).toBe(true);
  });

  it("listKVKeys throws on http error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "no" });
    await expect(listKVKeys(makeApi(), "ns1", {})).rejects.toThrow(/401/);
  });

  it("listKVKeys throws on success=false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, errors: [{ message: "bad" }] }),
    });
    await expect(listKVKeys(makeApi(), "ns1", {})).rejects.toThrow(/bad/);
  });

  it("getKVValue returns the body text", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "the-value" });
    expect(await getKVValue(makeApi(), "ns1", "k1")).toBe("the-value");
  });

  it("getKVValue throws on http error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "nope" });
    await expect(getKVValue(makeApi(), "ns1", "k1")).rejects.toThrow(/404/);
  });

  it("putKVValue PUTs the value", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await putKVValue(makeApi(), "ns1", "k1", "v");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/values/k1"),
      expect.objectContaining({ method: "PUT", body: "v" }),
    );
  });

  it("putKVValue throws on http error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(putKVValue(makeApi(), "ns1", "k", "v")).rejects.toThrow(/500/);
  });

  it("deleteKVKey goes through api.fetch", async () => {
    const api = makeApi();
    await deleteKVKey(api, "ns1", "k1");
    expect(api.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/values/k1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
