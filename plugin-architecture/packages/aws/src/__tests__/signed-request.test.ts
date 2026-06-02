import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fetchSigned } from "../signed-request.js";

const baseCreds = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" };

afterEach(() => vi.restoreAllMocks());

describe("fetchSigned over global fetch", () => {
  it("signs a GET and returns the response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await fetchSigned({
      method: "GET",
      url: "https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs",
      headers: { Host: "ec2.us-east-1.amazonaws.com" },
      service: "ec2",
      credentials: baseCreds,
    });
    expect(await res.text()).toBe("ok");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("GET");
    // signature headers present
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.toLowerCase() === "authorization")).toBe(true);
    // GET omits the body
    expect(init.body).toBeUndefined();
  });

  it("sends a POST body and signs with a session token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchSigned({
      method: "POST",
      url: "https://ecs.us-east-1.amazonaws.com/",
      headers: {
        Host: "ecs.us-east-1.amazonaws.com",
        "Content-Type": "application/x-amz-json-1.1",
      },
      body: '{"a":1}',
      service: "ecs",
      credentials: { ...baseCreds, sessionToken: "session-tok" },
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"a":1}');
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.toLowerCase() === "x-amz-security-token")).toBe(true);
  });

  it("throws with body detail on a non-2xx fetch response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("AccessDenied", { status: 403 }));
    await expect(
      fetchSigned({
        method: "GET",
        url: "https://s3.us-east-1.amazonaws.com/",
        headers: { Host: "s3.us-east-1.amazonaws.com" },
        service: "s3",
        credentials: baseCreds,
      }),
    ).rejects.toThrow(/failed: 403 — AccessDenied/);
  });
});

describe("fetchSigned over the host http transport", () => {
  function httpCreds(request: Mock) {
    return { ...baseCreds, http: { request } };
  }

  it("routes a POST through host.http.request and wraps the Response", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }));
    const res = await fetchSigned({
      method: "POST",
      url: "https://sqs.us-east-1.amazonaws.com/",
      headers: { Host: "sqs.us-east-1.amazonaws.com" },
      body: '{"x":1}',
      service: "sqs",
      credentials: httpCreds(request) as never,
    });
    expect(await res.json()).toEqual({ ok: true });
    const arg = (request.mock.calls as unknown as unknown[][])[0]![0] as {
      method: string;
      body: unknown;
    };
    expect(arg.method).toBe("POST");
    expect(arg.body).toBe('{"x":1}');
  });

  it("omits the body for GET requests over http transport", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "<xml/>" }));
    await fetchSigned({
      method: "GET",
      url: "https://ec2.us-east-1.amazonaws.com/?Action=X",
      headers: { Host: "ec2.us-east-1.amazonaws.com" },
      service: "ec2",
      credentials: httpCreds(request) as never,
    });
    expect(
      ((request.mock.calls as unknown as unknown[][])[0]![0] as { body?: unknown }).body,
    ).toBeUndefined();
  });

  it("converts an ArrayBuffer body to Uint8Array for the http transport", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
    await fetchSigned({
      method: "PUT",
      url: "https://bucket.s3.us-east-1.amazonaws.com/key",
      headers: { Host: "bucket.s3.us-east-1.amazonaws.com" },
      body: new ArrayBuffer(8),
      service: "s3",
      credentials: httpCreds(request) as never,
    });
    expect(
      ((request.mock.calls as unknown as unknown[][])[0]![0] as { body: unknown }).body,
    ).toBeInstanceOf(Uint8Array);
  });

  it("throws on a non-2xx http transport response", async () => {
    const request = vi.fn(async () => ({ status: 500, headers: {}, body: "boom" }));
    await expect(
      fetchSigned({
        method: "GET",
        url: "https://ec2.us-east-1.amazonaws.com/",
        headers: { Host: "ec2.us-east-1.amazonaws.com" },
        service: "ec2",
        credentials: httpCreds(request) as never,
      }),
    ).rejects.toThrow(/failed: 500 — boom/);
  });
});
