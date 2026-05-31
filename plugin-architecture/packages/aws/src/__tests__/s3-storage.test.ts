import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchSigned = vi.fn();
vi.mock("../signed-request.js", () => ({ fetchSigned: (...a: unknown[]) => fetchSigned(...a) }));

import {
  uploadStorageObject,
  listStorageObjects,
  makeStorageFolder,
  deleteStorageObject,
  getBucketPolicy,
  putBucketPolicy,
} from "../s3-storage.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function xmlRes(xml: string) {
  return { text: async () => xml };
}

beforeEach(() => fetchSigned.mockReset());

describe("listStorageObjects", () => {
  it("maps common prefixes (dirs) and objects, paginates via continuation token", async () => {
    fetchSigned
      .mockResolvedValueOnce(
        xmlRes(
          `<R><CommonPrefixes><Prefix>foo/sub/</Prefix></CommonPrefixes>` +
            `<Contents><Key>foo/a.txt</Key><Size>10</Size><LastModified>2020</LastModified></Contents>` +
            `<Contents><Key>foo/</Key><Size>0</Size></Contents>` +
            `<IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken></R>`,
        ),
      )
      .mockResolvedValueOnce(
        xmlRes(
          `<R><Contents><Key>foo/b.txt</Key><Size>20</Size></Contents><IsTruncated>false</IsTruncated></R>`,
        ),
      );
    const out = await listStorageObjects(creds, "bucket", "foo/");
    const dir = out.find((o) => o.isDirectory);
    expect(dir!.name).toBe("sub");
    expect(out.find((o) => o.name === "a.txt")!.size).toBe(10);
    // folder placeholder (key === prefix) skipped
    expect(out.find((o) => o.name === "")).toBeUndefined();
    expect(out.find((o) => o.name === "b.txt")).toBeTruthy();
    expect(fetchSigned).toHaveBeenCalledTimes(2);
    const url = (fetchSigned.mock.calls[1]![0] as { url: string }).url;
    expect(url).toContain("continuation-token=tok");
  });

  it("works with empty prefix", async () => {
    fetchSigned.mockResolvedValue(xmlRes(`<R><IsTruncated>false</IsTruncated></R>`));
    expect(await listStorageObjects(creds, "bucket", "")).toEqual([]);
  });
});

describe("uploadStorageObject", () => {
  it("PUTs with content-type + length headers", async () => {
    fetchSigned.mockResolvedValue({});
    const file = {
      type: "text/plain",
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as File;
    await uploadStorageObject(creds, "bucket", "path/to key.txt", file);
    const arg = fetchSigned.mock.calls[0]![0] as {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(arg.method).toBe("PUT");
    expect(arg.headers["Content-Type"]).toBe("text/plain");
    expect(arg.headers["Content-Length"]).toBe("4");
    expect(arg.url).toContain("/path/to%20key.txt");
  });
});

describe("makeStorageFolder", () => {
  it("PUTs a trailing-slash key", async () => {
    fetchSigned.mockResolvedValue({});
    await makeStorageFolder(creds, "bucket", "newdir");
    expect((fetchSigned.mock.calls[0]![0] as { url: string }).url).toContain("/newdir/");
  });
});

describe("deleteStorageObject", () => {
  it("deletes a single object", async () => {
    fetchSigned.mockResolvedValue({});
    await deleteStorageObject(creds, "bucket", "file.txt");
    expect((fetchSigned.mock.calls[0]![0] as { method: string }).method).toBe("DELETE");
  });

  it("recursively deletes a folder (lists, deletes children + placeholder)", async () => {
    // First call: listStorageObjects under "dir/" → one nested dir + one file
    fetchSigned
      .mockResolvedValueOnce(
        xmlRes(
          `<R><CommonPrefixes><Prefix>dir/nested/</Prefix></CommonPrefixes>` +
            `<Contents><Key>dir/a.txt</Key><Size>1</Size></Contents><IsTruncated>false</IsTruncated></R>`,
        ),
      )
      // recursion into nested dir: empty
      .mockResolvedValueOnce(xmlRes(`<R><IsTruncated>false</IsTruncated></R>`))
      // remaining DELETE calls resolve
      .mockResolvedValue({});
    await deleteStorageObject(creds, "bucket", "dir/");
    const deletes = fetchSigned.mock.calls.filter(
      (c) => (c[0] as { method: string }).method === "DELETE",
    );
    expect(deletes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getBucketPolicy", () => {
  it("returns policy text", async () => {
    fetchSigned.mockResolvedValue(xmlRes(`{"Version":"2012"}`));
    expect(await getBucketPolicy(creds, "bucket")).toContain("2012");
  });
  it("returns empty string on NoSuchBucketPolicy", async () => {
    fetchSigned.mockImplementationOnce(() =>
      Promise.reject(new Error("AWS s3 GET / failed: 404 — NoSuchBucketPolicy")),
    );
    expect(await getBucketPolicy(creds, "bucket")).toBe("");
  });
  it("rethrows other errors", async () => {
    fetchSigned.mockImplementationOnce(() => Promise.reject(new Error("AccessDenied 403")));
    await expect(getBucketPolicy(creds, "bucket")).rejects.toThrow(/AccessDenied/);
  });
});

describe("putBucketPolicy", () => {
  it("PUTs a non-empty policy", async () => {
    fetchSigned.mockResolvedValue({});
    await putBucketPolicy(creds, "bucket", '  {"a":1}  ');
    const arg = fetchSigned.mock.calls[0]![0] as { method: string; body: string };
    expect(arg.method).toBe("PUT");
    expect(arg.body).toBe('{"a":1}');
  });
  it("DELETEs when policy is empty", async () => {
    fetchSigned.mockResolvedValue({});
    await putBucketPolicy(creds, "bucket", "   ");
    expect((fetchSigned.mock.calls[0]![0] as { method: string }).method).toBe("DELETE");
  });
  it("swallows 404 on empty-policy delete", async () => {
    fetchSigned.mockImplementationOnce(() => Promise.reject(new Error("404 NoSuchBucketPolicy")));
    await expect(putBucketPolicy(creds, "bucket", "")).resolves.toBeUndefined();
  });
  it("rethrows other errors on empty-policy delete", async () => {
    fetchSigned.mockImplementationOnce(() => Promise.reject(new Error("AccessDenied")));
    await expect(putBucketPolicy(creds, "bucket", "")).rejects.toThrow(/AccessDenied/);
  });
});
