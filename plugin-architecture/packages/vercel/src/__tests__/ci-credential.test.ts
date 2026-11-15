import { describe, expect, it } from "vitest";

import { lendVercelToken } from "../ci-credential.js";

describe("lendVercelToken", () => {
  it("lends the access token as VERCEL_TOKEN, secret as a whole", () => {
    const lent = lendVercelToken("vercel-fixture-token");
    expect(lent.env).toEqual({ VERCEL_TOKEN: "vercel-fixture-token" });
    expect(typeof lent.env["VERCEL_TOKEN"]).toBe("string");
    expect(lent.files).toEqual([]);
    expect(lent.summary).not.toContain("vercel-fixture-token");
  });

  it("refuses a connection with no token", () => {
    expect(() => lendVercelToken("")).toThrow("no access token");
  });
});
