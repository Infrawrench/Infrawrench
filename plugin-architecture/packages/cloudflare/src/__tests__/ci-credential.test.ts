import { describe, expect, it } from "vitest";

import { lendCloudflareToken } from "../ci-credential.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("lendCloudflareToken", () => {
  it("lends the token, masked, and the account ID, shown", () => {
    const lent = lendCloudflareToken("cloudflare-fixture-token", ACCOUNT);
    expect(lent.env).toEqual({
      CLOUDFLARE_API_TOKEN: "cloudflare-fixture-token",
      CLOUDFLARE_ACCOUNT_ID: [{ text: ACCOUNT }],
    });
    expect(lent.files).toEqual([]);
    expect(lent.summary).not.toContain("cloudflare-fixture-token");
  });

  it("refuses a connection with no token, and an account ID that is not one", () => {
    expect(() => lendCloudflareToken("", ACCOUNT)).toThrow("no API token");
    expect(() => lendCloudflareToken("t", "acme\nEVIL=1")).toThrow("not one");
  });
});
