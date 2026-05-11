import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isHostKeyTrustResponse,
  tryParseHostKeyTrustResponse,
  trustHostKey,
  type HostKeyTrustPayload,
} from "../host-key-trust";

const validPayload: HostKeyTrustPayload = {
  error: "ssh_host_key_trust_required",
  message: "Need consent",
  kind: "unknown",
  host: "example.com",
  port: 22,
  presentedFingerprint: "SHA256:abc123",
  storedFingerprint: null,
};

describe("isHostKeyTrustResponse", () => {
  it("accepts a valid unknown-host payload", () => {
    expect(isHostKeyTrustResponse(validPayload)).toBe(true);
  });

  it("accepts a valid mismatch payload with stored fingerprint", () => {
    expect(
      isHostKeyTrustResponse({
        ...validPayload,
        kind: "mismatch",
        storedFingerprint: "SHA256:old",
      }),
    ).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(isHostKeyTrustResponse(null)).toBe(false);
    expect(isHostKeyTrustResponse(undefined)).toBe(false);
    expect(isHostKeyTrustResponse("string")).toBe(false);
    expect(isHostKeyTrustResponse(42)).toBe(false);
  });

  it("rejects wrong discriminant", () => {
    expect(isHostKeyTrustResponse({ ...validPayload, error: "other" })).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(isHostKeyTrustResponse({ ...validPayload, kind: "weird" })).toBe(false);
  });

  it("rejects missing host or port", () => {
    expect(isHostKeyTrustResponse({ ...validPayload, host: "" })).toBe(false);
    expect(isHostKeyTrustResponse({ ...validPayload, port: "22" })).toBe(false);
  });

  it("rejects bad fingerprint types", () => {
    expect(isHostKeyTrustResponse({ ...validPayload, presentedFingerprint: 1 })).toBe(false);
    expect(isHostKeyTrustResponse({ ...validPayload, storedFingerprint: 42 })).toBe(false);
  });
});

describe("tryParseHostKeyTrustResponse", () => {
  it("returns the payload for a matching 409", async () => {
    const res = new Response(JSON.stringify(validPayload), { status: 409 });
    expect(await tryParseHostKeyTrustResponse(res)).toEqual(validPayload);
  });

  it("returns null for non-409 statuses", async () => {
    const res = new Response(JSON.stringify(validPayload), { status: 400 });
    expect(await tryParseHostKeyTrustResponse(res)).toBeNull();
  });

  it("returns null when the 409 body is not the trust shape", async () => {
    const res = new Response(JSON.stringify({ error: "something_else" }), { status: 409 });
    expect(await tryParseHostKeyTrustResponse(res)).toBeNull();
  });

  it("returns null when the 409 body is not JSON", async () => {
    const res = new Response("not json", { status: 409 });
    expect(await tryParseHostKeyTrustResponse(res)).toBeNull();
  });
});

describe("trustHostKey", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("POSTs the presented fingerprint and resolves on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await trustHostKey("org_1", validPayload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/org/org_1/ssh-host-keys/trust");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:abc123",
    });
  });

  it("includes previousFingerprint when storedFingerprint is set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await trustHostKey("org_1", {
      ...validPayload,
      kind: "mismatch",
      storedFingerprint: "SHA256:old",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.previousFingerprint).toBe("SHA256:old");
  });

  it("throws with trustPayload attached when the server returns a race 409", async () => {
    const racePayload: HostKeyTrustPayload = {
      ...validPayload,
      kind: "mismatch",
      presentedFingerprint: "SHA256:newer",
      storedFingerprint: "SHA256:abc123",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(racePayload), { status: 409 }),
      ) as unknown as typeof fetch;

    await expect(trustHostKey("org_1", validPayload)).rejects.toMatchObject({
      trustPayload: racePayload,
    });
  });

  it("throws a plain Error on other failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      ) as unknown as typeof fetch;

    await expect(trustHostKey("org_1", validPayload)).rejects.toThrow("forbidden");
  });
});
