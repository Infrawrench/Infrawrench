import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Destination tests. What actually carries risk here:
 *
 *  - **single PUT vs multipart**, because the whole point of this module is
 *    that a large object never becomes one Buffer. A regression that quietly
 *    buffered would still pass a naive "did it upload" assertion, so the tests
 *    assert on the *shape* of the request sequence and on the size of each
 *    part;
 *  - **aborting a failed multipart upload**, since an abandoned one is
 *    billable storage forever on most providers;
 *  - **URL construction**, where path-style vs virtual-hosted addressing is
 *    the difference between working on MinIO and working on AWS — and, for
 *    HTTPS, where any mutation of a pre-signed URL is a total upload outage;
 *  - **error text**, because "403" is not something a user can act on and
 *    S3's own `<Message>` is.
 */

interface SignedCall {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  bodyLength: number;
}

const signedCalls: SignedCall[] = [];
let signedResponder: (call: SignedCall) => Response = () => new Response("", { status: 200 });

vi.mock("@infrawrench/plugin-base", () => ({
  signedS3Fetch: async (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }) => {
    const call: SignedCall = {
      method: opts.method,
      url: opts.url,
      headers: opts.headers,
      bodyLength:
        typeof opts.body === "string" ? Buffer.byteLength(opts.body) : (opts.body?.byteLength ?? 0),
    };
    signedCalls.push(call);
    return signedResponder(call);
  },
}));

const { PART_SIZE, uploadCostExportObject, CostExportUploadError } =
  await import("../cost-exports/destinations");

const stamp = {
  periodStart: "2026-08-07",
  from: "2026-08-07",
  to: "2026-08-07",
  exportedAt: "2026-08-08T04:00:00.000Z",
  collectionWatermark: "2026-08-06",
};

const s3Destination = {
  kind: "s3" as const,
  bucket: "finance",
  prefix: "warehouse",
  region: "eu-central-1",
  endpoint: "",
  forcePathStyle: false,
};

const s3Credentials = { kind: "s3" as const, accessKeyId: "AKIA", secretAccessKey: "secret" };

async function* body(...pieces: string[]): AsyncGenerator<string> {
  for (const piece of pieces) yield piece;
}

