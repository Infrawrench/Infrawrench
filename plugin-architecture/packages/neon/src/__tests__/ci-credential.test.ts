import { describe, expect, it } from "vitest";

import { lendNeonKey } from "../ci-credential.js";

describe("lendNeonKey", () => {
  it("lends the API key as NEON_API_KEY, secret as a whole", () => {
    const lent = lendNeonKey("neon-fixture-key");
    expect(lent.env).toEqual({ NEON_API_KEY: "neon-fixture-key" });
    expect(lent.files).toEqual([]);
    expect(lent.summary).not.toContain("neon-fixture-key");
  });

  it("refuses a connection with no key", () => {
    expect(() => lendNeonKey("")).toThrow("no API key");
  });
});
