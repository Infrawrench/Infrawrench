import { describe, expect, it, vi } from "vitest";

// custom-hostname → store → db/client, which throws without DATABASE_URL.
vi.mock("../../db/client", () => ({ db: {} }));

import { mapCfStatus, normalizeCustomHostname } from "../custom-hostname";

describe("mapCfStatus", () => {
  it("handles a fresh hostname whose ssl block has no validation_errors yet", () => {
    // Cloudflare omits `validation_errors` until validation has failed once;
    // spreading the missing array used to throw and turn every first attach
    // into a 500.
    expect(
      mapCfStatus({
        id: "ch1",
        hostname: "status.acme.com",
        status: "pending",
        ssl: { status: "pending_validation" },
      }),
    ).toEqual({ status: "pending_dns", error: null });
  });

  it("handles a response with no ssl block at all", () => {
    expect(mapCfStatus({ id: "ch1", hostname: "status.acme.com", status: "pending" })).toEqual({
      status: "pending_dns",
      error: null,
    });
  });

  it("is active only when both hostname and certificate are", () => {
    expect(
      mapCfStatus({
        id: "ch1",
        hostname: "status.acme.com",
        status: "active",
        ssl: { status: "active" },
      }),
    ).toEqual({ status: "active", error: null });
    expect(
      mapCfStatus({
        id: "ch1",
        hostname: "status.acme.com",
        status: "active",
        ssl: { status: "pending_validation" },
      }),
    ).toEqual({ status: "pending_ssl", error: null });
  });

  it("carries validation errors through when Cloudflare reports them", () => {
    const mapped = mapCfStatus({
      id: "ch1",
      hostname: "status.acme.com",
      status: "pending",
      verification_errors: ["ownership pending"],
      ssl: {
        status: "pending_validation",
        validation_errors: [{ message: "CAA blocks issuance" }],
      },
    });
    expect(mapped.status).toBe("pending_dns");
    expect(mapped.error).toBe("ownership pending; CAA blocks issuance");
  });
});

describe("normalizeCustomHostname", () => {
  it("lowercases and strips a trailing dot", () => {
    expect(normalizeCustomHostname("Status.Acme.COM.")).toBe("status.acme.com");
  });

  it("rejects apex domains", () => {
    expect(() => normalizeCustomHostname("acme.com")).toThrow(/subdomain/i);
  });

  it("rejects wildcards and schemes", () => {
    expect(() => normalizeCustomHostname("*.acme.com")).toThrow(/Wildcard/i);
    expect(() => normalizeCustomHostname("https://status.acme.com")).toThrow(/hostname only/i);
  });
});
