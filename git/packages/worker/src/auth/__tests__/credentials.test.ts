import { ACCESS_TOKEN_PREFIX as CONTRACT_PREFIX } from "@infrawrench/git-contract";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_PREFIX,
  parseAuthorization,
  presentedCredential,
  presentsCredentials,
} from "../credentials";
import { timingSafeEqual, timingSafeEqualText, toBase64, utf8 } from "../encoding";
import { JOB_TOKEN_MAX_TTL_SECONDS, mintJobToken, verifyJobToken } from "../job-token";
import {
  type StoredAccessToken,
  hashAccessToken,
  looksLikeAccessToken,
  mintAccessToken,
  normalizeScopes,
  verifyAccessToken,
} from "../tokens";

const basic = (username: string, password: string) =>
  `Basic ${toBase64(utf8(`${username}:${password}`))}`;

describe("parseAuthorization", () => {
  it("reads Basic and Bearer, whatever the scheme's case", () => {
    expect(parseAuthorization(basic("git", "secret"))).toEqual({
      scheme: "basic",
      username: "git",
      password: "secret",
    });
    expect(parseAuthorization("bearer abc")).toEqual({ scheme: "bearer", token: "abc" });
    expect(parseAuthorization("BASIC " + toBase64(utf8("a:b")))).toMatchObject({ username: "a" });
  });

  it("keeps colons in the password", () => {
    expect(parseAuthorization(basic("user", "a:b:c"))).toMatchObject({ password: "a:b:c" });
  });

  it("answers null for anything else", () => {
    for (const header of [null, undefined, "", "Basic", "Basic !!!", "Digest abc", "Bearer "]) {
      expect(parseAuthorization(header)).toBe(null);
    }
    // Valid base64, but no colon inside.
    expect(parseAuthorization(`Basic ${toBase64(utf8("nocolon"))}`)).toBe(null);
    // Not UTF-8.
    expect(parseAuthorization(`Basic ${toBase64(new Uint8Array([0xff, 0x3a, 0xfe]))}`)).toBe(null);
  });
});

describe("presentedCredential", () => {
  it("takes the password, whatever the username", () => {
    for (const username of ["astrid", "x-access-token", "git", ""]) {
      expect(presentedCredential(basic(username, "iwg_abc"))).toEqual({
        kind: "access-token",
        secret: "iwg_abc",
      });
    }
  });

  it("falls back to the username when the password is not a credential", () => {
    expect(presentedCredential(basic("iwg_abc", ""))?.secret).toBe("iwg_abc");
    expect(presentedCredential(basic("iwg_abc", "x-oauth-basic"))?.secret).toBe("iwg_abc");
  });

  it("tells the three kinds apart by prefix", () => {
    expect(presentedCredential("Bearer iwg_a")?.kind).toBe("access-token");
    expect(presentedCredential("Bearer iwk_a")?.kind).toBe("api-key");
    expect(presentedCredential("Bearer iwj_a")?.kind).toBe("job-token");
    expect(presentedCredential(basic("git", "iwk_a"))?.kind).toBe("api-key");
  });

  it("answers null for a password that is nobody's token", () => {
    expect(presentedCredential(basic("astrid", "hunter2"))).toBe(null);
    expect(presentedCredential("Bearer eyJhbGciOi")).toBe(null);
  });

  it("knows a refused attempt from no attempt", () => {
    expect(presentsCredentials(null)).toBe(false);
    expect(presentsCredentials("")).toBe(false);
    expect(presentsCredentials(basic("astrid", "hunter2"))).toBe(true);
  });

  it("uses the contract's token prefix", () => {
    expect(ACCESS_TOKEN_PREFIX).toBe(CONTRACT_PREFIX);
  });
});

describe("timingSafeEqual", () => {
  it("compares bytes", () => {
    expect(timingSafeEqual(utf8("abc"), utf8("abc"))).toBe(true);
    expect(timingSafeEqual(utf8("abc"), utf8("abd"))).toBe(false);
    expect(timingSafeEqual(utf8("abc"), utf8("abcd"))).toBe(false);
    expect(timingSafeEqual(utf8(""), utf8(""))).toBe(true);
    expect(timingSafeEqualText("a", "a")).toBe(true);
    // A longer input that starts with the shorter one, padded with zeros, is still different.
    expect(timingSafeEqual(new Uint8Array([1, 0]), new Uint8Array([1]))).toBe(false);
  });
});

