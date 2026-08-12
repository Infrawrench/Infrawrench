import { describe, expect, it, vi } from "vitest";

// custom-hostname → store → db/client, which throws without DATABASE_URL.
vi.mock("../../db/client", () => ({ db: {} }));

import { normalizeCustomHostname } from "../custom-hostname";

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
