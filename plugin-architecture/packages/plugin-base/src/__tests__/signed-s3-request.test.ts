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

  describe("canonical path", () => {
    const creds = {
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    async function authFor(url: string, headers?: Record<string, string>) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2013-05-24T00:00:00Z"));
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      await signedS3Fetch({
        ...creds,
        method: "GET",
        url,
        ...(headers ? { headers } : {}),
        fetch: fetchMock,
      });
      const [sentUrl, init] = fetchMock.mock.calls[0]!;
      const h = init.headers as Record<string, string>;
      return { sentUrl: sentUrl as string, auth: h["authorization"] ?? h["Authorization"] };
    }

    it("matches AWS's published GET Object example", async () => {
      const { auth } = await authFor("https://examplebucket.s3.amazonaws.com/test.txt", {
        range: "bytes=0-9",
      });
      expect(auth).toContain(
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
      );
    });

    // A space, `+` and non-ASCII used to be escaped twice (`%20` signed as
    // `%2520`), so S3 answered SignatureDoesNotMatch. The expected signature
    // comes from an independent SigV4 implementation that reproduces the AWS
    // example above.
    it("encodes keys with spaces, plus signs and unicode exactly once", async () => {
      const { sentUrl, auth } = await authFor(
        "https://examplebucket.s3.amazonaws.com/my%20photos/caf%C3%A9+1.txt",
      );
      expect(sentUrl).toBe("https://examplebucket.s3.amazonaws.com/my%20photos/caf%C3%A9%2B1.txt");
      expect(auth).toContain(
        "Signature=d31535258c314f80cf402e9c4fdfc8e2978b8d3b634b65c21eb14f45b8fb3774",
      );
    });

    it("signs the same request however loosely the caller encoded the key", async () => {
      const a = await authFor("https://examplebucket.s3.amazonaws.com/a(1)!.txt");
      vi.useRealTimers();
      const b = await authFor("https://examplebucket.s3.amazonaws.com/a%281%29%21.txt");
      expect(a.sentUrl).toBe(b.sentUrl);
      expect(a.auth).toBe(b.auth);
    });
  });
});
