import { describe, it, expect, vi, afterEach } from "vitest";
import { signedS3Fetch } from "../signed-s3-request.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signedS3Fetch", () => {
  it("signs a GET request and calls fetch with Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await signedS3Fetch({
      accessKey: "AKIA",
      secretKey: "secret",
      region: "us-east-1",
      method: "GET",
      url: "https://bucket.s3.amazonaws.com/?list-type=2&prefix=foo",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://bucket.s3.amazonaws.com/?list-type=2&prefix=foo");
    expect(init.method).toBe("GET");
    const auth = init.headers["authorization"] ?? init.headers["Authorization"];
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("Credential=AKIA/");
    // GET has no body
    expect(init.body).toBeUndefined();
  });

  it("signs a PUT request with a body and forwards it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const body = new Uint8Array([1, 2, 3]);

    await signedS3Fetch({
      accessKey: "AKIA",
      secretKey: "secret",
      region: "nyc3",
      service: "s3",
      method: "PUT",
      url: "https://host:9000/bucket/key",
      headers: { "content-type": "text/plain" },
      body,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(body);
  });

  it("uses a custom signing service when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await signedS3Fetch({
      accessKey: "AKIA",
      secretKey: "secret",
      region: "fr-par",
      service: "execute-api",
      method: "GET",
      url: "https://api.example.com/path",
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const auth = init.headers["authorization"] ?? init.headers["Authorization"];
    expect(auth).toContain("/execute-api/aws4_request");
  });

  it("handles a root path url with no explicit path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await signedS3Fetch({
      accessKey: "AKIA",
      secretKey: "secret",
      region: "us-east-1",
      method: "GET",
      url: "https://host.example.com",
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});
