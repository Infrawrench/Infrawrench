import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the signed-fetch primitive so no network/crypto runs.
const signedS3Fetch = vi.fn();
vi.mock("../signed-s3-request.js", () => ({
  signedS3Fetch: (...args: unknown[]) => signedS3Fetch(...args),
}));

import {
  listS3Objects,
  uploadS3Object,
  deleteS3Object,
  makeS3Folder,
  getS3BucketPolicy,
  putS3BucketPolicy,
  virtualHostedUrl,
  pathStyleUrl,
  type S3StorageConfig,
} from "../s3-storage-helpers.js";

function resp(opts: { ok?: boolean; status?: number; text?: string }): Response {
  const status = opts.status ?? (opts.ok === false ? 400 : 200);
  return {
    ok: opts.ok ?? status < 400,
    status,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

const cfg: S3StorageConfig = {
  accessKey: "AK",
  secretKey: "SK",
  region: "nyc3",
  buildUrl: (bucket, key, query) =>
    `https://${bucket}.host/${key}?${new URLSearchParams(query).toString()}`,
};

beforeEach(() => {
  signedS3Fetch.mockReset();
});

describe("URL builders", () => {
  it("virtualHostedUrl builds {bucket}.{host}/{key} and encodes segments", () => {
    const build = virtualHostedUrl((region) => `${region}.example.com`)("nyc3");
    expect(build("mybucket", "")).toBe("https://mybucket.nyc3.example.com/");
    expect(build("mybucket", "a/b c.txt", { policy: "" })).toBe(
      "https://mybucket.nyc3.example.com/a/b%20c.txt?policy=",
    );
  });

  it("pathStyleUrl builds {host}/{bucket}/{key} and encodes segments", () => {
    const build = pathStyleUrl((region) => `${region}.example.com`)("fr-par");
    expect(build("mybucket", "")).toBe("https://fr-par.example.com/mybucket");
    expect(build("mybucket", "dir/obj name", { "list-type": "2" })).toBe(
      "https://fr-par.example.com/mybucket/dir/obj%20name?list-type=2",
    );
  });
});

describe("listS3Objects", () => {
  it("parses common prefixes (dirs) and contents (files), single page", async () => {
    const xml = `
      <ListBucketResult>
        <CommonPrefixes><Prefix>photos/sub/</Prefix></CommonPrefixes>
        <Contents><Key>photos/a.jpg</Key><Size>1024</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents>
        <Contents><Key>photos/</Key><Size>0</Size></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`;
    signedS3Fetch.mockResolvedValueOnce(resp({ text: xml }));

    const out = await listS3Objects(cfg, "mybucket", "photos/");
    // dir, one file (the "photos/" key equals prefix and is skipped)
    expect(out).toEqual([
      { key: "photos/sub/", name: "sub", size: 0, lastModified: "", isDirectory: true },
      {
        key: "photos/a.jpg",
        name: "a.jpg",
        size: 1024,
        lastModified: "2026-01-01T00:00:00Z",
        isDirectory: false,
      },
    ]);
  });

  it("follows continuation tokens across pages", async () => {
    const page1 = `<r><Contents><Key>a</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>TOK</NextContinuationToken></r>`;
    const page2 = `<r><Contents><Key>b</Key><Size>2</Size></Contents><IsTruncated>false</IsTruncated></r>`;
    signedS3Fetch
      .mockResolvedValueOnce(resp({ text: page1 }))
      .mockResolvedValueOnce(resp({ text: page2 }));

    const out = await listS3Objects(cfg, "b", "");
    expect(out.map((o) => o.key)).toEqual(["a", "b"]);
    expect(signedS3Fetch).toHaveBeenCalledTimes(2);
    // second call must carry continuation token
    expect(signedS3Fetch.mock.calls[1]![0]!.url).toContain("continuation-token=TOK");
  });

  it("throws a labeled error on non-ok list response", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 403, text: "AccessDenied" }));
    await expect(listS3Objects(cfg, "b", "")).rejects.toThrow(
      /S3 ListObjectsV2 failed: 403 AccessDenied/,
    );
  });
});

describe("uploadS3Object", () => {
  it("PUTs file bytes with content headers", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200 }));
    const file = {
      type: "text/plain",
      arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
    } as unknown as File;
    await uploadS3Object(cfg, "b", "k.txt", file);
    const arg = signedS3Fetch.mock.calls[0]![0]!;
    expect(arg.method).toBe("PUT");
    expect(arg.headers["content-type"]).toBe("text/plain");
    expect(arg.headers["content-length"]).toBe("2");
    expect(arg.body).toBeInstanceOf(Uint8Array);
  });

  it("defaults content-type to octet-stream when file.type is empty", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200 }));
    const file = { type: "", arrayBuffer: async () => new Uint8Array(0).buffer } as unknown as File;
    await uploadS3Object(cfg, "b", "k", file);
    expect(signedS3Fetch.mock.calls[0]![0]!.headers["content-type"]).toBe(
      "application/octet-stream",
    );
  });

  it("throws on non-ok upload", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 500, text: "err" }));
    const file = {
      type: "x",
      arrayBuffer: async () => new Uint8Array(0).buffer,
    } as unknown as File;
    await expect(uploadS3Object(cfg, "b", "k", file)).rejects.toThrow(/S3 PUT object failed: 500/);
  });
});

