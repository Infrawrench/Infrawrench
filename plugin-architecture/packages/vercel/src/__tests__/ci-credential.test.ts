import { describe, expect, it } from "vitest";

import { lendVercelToken } from "../ci-credential.js";

describe("lendVercelToken", () => {
  it("lends the access token as VERCEL_TOKEN, secret as a whole", () => {
    const lent = lendVercelToken("vercel-fixture-token");
    expect(lent.env).toEqual({
      VERCEL_TOKEN: "vercel-fixture-token",
      VERCEL_API_TOKEN: "vercel-fixture-token",
    });
    expect(typeof lent.env["VERCEL_TOKEN"]).toBe("string");
    expect(lent.files).toEqual([]);
    expect(lent.summary).not.toContain("vercel-fixture-token");
  });

  it("lends it under the name Terraform's provider reads too, as secret as the CLI's", () => {
    const lent = lendVercelToken("vercel-fixture-token");
    // A bare string is masked as a whole; a list of parts would show its text.
    expect(lent.env["VERCEL_API_TOKEN"]).toBe("vercel-fixture-token");
    expect(typeof lent.env["VERCEL_API_TOKEN"]).toBe("string");
    expect(lent.env["VERCEL_API_TOKEN"]).toBe(lent.env["VERCEL_TOKEN"]);
  });

  it("refuses a connection with no token", () => {
    expect(() => lendVercelToken("")).toThrow("no access token");
  });
});
