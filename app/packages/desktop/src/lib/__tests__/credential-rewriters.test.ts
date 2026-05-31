import { describe, expect, it } from "vitest";
import type { RewriterContext } from "@infrawrench/plugin-base";
import { applyCredentialRewriters } from "../credential-rewriters";

describe("applyCredentialRewriters", () => {
  it("resolves without throwing when the registry is empty", async () => {
    const ctx = {} as RewriterContext;
    const creds: Record<string, string> = { token: "abc" };
    await expect(applyCredentialRewriters(ctx, creds)).resolves.toBeUndefined();
    // no registered rewriters -> credentials untouched
    expect(creds).toEqual({ token: "abc" });
  });
});