describe("personal access tokens", () => {
  const stored = (hash: string, overrides: Partial<StoredAccessToken> = {}): StoredAccessToken => ({
    id: "tok_1",
    userId: "user_1",
    hashedToken: hash,
    scopes: ["repo:read", "repo:write"],
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });

  it("mints a token whose hash is its SHA-256 and whose prefix shows eight characters", async () => {
    const minted = await mintAccessToken();
    expect(minted.secret.startsWith("iwg_")).toBe(true);
    expect(looksLikeAccessToken(minted.secret)).toBe(true);
    expect(minted.prefix).toBe(minted.secret.slice(0, 12));
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.hash).toBe(await hashAccessToken(minted.secret));
    expect((await mintAccessToken()).secret).not.toBe(minted.secret);
  });

  it("hashes with plain SHA-256", async () => {
    expect(await hashAccessToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("verifies a live token and reports its scopes", async () => {
    const minted = await mintAccessToken();
    const verified = await verifyAccessToken(minted.secret, async (hash) =>
      hash === minted.hash ? stored(minted.hash) : null,
    );
    expect(verified).toEqual({
      id: "tok_1",
      userId: "user_1",
      scopes: ["repo:read", "repo:write"],
    });
  });

  it("refuses unknown, revoked and expired tokens alike", async () => {
    const minted = await mintAccessToken();
    const now = new Date("2026-11-25T12:00:00Z");
    const find = (row: StoredAccessToken | null) => async () => row;
    expect(await verifyAccessToken(minted.secret, find(null), now)).toBe(null);
    expect(
      await verifyAccessToken(minted.secret, find(stored(minted.hash, { revokedAt: now })), now),
    ).toBe(null);
    expect(
      await verifyAccessToken(
        minted.secret,
        find(stored(minted.hash, { expiresAt: new Date("2026-11-25T11:59:59Z") })),
        now,
      ),
    ).toBe(null);
    expect(
      await verifyAccessToken(minted.secret, find(stored(minted.hash, { expiresAt: now })), now),
    ).toBe(null);
    expect(
      await verifyAccessToken(
        minted.secret,
        find(stored(minted.hash, { expiresAt: new Date("2026-11-25T12:00:01Z") })),
        now,
      ),
    ).not.toBe(null);
  });

  it("refuses a row whose stored hash is not the token's", async () => {
    const minted = await mintAccessToken();
    expect(await verifyAccessToken(minted.secret, async () => stored("0".repeat(64)))).toBe(null);
  });

  it("does not query for something that cannot be a token", async () => {
    let asked = 0;
    const find = async () => {
      asked++;
      return null;
    };
    for (const junk of [
      "",
      "iwg_",
      "iwg_short",
      "iwk_" + "a".repeat(43),
      "iwg_" + "!".repeat(43),
    ]) {
      expect(await verifyAccessToken(junk, find)).toBe(null);
    }
    expect(asked).toBe(0);
  });

  it("drops scopes it does not know", () => {
    expect(normalizeScopes(["repo:write", "admin", "repo:read", "repo:read"])).toEqual([
      "repo:read",
      "repo:write",
    ]);
    expect(normalizeScopes([])).toEqual([]);
  });
});

describe("CI job tokens", () => {
  const KEY = "k".repeat(48);
  const NOW = 1_800_000_000;

  it("round-trips its claims", async () => {
    const token = await mintJobToken(KEY, {
      repositoryId: "repo_1",
      write: true,
      runId: "run_1",
      now: NOW,
    });
    expect(token.startsWith("iwj_")).toBe(true);
    expect(await verifyJobToken(KEY, token, NOW + 10)).toEqual({
      repositoryId: "repo_1",
      write: true,
      runId: "run_1",
      expiresAt: NOW + 3600,
    });
  });

  it("is read-only unless minted for writing, and names no run unless given one", async () => {
    const token = await mintJobToken(KEY, { repositoryId: "repo_1", write: false, now: NOW });
    expect(await verifyJobToken(KEY, token, NOW)).toMatchObject({ write: false, runId: null });
  });

  it("expires", async () => {
    const token = await mintJobToken(KEY, {
      repositoryId: "repo_1",
      write: false,
      ttlSeconds: 60,
      now: NOW,
    });
    expect(await verifyJobToken(KEY, token, NOW + 59)).not.toBe(null);
    expect(await verifyJobToken(KEY, token, NOW + 60)).toBe(null);
  });

  it("clamps the lifetime", async () => {
    const token = await mintJobToken(KEY, {
      repositoryId: "repo_1",
      write: false,
      ttlSeconds: 10 * 24 * 3600,
      now: NOW,
    });
    expect((await verifyJobToken(KEY, token, NOW))?.expiresAt).toBe(
      NOW + JOB_TOKEN_MAX_TTL_SECONDS,
    );
  });

  it("refuses another key's token", async () => {
    const token = await mintJobToken(KEY, { repositoryId: "repo_1", write: true, now: NOW });
    expect(await verifyJobToken("x".repeat(48), token, NOW)).toBe(null);
  });

  it("refuses altered claims", async () => {
    const token = await mintJobToken(KEY, { repositoryId: "repo_1", write: false, now: NOW });
    const [, tag] = token.slice(4).split(".");
    const forged = toBase64(
      utf8(JSON.stringify({ v: 1, repo: "repo_2", w: true, exp: NOW + 3600 })),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyJobToken(KEY, `iwj_${forged}.${tag}`, NOW)).toBe(null);
  });

  it("refuses malformed tokens", async () => {
    for (const junk of ["", "iwj_", "iwj_a", "iwj_a.b", "iwj_a.b.c", "iwg_a.b", "iwj_.abc"]) {
      expect(await verifyJobToken(KEY, junk, NOW)).toBe(null);
    }
  });

  it("refuses to work with a short key", async () => {
    await expect(mintJobToken("short", { repositoryId: "repo_1", write: false })).rejects.toThrow(
      /JOB_TOKEN_KEY/,
    );
  });
});
