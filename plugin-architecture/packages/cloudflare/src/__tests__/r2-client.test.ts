import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  listR2Buckets,
  getR2Bucket,
  createR2Bucket,
  deleteR2Bucket,
  listR2StorageObjects,
  deleteR2StorageObject,
  uploadR2StorageObject,
  makeR2StorageFolder,
  editR2Bucket,
  getR2DevDomain,
  setR2DevDomain,
} from "../clients/r2-client.js";
import { CloudflareClient } from "../client.js";
import { plugin } from "../plugin.js";
import { makeApi } from "./_helpers.js";

function r2Api(over: Record<string, unknown> = {}) {
  const buckets = {
    get: vi.fn(async () => ({ name: "b1", location: "wnam" })),
    create: vi.fn(async () => ({ name: "b2" })),
    delete: vi.fn(async () => undefined),
  };
  const get = vi.fn(async (_path: string, opts: { headers?: object }) =>
    opts.headers
      ? { result: { buckets: [] }, result_info: {} }
      : {
          result: { buckets: [{ name: "b1", location: "wnam", creation_date: "2020" }] },
          result_info: { per_page: 1000, total_count: 1 },
        },
  );
  return makeApi({ cf: { get, r2: { buckets } }, ...over });
}

describe("r2-client buckets", () => {
  it("listR2Buckets maps buckets with s3 endpoint", async () => {
    const api = r2Api();
    const out = await listR2Buckets(api, "acct");
    expect(out[0]!.id).toBe("acct:r2-bucket:b1");
    expect(out[0]!.resolvedOutputs.s3Endpoint).toBe("https://acct-cf.r2.cloudflarestorage.com");
    expect(out[0]!.fields.location).toBe("wnam");
  });

  it("listR2Buckets handles missing buckets array", async () => {
    const api = makeApi({ cf: { get: vi.fn(async () => ({ result: {} })) } });
    expect(await listR2Buckets(api, "acct")).toEqual([]);
  });

  it("listR2Buckets follows the cursor at the largest page size", async () => {
    const get = vi.fn(
      async (_path: string, opts: { query: { cursor?: string }; headers?: object }) =>
        opts.headers
          ? { result: { buckets: [] }, result_info: {} }
          : opts.query.cursor
            ? { result: { buckets: [{ name: "b2" }] }, result_info: {} }
            : { result: { buckets: [{ name: "b1" }] }, result_info: { cursor: "next" } },
    );
    const out = await listR2Buckets(makeApi({ cf: { get } }), "acct");
    expect(out.map((b) => b.externalId)).toEqual(["b1", "b2"]);
    expect(get).toHaveBeenNthCalledWith(1, "/accounts/acct-cf/r2/buckets", {
      query: { per_page: 1000 },
    });
    expect(get).toHaveBeenNthCalledWith(2, "/accounts/acct-cf/r2/buckets", {
      query: { per_page: 1000, cursor: "next" },
    });
  });

  it("listR2Buckets throws at its cap rather than returning part", async () => {
    const get = vi.fn(async () => ({
      result: { buckets: [{ name: "b1" }] },
      result_info: { cursor: "more" },
    }));
    await expect(listR2Buckets(makeApi({ cf: { get } }), "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(get).toHaveBeenCalledTimes(100);
  });

  it("listR2Buckets refuses an answer with no result", async () => {
    const api = makeApi({ cf: { get: vi.fn(async () => ({ success: true })) } });
    await expect(listR2Buckets(api, "acct")).rejects.toThrow("is not a list");
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
    const arg = (api.cf.r2.buckets.create as Mock).mock.calls[0]![0];
    expect(arg).not.toHaveProperty("locationHint");
  });

  it("deleteR2Bucket calls SDK delete", async () => {
    const api = r2Api();
    await deleteR2Bucket(api, "b1");
    expect(api.cf.r2.buckets.delete).toHaveBeenCalledWith("b1", { account_id: "acct-cf" });
  });
});

describe("r2-client object plane", () => {
  let fetchMock: Mock;
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
    expect((api.fetch as Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
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

describe("r2-client storage class and r2.dev access", () => {
  function api(managed: Record<string, unknown> = { domain: "pub-abc.r2.dev", enabled: true }) {
    const buckets = {
      get: vi.fn(async () => ({ name: "b1", storage_class: "Standard", jurisdiction: "eu" })),
      create: vi.fn(async () => ({ name: "b2", storage_class: "InfrequentAccess" })),
      edit: vi.fn(async () => ({ name: "b1", storage_class: "InfrequentAccess" })),
      domains: {
        managed: {
          list: vi.fn(async () => managed),
          update: vi.fn(async () => managed),
        },
      },
    };
    return makeApi({ cf: { r2: { buckets } } });
  }

  it("maps storage class and jurisdiction", async () => {
    const out = await getR2Bucket(api(), "b1", "acct");
    expect(out.fields.storageClass).toBe("Standard");
    expect(out.fields.jurisdiction).toBe("eu");
  });

  it("createR2Bucket forwards a valid storage class only", async () => {
    const a = api();
    await createR2Bucket(a, "acct", { name: "b2", storageClass: "InfrequentAccess" });
    expect(a.cf.r2.buckets.create).toHaveBeenCalledWith(
      expect.objectContaining({ storageClass: "InfrequentAccess" }),
    );
    await createR2Bucket(a, "acct", { name: "b3", storageClass: "Glacier" });
    expect((a.cf.r2.buckets.create as Mock).mock.calls[1]![0]).not.toHaveProperty("storageClass");
  });

  it("editR2Bucket patches the storage class and rejects unknown ones", async () => {
    const a = api();
    const out = await editR2Bucket(a, "acct", "b1", { storageClass: "InfrequentAccess" });
    expect(a.cf.r2.buckets.edit).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      storage_class: "InfrequentAccess",
    });
    expect(out.fields.storageClass).toBe("InfrequentAccess");
    await expect(editR2Bucket(a, "acct", "b1", { storageClass: "x" })).rejects.toThrow(
      /storage class/,
    );
  });

  it("reads and toggles the r2.dev domain, passing a non-default jurisdiction", async () => {
    const a = api();
    expect(await getR2DevDomain(a, "b1")).toEqual({ domain: "pub-abc.r2.dev", enabled: true });
    expect(a.cf.r2.buckets.domains.managed.list).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
    });
    await setR2DevDomain(a, "b1", false, "eu");
    expect(a.cf.r2.buckets.domains.managed.update).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      enabled: false,
      jurisdiction: "eu",
    });
  });

  it("client enriches the detail with r2.dev state and routes the toggle actions", async () => {
    const c = hostClient(new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes));
    const a = api();
    (c as unknown as { api: unknown }).api = a;
    const bucket = await c.getResource("r2-bucket", "acct:r2-bucket:b1", "acct");
    const enriched = await c.enrichDetail(bucket);
    expect(enriched.resolvedOutputs.publicDevUrl).toBe("https://pub-abc.r2.dev");
    const json = JSON.stringify(c.renderDetail(enriched));
    expect(json).toContain("r2dev-disable");
    expect(json).toContain("https://pub-abc.r2.dev");
    await c.invokeAction("r2-bucket", "acct:r2-bucket:b1", "r2dev-enable", "acct");
    expect(a.cf.r2.buckets.domains.managed.update).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      enabled: true,
      jurisdiction: "eu",
    });
  });
});

