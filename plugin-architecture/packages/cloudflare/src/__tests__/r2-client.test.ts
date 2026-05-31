import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listR2Buckets,
  getR2Bucket,
  createR2Bucket,
  deleteR2Bucket,
  listR2StorageObjects,
  deleteR2StorageObject,
  uploadR2StorageObject,
  makeR2StorageFolder,
} from "../clients/r2-client.js";
import { makeApi } from "./_helpers.js";

function r2Api(over: Record<string, unknown> = {}) {
  const buckets = {
    list: vi.fn(async () => ({
      buckets: [{ name: "b1", location: "wnam", creation_date: "2020" }],
    })),
    get: vi.fn(async () => ({ name: "b1", location: "wnam" })),
    create: vi.fn(async () => ({ name: "b2" })),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { r2: { buckets } }, ...over });
}

describe("r2-client buckets", () => {
  it("listR2Buckets maps buckets with s3 endpoint", async () => {
    const api = r2Api();
    const out = await listR2Buckets(api, "acct");
    expect(out[0].id).toBe("acct:r2-bucket:b1");
    expect(out[0].resolvedOutputs.s3Endpoint).toBe("https://acct-cf.r2.cloudflarestorage.com");
    expect(out[0].fields.location).toBe("wnam");
  });

  it("listR2Buckets handles missing buckets array", async () => {
    const api = makeApi({ cf: { r2: { buckets: { list: vi.fn(async () => ({})) } } } });
    expect(await listR2Buckets(api, "acct")).toEqual([]);
  });

  it("getR2Bucket fetches one bucket", async () => {
    const api = r2Api();
    const out = await getR2Bucket(api, "b1", "acct");
    expect(api.cf.r2.buckets.get).toHaveBeenCalledWith("b1", { account_id: "acct-cf" });
    expect(out.externalId).toBe("b1");
  });

  it("createR2Bucket includes location hint when set", async () => {
    const api = r2Api();
    await createR2Bucket(api, "acct", { name: "b2", locationHint: "weur" });
    expect(api.cf.r2.buckets.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "b2", locationHint: "weur" }),
    );
  });

  it("createR2Bucket omits location hint when blank", async () => {
    const api = r2Api();
    await createR2Bucket(api, "acct", { name: "b2", locationHint: "" });
    const arg = (api.cf.r2.buckets.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).not.toHaveProperty("locationHint");
  });

  it("deleteR2Bucket calls SDK delete", async () => {
    const api = r2Api();
    await deleteR2Bucket(api, "b1");
    expect(api.cf.r2.buckets.delete).toHaveBeenCalledWith("b1", { account_id: "acct-cf" });
  });
});

describe("r2-client object plane", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listR2StorageObjects returns directories and files", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: [
          {
            key: "p/file.txt",
            size: 5,
            last_modified: "2020",
            http_metadata: { contentType: "text/plain" },
          },
          { key: "p/", size: 0 },
        ],
        result_info: { delimited: ["p/sub/"] },
      }),
    });
    const api = makeApi();
    const objs = await listR2StorageObjects(api, "bucket", "p/");
    expect(objs.find((o) => o.isDirectory)?.name).toBe("sub");
    const file = objs.find((o) => !o.isDirectory);
    expect(file?.name).toBe("file.txt");
    expect(file?.contentType).toBe("text/plain");
  });

  it("listR2StorageObjects throws on http error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "no" });
    await expect(listR2StorageObjects(makeApi(), "b", "")).rejects.toThrow(/403/);
  });

  it("listR2StorageObjects throws on success=false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, errors: [{ message: "bad" }] }),
    });
    await expect(listR2StorageObjects(makeApi(), "b", "")).rejects.toThrow(/bad/);
  });

  it("deleteR2StorageObject deletes a single object", async () => {
    const api = makeApi();
    await deleteR2StorageObject(api, "bucket", "a.txt");
    expect(api.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/objects/a.txt"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deleteR2StorageObject recurses into a prefix", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ key: "p/x.txt", size: 1 }], result_info: {} }),
    });
    const api = makeApi();
    await deleteR2StorageObject(api, "bucket", "p/");
    // one for the listed child object plus the prefix delete itself
    expect((api.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("uploadR2StorageObject PUTs the file body", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const api = makeApi();
    const file = {
      type: "text/plain",
      arrayBuffer: async () => new ArrayBuffer(3),
    } as unknown as File;
    await uploadR2StorageObject(api, "bucket", "k.txt", file);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/objects/k.txt"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("uploadR2StorageObject throws on failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const file = { type: "", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    await expect(uploadR2StorageObject(makeApi(), "b", "k", file)).rejects.toThrow(/500/);
  });

  it("makeR2StorageFolder appends a trailing slash", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const api = makeApi();
    await makeR2StorageFolder(api, "bucket", "folder");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("folder%2F"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("makeR2StorageFolder throws on failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "no" });
    await expect(makeR2StorageFolder(makeApi(), "b", "f/")).rejects.toThrow(/500/);
  });
});