beforeEach(() => {
  signedCalls.length = 0;
  signedResponder = () => new Response("", { status: 200 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3 upload — small objects", () => {
  it("uses one PUT and reports the byte count", async () => {
    const result = await uploadCostExportObject({
      destination: s3Destination,
      credentials: s3Credentials,
      key: "warehouse/cost-export/exp-1/daily/2026-08-07.csv",
      contentType: "text/csv; charset=utf-8",
      body: body("header\n", "row\n"),
      stamp,
    });

    expect(result.byteCount).toBe(11);
    expect(signedCalls).toHaveLength(1);
    expect(signedCalls[0]!.method).toBe("PUT");
    expect(signedCalls[0]!.url).toBe(
      "https://finance.s3.eu-central-1.amazonaws.com/warehouse/cost-export/exp-1/daily/2026-08-07.csv",
    );
  });

  it("stamps the object with the period and the collection watermark", async () => {
    await uploadCostExportObject({
      destination: s3Destination,
      credentials: s3Credentials,
      key: "k.csv",
      contentType: "text/csv",
      body: body("x"),
      stamp,
    });
    expect(signedCalls[0]!.headers).toMatchObject({
      "x-amz-meta-infrawrench-period-start": "2026-08-07",
      "x-amz-meta-infrawrench-collection-watermark": "2026-08-06",
    });
  });

  it("writes an empty object rather than skipping a period with no rows", async () => {
    const result = await uploadCostExportObject({
      destination: s3Destination,
      credentials: s3Credentials,
      key: "k.csv",
      contentType: "text/csv",
      body: body(),
      stamp,
    });
    expect(result.byteCount).toBe(0);
    expect(signedCalls).toHaveLength(1);
  });

  it("addresses the bucket as a path segment when asked (MinIO)", async () => {
    await uploadCostExportObject({
      destination: {
        ...s3Destination,
        endpoint: "https://minio.internal:9000",
        forcePathStyle: true,
      },
      credentials: s3Credentials,
      key: "a/b.csv",
      contentType: "text/csv",
      body: body("x"),
      stamp,
    });
    expect(signedCalls[0]!.url).toBe("https://minio.internal:9000/finance/a/b.csv");
  });

  it("accepts a bare host as an endpoint", async () => {
    await uploadCostExportObject({
      destination: { ...s3Destination, endpoint: "fra1.digitaloceanspaces.com" },
      credentials: s3Credentials,
      key: "a.csv",
      contentType: "text/csv",
      body: body("x"),
      stamp,
    });
    expect(signedCalls[0]!.url).toBe("https://finance.fra1.digitaloceanspaces.com/a.csv");
  });

  it("surfaces S3's own message, not just the status", async () => {
    signedResponder = () =>
      new Response("<Error><Message>Access Denied</Message></Error>", { status: 403 });
    await expect(
      uploadCostExportObject({
        destination: s3Destination,
        credentials: s3Credentials,
        key: "k.csv",
        contentType: "text/csv",
        body: body("x"),
        stamp,
      }),
    ).rejects.toThrow(/403.*Access Denied/);
  });

  it("refuses to run with credentials of the wrong kind", async () => {
    await expect(
      uploadCostExportObject({
        destination: s3Destination,
        credentials: { kind: "http", url: "https://example.com" },
        key: "k.csv",
        contentType: "text/csv",
        body: body("x"),
        stamp,
      }),
    ).rejects.toBeInstanceOf(CostExportUploadError);
  });
});

describe("S3 upload — large objects", () => {
  /** Two full parts plus a short tail, produced in small pieces like the real serialiser. */
  async function* bigBody(totalBytes: number): AsyncGenerator<string> {
    const piece = "x".repeat(64 * 1024);
    let written = 0;
    while (written < totalBytes) {
      const remaining = totalBytes - written;
      yield remaining >= piece.length ? piece : "x".repeat(remaining);
      written += Math.min(piece.length, remaining);
    }
  }

  it("switches to multipart and never holds more than one part", async () => {
    signedResponder = (call) => {
      if (call.url.includes("?uploads=")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (call.method === "PUT") {
        return new Response("", { status: 200, headers: { etag: '"abc"' } });
      }
      return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    };

    const total = PART_SIZE * 2 + 1024;
    const result = await uploadCostExportObject({
      destination: s3Destination,
      credentials: s3Credentials,
      key: "k.csv",
      contentType: "text/csv",
      body: bigBody(total),
      stamp,
    });

    expect(result.byteCount).toBe(total);

    const create = signedCalls.filter((c) => c.url.includes("?uploads="));
    const parts = signedCalls.filter((c) => c.url.includes("partNumber="));
    const complete = signedCalls.filter(
      (c) => c.method === "POST" && c.url.includes("uploadId=") && !c.url.includes("?uploads="),
    );
    expect(create).toHaveLength(1);
    expect(parts).toHaveLength(3);
    expect(complete).toHaveLength(1);

    // Every part but the last is exactly one part's worth — this is the
    // bounded-memory guarantee, expressed as a request shape.
    expect(parts[0]!.bodyLength).toBe(PART_SIZE);
    expect(parts[1]!.bodyLength).toBe(PART_SIZE);
    expect(parts[2]!.bodyLength).toBe(1024);
    expect(parts.map((p) => p.url.match(/partNumber=(\d+)/)?.[1])).toEqual(["1", "2", "3"]);
  });

  it("aborts the multipart upload when a part fails", async () => {
    signedResponder = (call) => {
      if (call.url.includes("?uploads=")) {
        return new Response("<Result><UploadId>up-1</UploadId></Result>");
      }
      if (call.method === "PUT") {
        return new Response("<Error><Message>Slow Down</Message></Error>", { status: 503 });
      }
      return new Response("");
    };

    await expect(
      uploadCostExportObject({
        destination: s3Destination,
        credentials: s3Credentials,
        key: "k.csv",
        contentType: "text/csv",
        body: bigBody(PART_SIZE + 10),
        stamp,
      }),
    ).rejects.toThrow(/Slow Down/);

    const abort = signedCalls.filter((c) => c.method === "DELETE" && c.url.includes("uploadId="));
    expect(abort).toHaveLength(1);
  });

  it("treats a 200 containing an <Error> document as a failure", async () => {
    signedResponder = (call) => {
      if (call.url.includes("?uploads=")) {
        return new Response("<Result><UploadId>up-1</UploadId></Result>");
      }
      if (call.method === "PUT") {
        return new Response("", { status: 200, headers: { etag: '"abc"' } });
      }
      if (call.method === "DELETE") return new Response("");
      return new Response("<Error><Message>InternalError</Message></Error>", { status: 200 });
    };

    await expect(
      uploadCostExportObject({
        destination: s3Destination,
        credentials: s3Credentials,
        key: "k.csv",
        contentType: "text/csv",
        body: bigBody(PART_SIZE + 10),
        stamp,
      }),
    ).rejects.toThrow(/InternalError/);
  });
});

describe("HTTPS upload", () => {
  it("streams the body and names the object in a header", async () => {
    let seenInit: RequestInit & { headers?: Record<string, string> } = {};
    let seenUrl = "";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown, init: unknown) => {
        seenUrl = String(url);
        seenInit = init as RequestInit & { headers?: Record<string, string> };
        // Drain the stream the way a real server would, so the byte counter runs.
        const stream = (init as { body?: ReadableStream }).body;
        if (stream) {
          const reader = stream.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
        return new Response("", { status: 202 });
      });

    const result = await uploadCostExportObject({
      destination: { kind: "http", method: "POST", urlHint: "wh.example.com/…abcd" },
      credentials: { kind: "http", url: "https://wh.example.com/ingest?sig=abcd" },
      key: "cost-export/exp-1/daily/2026-08-07.ndjson",
      contentType: "application/x-ndjson",
      body: body("{}\n", "{}\n"),
      stamp,
    });

    expect(result.byteCount).toBe(6);
    expect(seenInit.method).toBe("POST");
    expect(seenUrl).toBe("https://wh.example.com/ingest?sig=abcd");
    expect(seenInit.headers).toMatchObject({
      "x-infrawrench-object-key": "cost-export/exp-1/daily/2026-08-07.ndjson",
      "x-infrawrench-collection-watermark": "2026-08-06",
    });
    expect((seenInit as { duplex?: string }).duplex).toBe("half");
    fetchSpy.mockRestore();
  });

  /**
   * The regression this guards: appending `?key=` to the destination URL. A
   * pre-signed URL signs its query string, so one extra parameter makes the
   * receiver reject every upload — and the key is already in a header.
   */
  it.each([
    // AWS SigV4 (also R2, Spaces, Scaleway).
    "https://bucket.s3.eu-central-1.amazonaws.com/costs/2026-08-07.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260807%2Feu-central-1%2Fs3%2Faws4_request&X-Amz-Date=20260807T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef",
    // GCS V4.
    "https://storage.googleapis.com/finance/2026-08-07.csv?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc123",
    // Azure SAS.
    "https://acct.blob.core.windows.net/costs/2026-08-07.csv?sv=2023-11-03&sig=Zm9vYmFy%3D&se=2026-08-08T00%3A00%3A00Z",
    // An ingest endpoint whose token happens not to be called anything we know,
    // and which already uses a `key` parameter of its own.
    "https://ingest.example.com/v1/drop?token=opaque&key=theirs",
  ])("sends a pre-signed URL byte-for-byte: %s", async (url) => {
    let seenUrl: unknown = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (target: unknown) => {
      seenUrl = target;
      return new Response("", { status: 200 });
    });

    await uploadCostExportObject({
      destination: { kind: "http", method: "PUT", urlHint: "x" },
      credentials: { kind: "http", url },
      key: "cost-export/exp-1/daily/2026-08-07.csv",
      contentType: "text/csv",
      body: body("x"),
      stamp,
    });

    // A string, not a URL object: nothing here re-serialises the credential.
    expect(seenUrl).toBe(url);
    fetchSpy.mockRestore();
  });

  it("fails loudly on a rejected POST", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      uploadCostExportObject({
        destination: { kind: "http", method: "POST", urlHint: "x" },
        credentials: { kind: "http", url: "https://wh.example.com/ingest" },
        key: "k.csv",
        contentType: "text/csv",
        body: body("x"),
        stamp,
      }),
    ).rejects.toThrow(/500/);
    fetchSpy.mockRestore();
  });
});
