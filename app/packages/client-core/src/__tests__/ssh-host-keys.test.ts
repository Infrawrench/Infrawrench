import { describe, expect, it } from "vitest";
import {
  hostKeyLabel,
  hostKeyTrustRequestBody,
  isHostKeyTrustResponse,
  trustPayloadFromFrame,
  type HostKeyTrustPayload,
} from "../ssh-host-keys";

const payload: HostKeyTrustPayload = {
  error: "ssh_host_key_trust_required",
  message: "Need consent",
  kind: "unknown",
  host: "example.com",
  port: 22,
  presentedFingerprint: "SHA256:abc123",
  storedFingerprint: null,
};

describe("trustPayloadFromFrame", () => {
  it("builds a payload from the proxy's ssh:error frame", () => {
    expect(
      trustPayloadFromFrame({
        type: "ssh:error",
        error: "Host key is not trusted",
        code: "ssh_host_key_trust_required",
        kind: "unknown",
        host: "example.com",
        port: 22,
        presentedFingerprint: "SHA256:abc123",
      }),
    ).toEqual({ ...payload, message: "Host key is not trusted" });
  });

  it("carries the stored fingerprint through on a mismatch", () => {
    expect(
      trustPayloadFromFrame({
        type: "ssh:error",
        error: "Host key changed",
        code: "ssh_host_key_trust_required",
        kind: "mismatch",
        host: "example.com",
        port: 2222,
        presentedFingerprint: "SHA256:new",
        storedFingerprint: "SHA256:old",
      }),
    ).toMatchObject({ kind: "mismatch", storedFingerprint: "SHA256:old", port: 2222 });
  });

  it("returns null for an ordinary error frame", () => {
    expect(trustPayloadFromFrame({ type: "ssh:error", error: "Connection refused" })).toBeNull();
    expect(trustPayloadFromFrame(null)).toBeNull();
  });

  it("returns null when the frame is marked but incomplete", () => {
    // A frame that claims the code but lacks the fingerprint can't be
    // rendered — treating it as a prompt would ask the operator to trust
    // nothing at all.
    expect(
      trustPayloadFromFrame({
        type: "ssh:error",
        code: "ssh_host_key_trust_required",
        kind: "unknown",
        host: "example.com",
        port: 22,
      }),
    ).toBeNull();
  });
});

describe("hostKeyTrustRequestBody", () => {
  it("omits previousFingerprint when nothing was pinned", () => {
    expect(hostKeyTrustRequestBody(payload)).toEqual({
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:abc123",
    });
  });

  it("sends previousFingerprint when replacing a pin", () => {
    expect(
      hostKeyTrustRequestBody({ ...payload, kind: "mismatch", storedFingerprint: "SHA256:old" }),
    ).toEqual({
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:abc123",
      previousFingerprint: "SHA256:old",
    });
  });
});

describe("isHostKeyTrustResponse", () => {
  it("accepts the HTTP 409 body", () => {
    expect(isHostKeyTrustResponse(payload)).toBe(true);
  });

  it("rejects a body with a different error", () => {
    expect(isHostKeyTrustResponse({ ...payload, error: "something_else" })).toBe(false);
  });
});

describe("hostKeyLabel", () => {
  it("hides the default port", () => {
    expect(hostKeyLabel({ host: "example.com", port: 22 })).toBe("example.com");
    expect(hostKeyLabel({ host: "example.com", port: 2222 })).toBe("example.com:2222");
  });
});