describe("r2-client jurisdictions", () => {
  function refusal(status: number, message = "refused") {
    return Object.assign(new Error(`${status} ${message}`), {
      status,
      errors: [{ code: 10001, message }],
    });
  }

  type ListOpts = { query: { cursor?: string }; headers?: Record<string, string> };

  function listing(by: Record<string, () => unknown>) {
    return vi.fn(async (_path: string, opts: ListOpts) => {
      const answer = by[opts.headers?.["cf-r2-jurisdiction"] ?? "default"];
      if (!answer) throw new Error("unexpected jurisdiction");
      return answer();
    });
  }

  it("lists each documented jurisdiction and qualifies the ids outside the default", async () => {
    const get = listing({
      default: () => ({ result: { buckets: [{ name: "b1" }] }, result_info: {} }),
      eu: () => ({ result: { buckets: [{ name: "b1", jurisdiction: "eu" }] }, result_info: {} }),
      fedramp: () => ({ result: { buckets: [{ name: "gov" }] }, result_info: {} }),
    });
    const out = await listR2Buckets(makeApi({ cf: { get } }), "acct");
    expect(out.map((b) => b.id)).toEqual([
      "acct:r2-bucket:b1",
      "acct:r2-bucket:eu/b1",
      "acct:r2-bucket:fedramp/gov",
    ]);
    expect(out.map((b) => b.fields.jurisdiction)).toEqual(["default", "eu", "fedramp"]);
    expect(out.map((b) => b.fields.name)).toEqual(["b1", "b1", "gov"]);
    expect(out[1]!.resolvedOutputs.s3Endpoint).toBe("https://acct-cf.eu.r2.cloudflarestorage.com");
    expect(get).toHaveBeenCalledWith("/accounts/acct-cf/r2/buckets", {
      query: { per_page: 1000 },
      headers: { "cf-r2-jurisdiction": "eu" },
    });
  });

  it("reads a jurisdiction the account may not use as none", async () => {
    const get = listing({
      default: () => ({ result: { buckets: [{ name: "b1" }] }, result_info: {} }),
      eu: () => ({ result: { buckets: [] }, result_info: {} }),
      fedramp: () => {
        throw refusal(403, "Access to the FedRAMP jurisdiction is not enabled");
      },
    });
    const out = await listR2Buckets(makeApi({ cf: { get } }), "acct");
    expect(out.map((b) => b.externalId)).toEqual(["b1"]);
  });

  it("reads a 400 refusal of a jurisdiction as none while the default answers", async () => {
    const get = listing({
      default: () => ({ result: { buckets: [{ name: "b1" }] }, result_info: {} }),
      eu: () => {
        throw refusal(400, "Invalid jurisdiction");
      },
      fedramp: () => {
        throw refusal(400, "Invalid jurisdiction");
      },
    });
    const out = await listR2Buckets(makeApi({ cf: { get } }), "acct");
    expect(out.map((b) => b.externalId)).toEqual(["b1"]);
  });

  it("fails the whole list on a throttle, an outage or a rejected token in another jurisdiction", async () => {
    for (const status of [429, 503, 401]) {
      const get = listing({
        default: () => ({ result: { buckets: [{ name: "b1" }] }, result_info: {} }),
        eu: () => {
          throw refusal(status);
        },
        fedramp: () => ({ result: { buckets: [] }, result_info: {} }),
      });
      await expect(listR2Buckets(makeApi({ cf: { get } }), "acct")).rejects.toThrow(String(status));
    }
  });

  it("still fails when the default jurisdiction is refused", async () => {
    const get = listing({
      default: () => {
        throw refusal(403);
      },
      eu: () => ({ result: { buckets: [{ name: "b1" }] }, result_info: {} }),
      fedramp: () => ({ result: { buckets: [] }, result_info: {} }),
    });
    await expect(listR2Buckets(makeApi({ cf: { get } }), "acct")).rejects.toThrow("403");
  });

  it("a page past the cap in another jurisdiction still fails the list", async () => {
    const get = listing({
      default: () => ({ result: { buckets: [] }, result_info: {} }),
      eu: () => ({ result: { buckets: [{ name: "b" }] }, result_info: { cursor: "more" } }),
      fedramp: () => ({ result: { buckets: [] }, result_info: {} }),
    });
    await expect(listR2Buckets(makeApi({ cf: { get } }), "acct")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("addresses a qualified bucket in its jurisdiction on get, edit and delete", async () => {
    const buckets = {
      get: vi.fn(async () => ({ name: "b1" })),
      edit: vi.fn(async () => ({ name: "b1", storage_class: "Standard" })),
      delete: vi.fn(async () => undefined),
    };
    const api = makeApi({ cf: { r2: { buckets } } });
    const got = await getR2Bucket(api, "eu/b1", "acct");
    expect(buckets.get).toHaveBeenCalledWith("b1", { account_id: "acct-cf", jurisdiction: "eu" });
    expect(got.externalId).toBe("eu/b1");
    expect(got.fields.jurisdiction).toBe("eu");
    await editR2Bucket(api, "acct", "eu/b1", { storageClass: "Standard" });
    expect(buckets.edit).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      storage_class: "Standard",
      jurisdiction: "eu",
    });
    await deleteR2Bucket(api, "fedramp/b1");
    expect(buckets.delete).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      jurisdiction: "fedramp",
    });
  });

  it("refuses to act on a blank bucket name", async () => {
    const buckets = { delete: vi.fn(async () => undefined) };
    const api = makeApi({ cf: { r2: { buckets } } });
    await expect(deleteR2Bucket(api, "eu/")).rejects.toThrow(/bucket/i);
    await expect(deleteR2Bucket(api, "")).rejects.toThrow(/bucket/i);
    expect(buckets.delete).not.toHaveBeenCalled();
  });

  describe("object plane", () => {
    let fetchMock: Mock;
    beforeEach(() => {
      fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true, result: [], result_info: {} }),
      }));
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends the jurisdiction header and the bare name for a qualified bucket", async () => {
      const api = makeApi();
      await listR2StorageObjects(api, "eu/b1", "");
      const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toContain("/r2/buckets/b1/objects?");
      expect(init.headers).toMatchObject({ "cf-r2-jurisdiction": "eu" });

      await deleteR2StorageObject(api, "eu/b1", "a.txt");
      expect(api.fetch).toHaveBeenCalledWith(
        "/accounts/acct-cf/r2/buckets/b1/objects/a.txt",
        expect.objectContaining({
          method: "DELETE",
          headers: { "cf-r2-jurisdiction": "eu" },
        }),
      );

      const file = { type: "", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
      await uploadR2StorageObject(api, "eu/b1", "k", file);
      await makeR2StorageFolder(api, "eu/b1", "f");
      for (const call of fetchMock.mock.calls.slice(1)) {
        const [u, i] = call as unknown as [string, RequestInit];
        expect(u).toContain("/r2/buckets/b1/objects/");
        expect(i.headers).toMatchObject({ "cf-r2-jurisdiction": "eu" });
      }
    });

    it("sends no jurisdiction header for a default bucket", async () => {
      await listR2StorageObjects(makeApi(), "b1", "");
      const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
      expect(init.headers).not.toHaveProperty("cf-r2-jurisdiction");
    });
  });

  it("the client browses and toggles a qualified bucket by its bare name", async () => {
    const managed = { domain: "pub-eu.r2.dev", enabled: false };
    const buckets = {
      get: vi.fn(async () => ({ name: "b1" })),
      domains: {
        managed: { list: vi.fn(async () => managed), update: vi.fn(async () => managed) },
      },
    };
    const c = hostClient(new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes));
    (c as unknown as { api: unknown }).api = makeApi({ cf: { r2: { buckets } } });
    const bucket = await c.getResource("r2-bucket", "acct:r2-bucket:eu/b1", "acct");
    expect(JSON.stringify(c.renderDetail(bucket))).toContain('"bucketName":"eu/b1"');
    await c.invokeAction("r2-bucket", "acct:r2-bucket:eu/b1", "r2dev-enable", "acct");
    expect(buckets.domains.managed.update).toHaveBeenCalledWith("b1", {
      account_id: "acct-cf",
      enabled: true,
      jurisdiction: "eu",
    });
    expect(await c.resolveOutput("r2-bucket", "acct:r2-bucket:eu/b1", "s3Endpoint", "acct")).toBe(
      "https://acct-cf.eu.r2.cloudflarestorage.com",
    );
  });
});
