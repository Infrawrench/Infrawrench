import { describe, expect, it } from "vitest";

import {
  ANY_GIT_JOB_TOKEN_WORKSPACE,
  GIT_JOB_TOKEN_MAX_TTL_SECONDS,
  GIT_JOB_TOKEN_PREFIX,
  isGitJobToken,
  signGitJobToken,
  verifyGitJobToken,
  type GitJobTokenClaims,
} from "../git-job-token";

const KEY = "k".repeat(40);
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);

const claims = (over: Partial<GitJobTokenClaims> = {}): GitJobTokenClaims => ({
  repositoryId: "7b0e3a52-5a57-4d0f-9d0c-0a6c5e1d2f33",
  access: "read",
  runId: "run-1",
  expiresAt: SECONDS + 600,
  ...over,
});

describe("git job tokens", () => {
  it("round-trips its claims", async () => {
    const token = await signGitJobToken(KEY, claims(), NOW);
    expect(token.startsWith(GIT_JOB_TOKEN_PREFIX)).toBe(true);
    expect(isGitJobToken(token)).toBe(true);
    expect(await verifyGitJobToken(KEY, token, {}, NOW)).toEqual({ ok: true, claims: claims() });
  });

  it("is refused under another key", async () => {
    const token = await signGitJobToken(KEY, claims(), NOW);
    expect(await verifyGitJobToken("x".repeat(40), token, {}, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("is refused once it has expired, to the second", async () => {
    const token = await signGitJobToken(KEY, claims(), NOW);
    expect((await verifyGitJobToken(KEY, token, {}, NOW + 599_000)).ok).toBe(true);
    expect(await verifyGitJobToken(KEY, token, {}, NOW + 600_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is only good for its own repository", async () => {
    const token = await signGitJobToken(KEY, claims(), NOW);
    const own = await verifyGitJobToken(KEY, token, { repositoryId: claims().repositoryId }, NOW);
    expect(own.ok).toBe(true);
    expect(await verifyGitJobToken(KEY, token, { repositoryId: "another" }, NOW)).toEqual({
      ok: false,
      reason: "repository",
    });
  });

  it("does not write with a read token, and reads with a write one", async () => {
    const read = await signGitJobToken(KEY, claims(), NOW);
    const write = await signGitJobToken(KEY, claims({ access: "write" }), NOW);
    expect(await verifyGitJobToken(KEY, read, { access: "write" }, NOW)).toEqual({
      ok: false,
      reason: "access",
    });
    expect((await verifyGitJobToken(KEY, read, { access: "read" }, NOW)).ok).toBe(true);
    expect((await verifyGitJobToken(KEY, write, { access: "read" }, NOW)).ok).toBe(true);
    expect((await verifyGitJobToken(KEY, write, { access: "write" }, NOW)).ok).toBe(true);
  });

  it("refuses a payload changed after signing", async () => {
    const token = await signGitJobToken(KEY, claims(), NOW);
    const [, signature] = token.slice(GIT_JOB_TOKEN_PREFIX.length).split(".");
    const forged = btoa(
      JSON.stringify({ v: 1, repo: "another", access: "write", run: "run-1", exp: SECONDS + 600 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyGitJobToken(KEY, `${GIT_JOB_TOKEN_PREFIX}${forged}.${signature}`, {}, NOW),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses anything that is not a token without throwing", async () => {
    for (const bad of [
      "",
      "iwj_",
      "iwj_abc",
      "iwj_.abc",
      "iwj_a.b.c",
      "iwj_!!!.???",
      "Bearer something",
      `iwj_${"a".repeat(2000)}.b`,
    ]) {
      expect(await verifyGitJobToken(KEY, bad, {}, NOW)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("keeps a token bound to a commit to that commit's archive", async () => {
    const commit = "c".repeat(40);
    const token = await signGitJobToken(KEY, claims({ commit }), NOW);
    expect(await verifyGitJobToken(KEY, token, { commit }, NOW)).toEqual({
      ok: true,
      claims: claims({ commit }),
    });
    // Smart HTTP and the raw route never name a commit, so they refuse it.
    expect(await verifyGitJobToken(KEY, token, {}, NOW)).toEqual({ ok: false, reason: "access" });
    expect(await verifyGitJobToken(KEY, token, { access: "read" }, NOW)).toEqual({
      ok: false,
      reason: "access",
    });
    expect(await verifyGitJobToken(KEY, token, { commit: "d".repeat(40) }, NOW)).toEqual({
      ok: false,
      reason: "access",
    });
    // An ordinary token still downloads an archive: it could clone the commit anyway.
    const plain = await signGitJobToken(KEY, claims(), NOW);
    expect((await verifyGitJobToken(KEY, plain, { commit }, NOW)).ok).toBe(true);
    await expect(signGitJobToken(KEY, claims({ commit: "main" }), NOW)).rejects.toThrow();
    // Never a way to write.
    const writing = await signGitJobToken(KEY, claims({ commit, access: "write" }), NOW);
    expect(await verifyGitJobToken(KEY, writing, { commit, access: "write" }, NOW)).toEqual({
      ok: false,
      reason: "access",
    });
  });

  it("keeps a token bound to a workspace to that workspace", async () => {
    const workspace = "0d0f7c1e-6f43-4a3e-8f37-5f8f3c1f1a10";
    const token = await signGitJobToken(KEY, claims({ workspace }), NOW);
    expect(await verifyGitJobToken(KEY, token, { workspace }, NOW)).toEqual({
      ok: true,
      claims: claims({ workspace }),
    });
    // A verifier that compares the claim itself gets it back, signed.
    expect(
      await verifyGitJobToken(KEY, token, { workspace: ANY_GIT_JOB_TOKEN_WORKSPACE }, NOW),
    ).toEqual({ ok: true, claims: claims({ workspace }) });
    // Smart HTTP, the raw route and the archive never name a workspace, so they refuse it.
    for (const expected of [
      {},
      { access: "read" as const },
      { repositoryId: claims().repositoryId },
      { commit: "c".repeat(40) },
      { workspace: "another-workspace" },
    ]) {
      expect(await verifyGitJobToken(KEY, token, expected, NOW)).toEqual({
        ok: false,
        reason: "access",
      });
    }
    // Writing its state is not writing the repository: nothing that pushes takes it.
    const applying = await signGitJobToken(KEY, claims({ workspace, access: "write" }), NOW);
    expect(await verifyGitJobToken(KEY, applying, { access: "write" }, NOW)).toEqual({
      ok: false,
      reason: "access",
    });
    expect((await verifyGitJobToken(KEY, applying, { workspace, access: "write" }, NOW)).ok).toBe(
      true,
    );
    // A workspace's state is reached with no other kind of token.
    const plain = await signGitJobToken(KEY, claims({ access: "write" }), NOW);
    for (const named of [workspace, ANY_GIT_JOB_TOKEN_WORKSPACE] as const) {
      expect(await verifyGitJobToken(KEY, plain, { workspace: named }, NOW)).toEqual({
        ok: false,
        reason: "access",
      });
    }
    // The claim is under the signature like the rest.
    const [payload, signature] = token.slice(GIT_JOB_TOKEN_PREFIX.length).split(".");
    const moved = btoa(
      atob(payload!.replace(/-/g, "+").replace(/_/g, "/")).replace(workspace, "another-workspace"),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyGitJobToken(
        KEY,
        `${GIT_JOB_TOKEN_PREFIX}${moved}.${signature}`,
        { workspace: ANY_GIT_JOB_TOKEN_WORKSPACE },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "signature" });
    await expect(signGitJobToken(KEY, claims({ workspace: "" }), NOW)).rejects.toThrow();
    await expect(
      signGitJobToken(KEY, claims({ workspace, commit: "c".repeat(40) }), NOW),
    ).rejects.toThrow();
  });

  it("does not sign what no verifier would take", async () => {
    await expect(signGitJobToken(KEY, claims({ repositoryId: "" }), NOW)).rejects.toThrow();
    await expect(signGitJobToken(KEY, claims({ expiresAt: SECONDS }), NOW)).rejects.toThrow();
    await expect(
      signGitJobToken(KEY, claims({ expiresAt: SECONDS + GIT_JOB_TOKEN_MAX_TTL_SECONDS + 1 }), NOW),
    ).rejects.toThrow();
    await expect(
      signGitJobToken(KEY, claims({ access: "admin" as unknown as "read" }), NOW),
    ).rejects.toThrow();
    await expect(signGitJobToken("short", claims(), NOW)).rejects.toThrow(/at least 32/);
  });
});
