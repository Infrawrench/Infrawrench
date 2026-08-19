import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The relay reaches for the database only once it knows it is part of a
// replica set; importing the real client would open a pool for tests that
// never get that far.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ replicaSessionOwners: {} }));

const { claimSession, isForwardableAddress, relayAddress, relayEnabled, verifyRelaySecret } =
  await import("../replica-relay");

const env = { ...process.env };

beforeEach(() => {
  delete process.env["POD_IP"];
  delete process.env["INTERNAL_RELAY_SECRET"];
  delete process.env["PORT"];
});

afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe("forwardable addresses", () => {
  it("accepts the private ranges a pod IP comes from", () => {
    for (const address of [
      "10.4.1.7:3000",
      "172.16.0.1:3000",
      "172.31.255.254:80",
      "192.168.1.9:3000",
    ]) {
      expect(isForwardableAddress(address), address).toBe(true);
    }
  });

  it("refuses anything that is not a private pod address", () => {
    // The table is written by our own pods, so this is defence in depth — but
    // a row naming a public host would turn every replica into an open
    // forwarder for an authenticated internal endpoint.
    for (const address of [
      "8.8.8.8:3000", // public
      "172.32.0.1:3000", // just past the /12
      "169.254.169.254:80", // the metadata server, the one that always matters
      "10.4.1.7", // no port
      "example.com:3000", // a name, which could resolve anywhere
      "10.4.1.7:99999", // not a port
      "10.4.1.999:3000", // not an octet
      "http://10.4.1.7:3000", // a URL, not an address
      "",
    ]) {
      expect(isForwardableAddress(address), address).toBe(false);
    }
  });
});

describe("enablement", () => {
  it("is off with no pod address, and claims resolve to this process", async () => {
    expect(relayAddress()).toBeUndefined();
    expect(relayEnabled()).toBe(false);
    // The single-process path: a dev server and the test suite must behave
    // exactly as they did before the relay existed.
    await expect(claimSession("linux-app", "org1:r1")).resolves.toEqual({ owner: "self" });
  });

  it("stays off, loudly, when it could not authenticate a forward", async () => {
    // An address without a secret would mean forwarding onto an endpoint that
    // cannot tell a sibling pod from anyone else who can reach it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["POD_IP"] = "10.4.1.7";
    expect(relayAddress()).toBe("10.4.1.7:3000");
    expect(relayEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_RELAY_SECRET"));
    await expect(claimSession("linux-app", "org1:r1")).resolves.toEqual({ owner: "self" });
  });

  it("takes its port from PORT, as the deployment sets it", () => {
    process.env["POD_IP"] = "10.4.1.7";
    process.env["PORT"] = "8080";
    expect(relayAddress()).toBe("10.4.1.7:8080");
  });

  it("has no address when the pod IP is not one we would dial", () => {
    process.env["POD_IP"] = "203.0.113.5";
    expect(relayAddress()).toBeUndefined();
  });
});

describe("the shared secret", () => {
  beforeEach(() => {
    process.env["INTERNAL_RELAY_SECRET"] = "s3cr3t-value";
  });

  it("accepts the configured secret as a bearer token", () => {
    expect(verifyRelaySecret("Bearer s3cr3t-value")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(verifyRelaySecret("Bearer wrong-value!")).toBe(false);
    expect(verifyRelaySecret("Bearer s3cr3t")).toBe(false); // a prefix is not a match
    expect(verifyRelaySecret("s3cr3t-value")).toBe(false); // no scheme
    expect(verifyRelaySecret("Basic s3cr3t-value")).toBe(false);
    expect(verifyRelaySecret(undefined)).toBe(false);
    expect(verifyRelaySecret("Bearer ")).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    // Otherwise an unconfigured deployment would accept the empty token.
    delete process.env["INTERNAL_RELAY_SECRET"];
    expect(verifyRelaySecret("Bearer ")).toBe(false);
    expect(verifyRelaySecret("Bearer anything")).toBe(false);
  });
});
