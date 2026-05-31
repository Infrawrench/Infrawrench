import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import {
  listStorageObjects,
  uploadStorageObject,
  makeStorageFolder,
  deleteStorageObject,
} from "../storage-client.js";

const ctx = { storageToken: vi.fn(async () => "stg-tok") };

// Minimal DOMParser shim covering the subset the parser uses
// (querySelectorAll on BlobPrefix / Blobs > Blob, and querySelector for child tags).
class FakeElement {
  constructor(
    public tag: string,
    public children: FakeElement[] = [],
    public text = "",
  ) {}
  querySelector(sel: string): FakeElement | null {
    return this.descendants().find((e) => e.tag === sel) ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    if (sel === "Blobs > Blob") {
      const blobs = this.descendants().find((e) => e.tag === "Blobs");
      return blobs ? blobs.children.filter((c) => c.tag === "Blob") : [];
    }
    return this.descendants().filter((e) => e.tag === sel);
  }
  get textContent() {
    return this.text;
  }
  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      out.push(c, ...c.descendants());
    }
    return out;
  }
}

function buildDoc(): FakeElement {
  // A nested sub-prefix as Azure returns it when listing under prefix "folder/".
  const blobPrefix = new FakeElement("BlobPrefix", [new FakeElement("Name", [], "folder/sub/")]);
  const blobProps = new FakeElement("Properties", [
    new FakeElement("Content-Length", [], "1024"),
    new FakeElement("Last-Modified", [], "2024-01-01"),
    new FakeElement("Content-Type", [], "text/plain"),
  ]);
  const blob = new FakeElement("Blob", [new FakeElement("Name", [], "folder/file.txt"), blobProps]);
  const blobs = new FakeElement("Blobs", [blob]);
  return new FakeElement("root", [blobPrefix, blobs]);
}

beforeAll(() => {
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
    parseFromString() {
      return buildDoc();
    }
  };
});

afterEach(() => vi.restoreAllMocks());

function okText(text = ""): Response {
  return { ok: true, status: 200, text: async () => text } as unknown as Response;
}

describe("listStorageObjects", () => {
  it("parses directories and files from the XML enumeration", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okText("<xml/>"));
    const out = await listStorageObjects(ctx, "myaccount", "folder/");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("myaccount.blob.core.windows.net");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer stg-tok");
    const dir = out.find((o) => o.isDirectory);
    expect(dir).toMatchObject({ name: "sub", isDirectory: true });
    const file = out.find((o) => !o.isDirectory);
    expect(file).toMatchObject({ name: "file.txt", size: 1024, contentType: "text/plain" });
  });

  it("throws on a non-ok list response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);
    await expect(listStorageObjects(ctx, "acc", "")).rejects.toThrow(/Blob list failed: 403/);
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
    expect((init!.headers as Record<string, string>)["Content-Length"]).toBe("0");
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

  it("recursively deletes blobs under a prefix", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okText("<xml/>"));
    await deleteStorageObject(ctx, "acc", "folder/");
    // One list call (ends with ?...) + one delete for the single file blob.
    const deleteCalls = fetchSpy.mock.calls.filter(
      (c) => (c[1] as RequestInit)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(1);
  });
});
