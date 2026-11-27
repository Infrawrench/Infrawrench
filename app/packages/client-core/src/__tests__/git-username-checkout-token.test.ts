import { describe, expect, it } from "vitest";
import { GIT_SHORT_USERNAME_PRICE_CENTS, gitUsernamePriceCents } from "../git-forge";
import { signGitJobToken } from "../git-job-token";
import {
  GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS,
  signGitUsernameCheckoutToken,
  verifyGitUsernameCheckoutToken,
} from "../git-username-checkout-token";

const KEY = "k".repeat(40);
const NOW = 1_800_000_000_000;

describe("username checkout token", () => {
  it("round-trips the hold and its owner", async () => {
    const token = await signGitUsernameCheckoutToken(KEY, { holdId: "h1", userId: "u1" }, NOW);
    expect(token.startsWith("iwu_")).toBe(true);
    expect(await verifyGitUsernameCheckoutToken(KEY, token, NOW)).toEqual({
      ok: true,
      claims: {
        holdId: "h1",
        userId: "u1",
        expiresAt: NOW / 1000 + GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS,
      },
    });
  });

  it("expires", async () => {
    const token = await signGitUsernameCheckoutToken(KEY, { holdId: "h1", userId: "u1" }, NOW);
    const later = NOW + GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS * 1000;
    expect(await verifyGitUsernameCheckoutToken(KEY, token, later)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses another key, a changed payload and junk", async () => {
    const token = await signGitUsernameCheckoutToken(KEY, { holdId: "h1", userId: "u1" }, NOW);
    expect((await verifyGitUsernameCheckoutToken("x".repeat(40), token, NOW)).ok).toBe(false);
    const signature = token.slice(4).split(".")[1];
    const forged = btoa(JSON.stringify({ v: 1, hold: "h1", user: "u2", exp: NOW / 1000 + 60 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await verifyGitUsernameCheckoutToken(KEY, `iwu_${forged}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect((await verifyGitUsernameCheckoutToken(KEY, "iwu_nope", NOW)).ok).toBe(false);
  });

  it("is not a job token, and a job token is not one", async () => {
    const job = await signGitJobToken(
      KEY,
      { repositoryId: "r", access: "read", runId: "run", expiresAt: NOW / 1000 + 60 },
      NOW,
    );
    expect((await verifyGitUsernameCheckoutToken(KEY, job, NOW)).ok).toBe(false);
    // The same payload under the other prefix fails the signature: the labels differ.
    expect(await verifyGitUsernameCheckoutToken(KEY, `iwu_${job.slice(4)}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });
});

describe("gitUsernamePriceCents", () => {
  it("charges for 6 characters or fewer, and nothing for 7", () => {
    expect(gitUsernamePriceCents("abcdef")).toBe(GIT_SHORT_USERNAME_PRICE_CENTS);
    expect(gitUsernamePriceCents("a")).toBe(GIT_SHORT_USERNAME_PRICE_CENTS);
    expect(gitUsernamePriceCents("abcdefg")).toBeNull();
  });

  it("never charges for the name already held, or a change of its case", () => {
    expect(gitUsernamePriceCents("mara", "mara")).toBeNull();
    expect(gitUsernamePriceCents("Mara", "mara")).toBeNull();
    expect(gitUsernamePriceCents("maro", "mara")).toBe(GIT_SHORT_USERNAME_PRICE_CENTS);
    expect(gitUsernamePriceCents("maro", null)).toBe(GIT_SHORT_USERNAME_PRICE_CENTS);
  });
});
