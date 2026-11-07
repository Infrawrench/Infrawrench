import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listStorageObjects,
  uploadStorageObject,
  makeStorageFolder,
  deleteStorageObject,
} from "../storage-client.js";

import type { HttpHostServices } from "@infrawrench/plugin-base";

const ctx = { storageToken: vi.fn(async () => "stg-tok") };

afterEach(() => vi.restoreAllMocks());

function okText(text = ""): Response {
  return { ok: true, status: 200, text: async () => text } as unknown as Response;
}

type Request = Parameters<HttpHostServices["request"]>[0];
interface Reply {
  status?: number;
  body?: string;
}

/**
 * A host transport that answers only the one storage account's blob endpoint and
 * throws on anything else, so no request can leave the test.
 */
function host(route: (url: URL, method: string) => Reply) {
  const calls: { url: URL; method: string }[] = [];
  const request = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname !== "acc.blob.core.windows.net") throw new Error(`unexpected ${req.url}`);
    calls.push({ url, method: req.method });
    const reply = route(url, req.method);
    return { status: reply.status ?? 200, headers: {}, body: reply.body ?? "" };
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("fetch must not be called");
  });
  return { ctx: { storageToken: async () => "stg-tok", http: { request } }, calls, fetchSpy };
}

function blobsXml(names: string[], prefixes: string[] = [], next = ""): string {
  const blobs = names
    .map(
      (n) =>
        `<Blob><Name>${n}</Name><Properties><Last-Modified>Mon, 01 Jan 2024 00:00:00 GMT</Last-Modified><Content-Length>1024</Content-Length><Content-Type>text/plain</Content-Type></Properties></Blob>`,
    )
    .join("");
  const dirs = prefixes.map((n) => `<BlobPrefix><Name>${n}</Name></BlobPrefix>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://acc.blob.core.windows.net/" ContainerName="c"><Blobs>${blobs}${dirs}</Blobs>${next ? `<NextMarker>${next}</NextMarker>` : "<NextMarker />"}</EnumerationResults>`;
}

function containersXml(names: string[], next = ""): string {
  const rows = names
    .map(
      (n) =>
        `<Container><Name>${n}</Name><Properties><Last-Modified>Mon, 01 Jan 2024 00:00:00 GMT</Last-Modified></Properties></Container>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://acc.blob.core.windows.net/"><Containers>${rows}</Containers>${next ? `<NextMarker>${next}</NextMarker>` : "<NextMarker />"}</EnumerationResults>`;
}

describe("listStorageObjects", () => {
  it("lists the containers at the account root as folders", async () => {
    const { ctx, calls, fetchSpy } = host(() => ({ body: containersXml(["logs", "photos"]) }));
    const out = await listStorageObjects(ctx, "acc", "");
    expect(calls[0]!.url.pathname).toBe("/");
    expect(calls[0]!.url.searchParams.get("comp")).toBe("list");
    expect(calls[0]!.url.searchParams.has("restype")).toBe(false);
    expect(out).toEqual([
      { key: "logs/", name: "logs", size: 0, lastModified: "", isDirectory: true },
      { key: "photos/", name: "photos", size: 0, lastModified: "", isDirectory: true },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists a container's blobs under the rest of the prefix", async () => {
    const { ctx, calls } = host(() => ({
      body: blobsXml(["folder/file.txt"], ["folder/sub/"]),
    }));
    const out = await listStorageObjects(ctx, "acc", "c/folder/");
    const url = calls[0]!.url;
    expect(url.pathname).toBe("/c");
    expect(url.searchParams.get("restype")).toBe("container");
    expect(url.searchParams.get("comp")).toBe("list");
    expect(url.searchParams.get("prefix")).toBe("folder/");
    expect(url.searchParams.get("delimiter")).toBe("/");
    expect(out).toContainEqual({
      key: "c/folder/sub/",
      name: "sub",
      size: 0,
      lastModified: "",
      isDirectory: true,
    });
    expect(out).toContainEqual({
      key: "c/folder/file.txt",
      name: "file.txt",
      size: 1024,
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
      isDirectory: false,
      contentType: "text/plain",
    });
  });

  it("parses without a DOMParser, decoding entities and encoded names", async () => {
    expect("DOMParser" in globalThis).toBe(false);
    const { ctx } = host(() => ({
      body: blobsXml(["a &amp; b.txt", "x"]).replace(
        "<Name>x</Name>",
        '<Name Encoded="true">odd%EF%BF%BFname</Name>',
      ),
    }));
    const out = await listStorageObjects(ctx, "acc", "c/");
    expect(out.map((o) => o.key)).toEqual(["c/a & b.txt", "c/odd\uffffname"]);
  });

  it("follows NextMarker to the end of a container", async () => {
    const { ctx, calls } = host((url) =>
      url.searchParams.get("marker") === "m1"
        ? { body: blobsXml(["two.txt"]) }
        : { body: blobsXml(["one.txt"], [], "m1") },
    );
    const out = await listStorageObjects(ctx, "acc", "c/");
    expect(out.map((o) => o.key)).toEqual(["c/one.txt", "c/two.txt"]);
    expect(calls).toHaveLength(2);
  });

  it("follows NextMarker across containers", async () => {
    const { ctx } = host((url) =>
      url.searchParams.get("marker") === "m1"
        ? { body: containersXml(["b"]) }
        : { body: containersXml(["a"], "m1") },
    );
    const out = await listStorageObjects(ctx, "acc", "");
    expect(out.map((o) => o.key)).toEqual(["a/", "b/"]);
  });

  it("refuses a 200 that is not an enumeration", async () => {
    const { ctx } = host(() => ({ body: "<Error><Code>Odd</Code></Error>" }));
    await expect(listStorageObjects(ctx, "acc", "c/")).rejects.toThrow("is not a list");
  });

  it("throws on a non-ok list response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);
    await expect(listStorageObjects(ctx, "acc", "")).rejects.toThrow(/Blob list failed: 403/);
  });
});

describe("folder delete", () => {
  it("lists the whole prefix with no delimiter and deletes every blob under it", async () => {
    const remaining = new Set(["folder/", "folder/a.txt", "folder/sub/b.txt", "folder/sub/c.txt"]);
    const { ctx, calls } = host((url, method) => {
      if (method === "DELETE") {
        remaining.delete(decodeURIComponent(url.pathname.slice("/c/".length)));
        return { status: 202 };
      }
      const names = [...remaining].sort();
      if (url.searchParams.get("maxresults") === "1") return { body: blobsXml(names.slice(0, 1)) };
      return url.searchParams.get("marker") === "m1"
        ? { body: blobsXml(names.slice(2)) }
        : { body: blobsXml(names.slice(0, 2), [], "m1") };
    });
    await deleteStorageObject(ctx, "acc", "c/folder/");
    const lists = calls.filter((c) => c.method === "GET");
    expect(lists.every((c) => !c.url.searchParams.has("delimiter"))).toBe(true);
    expect(lists[0]!.url.searchParams.get("prefix")).toBe("folder/");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(4);
    expect(remaining.size).toBe(0);
  });

  it("deletes nothing when the prefix cannot be listed whole", async () => {
    const { ctx, calls } = host((_url, method) => {
      if (method === "DELETE") return { status: 202 };
      return { body: blobsXml([`folder/${calls.length}.txt`], [], `m${calls.length}`) };
    });
    await expect(deleteStorageObject(ctx, "acc", "c/folder/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("throws when a blob is still there after the deletes", async () => {
    const { ctx } = host((_url, method) => {
      if (method === "DELETE") return { status: 202 };
      return { body: blobsXml(["folder/stuck.txt"]) };
    });
    await expect(deleteStorageObject(ctx, "acc", "c/folder/")).rejects.toThrow(/still/);
  });

  it("throws on a delete that fails, rather than reporting the folder gone", async () => {
    const { ctx } = host((_url, method) => {
      if (method === "DELETE") return { status: 409 };
      return { body: blobsXml(["folder/leased.txt"]) };
    });
    await expect(deleteStorageObject(ctx, "acc", "c/folder/")).rejects.toThrow(
      /delete failed: 409/,
    );
  });
});

describe("uploadStorageObject", () => {
  it("PUTs the blob with block-blob headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okText());
    const file = new File([new Uint8Array([1, 2, 3])], "f.bin", {
      type: "application/octet-stream",
    });
    await uploadStorageObject(ctx, "acc", "container/path/f.bin", file);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://acc.blob.core.windows.net/container/path/f.bin");
    expect(init!.method).toBe("PUT");
    expect((init!.headers as Record<string, string>)["x-ms-blob-type"]).toBe("BlockBlob");
  });

  it("throws on upload failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);
    const file = new File([new Uint8Array([1])], "f");
    await expect(uploadStorageObject(ctx, "acc", "c/f", file)).rejects.toThrow(
      /upload failed: 500/,
    );
  });
});

describe("makeStorageFolder", () => {
  it("PUTs a zero-length blob", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okText());
    await makeStorageFolder(ctx, "acc", "container/newfolder/");
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["Content-Length"]).toBeUndefined();
    expect(init!.body).toBeInstanceOf(Uint8Array);
  });

  it("throws on mkdir failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
    } as unknown as Response);
    await expect(makeStorageFolder(ctx, "acc", "c/f/")).rejects.toThrow(/mkdir failed: 409/);
  });
});

describe("deleteStorageObject", () => {
  it("DELETEs a single blob", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okText());
    await deleteStorageObject(ctx, "acc", "container/file.txt");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://acc.blob.core.windows.net/container/file.txt");
    expect(init!.method).toBe("DELETE");
  });

  it("tolerates a 404 on delete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);
    await expect(deleteStorageObject(ctx, "acc", "c/f")).resolves.toBeUndefined();
  });

  it("throws on other delete failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);
    await expect(deleteStorageObject(ctx, "acc", "c/f")).rejects.toThrow(/delete failed: 500/);
  });
});