describe("makeS3Folder", () => {
  it("appends a trailing slash and PUTs a zero-byte marker", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200 }));
    await makeS3Folder(cfg, "b", "newdir");
    const arg = signedS3Fetch.mock.calls[0]![0]!;
    expect(arg.url).toContain("newdir/");
    expect(arg.headers["content-type"]).toBe("application/x-directory");
  });

  it("does not double up an existing trailing slash", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200 }));
    await makeS3Folder(cfg, "b", "dir/");
    expect(signedS3Fetch.mock.calls[0]![0]!.url).toContain("dir/?");
  });
});

describe("deleteS3Object", () => {
  it("deletes a single object", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 204 }));
    await deleteS3Object(cfg, "b", "k.txt");
    expect(signedS3Fetch).toHaveBeenCalledTimes(1);
    expect(signedS3Fetch.mock.calls[0]![0]!.method).toBe("DELETE");
  });

  it("tolerates a 404 on single object delete", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 404, text: "" }));
    await expect(deleteS3Object(cfg, "b", "k")).resolves.toBeUndefined();
  });

  it("throws on a non-404 error single object delete", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 500, text: "boom" }));
    await expect(deleteS3Object(cfg, "b", "k")).rejects.toThrow(/S3 DELETE object failed: 500/);
  });

  it("deletes all objects under a folder prefix and the marker", async () => {
    const listXml = `<r><Contents><Key>dir/a</Key></Contents><Contents><Key>dir/b</Key></Contents><IsTruncated>false</IsTruncated></r>`;
    signedS3Fetch
      .mockResolvedValueOnce(resp({ text: listXml })) // list
      .mockResolvedValueOnce(resp({ status: 204 })) // delete dir/a
      .mockResolvedValueOnce(resp({ status: 204 })) // delete dir/b
      .mockResolvedValueOnce(resp({ status: 204 })); // delete marker dir/

    await deleteS3Object(cfg, "b", "dir/");
    const methods = signedS3Fetch.mock.calls.map((c) => c[0].method);
    expect(methods[0]).toBe("GET");
    expect(methods.slice(1)).toEqual(["DELETE", "DELETE", "DELETE"]);
  });

  it("does not re-delete the marker when it appears in the listing", async () => {
    const listXml = `<r><Contents><Key>dir/</Key></Contents><Contents><Key>dir/a</Key></Contents><IsTruncated>false</IsTruncated></r>`;
    signedS3Fetch
      .mockResolvedValueOnce(resp({ text: listXml }))
      .mockResolvedValue(resp({ status: 204 }));
    await deleteS3Object(cfg, "b", "dir/");
    // 1 list + 2 deletes (dir/ and dir/a), no extra marker delete
    expect(signedS3Fetch).toHaveBeenCalledTimes(3);
  });
});

describe("getS3BucketPolicy", () => {
  it("returns empty string on 404", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 404 }));
    expect(await getS3BucketPolicy(cfg, "b")).toBe("");
  });

  it("returns empty string for NoSuchBucketPolicy error body", async () => {
    signedS3Fetch.mockResolvedValueOnce(
      resp({ ok: false, status: 400, text: "<Error>NoSuchBucketPolicy</Error>" }),
    );
    expect(await getS3BucketPolicy(cfg, "b")).toBe("");
  });

  it("throws on other errors", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 500, text: "boom" }));
    await expect(getS3BucketPolicy(cfg, "b")).rejects.toThrow(/GetBucketPolicy failed: 500/);
  });

  it("returns the policy body on success", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200, text: '{"Version":"2012"}' }));
    expect(await getS3BucketPolicy(cfg, "b")).toBe('{"Version":"2012"}');
  });
});

describe("putS3BucketPolicy", () => {
  it("PUTs a non-empty policy", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 200 }));
    await putS3BucketPolicy(cfg, "b", '{"x":1}');
    const arg = signedS3Fetch.mock.calls[0]![0]!;
    expect(arg.method).toBe("PUT");
    expect(arg.body).toBe('{"x":1}');
    expect(arg.headers["content-type"]).toBe("application/json");
  });

  it("DELETEs the policy when given empty/whitespace", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ status: 204 }));
    await putS3BucketPolicy(cfg, "b", "   ");
    expect(signedS3Fetch.mock.calls[0]![0]!.method).toBe("DELETE");
  });

  it("tolerates 404 on delete", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 404 }));
    await expect(putS3BucketPolicy(cfg, "b", "")).resolves.toBeUndefined();
  });

  it("throws on delete error other than 404", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 500, text: "x" }));
    await expect(putS3BucketPolicy(cfg, "b", "")).rejects.toThrow(/DeleteBucketPolicy failed: 500/);
  });

  it("throws on put error", async () => {
    signedS3Fetch.mockResolvedValueOnce(resp({ ok: false, status: 403, text: "denied" }));
    await expect(putS3BucketPolicy(cfg, "b", '{"x":1}')).rejects.toThrow(
      /PutBucketPolicy failed: 403/,
    );
  });
});
