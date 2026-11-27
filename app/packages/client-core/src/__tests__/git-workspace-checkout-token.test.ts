import { describe, expect, it } from "vitest";
import { GIT_WORKSPACE_NAME_MAX_LENGTH, gitWorkspaceNameProblem } from "../git-forge";
import { signGitJobToken } from "../git-job-token";
import {
  signGitUsernameCheckoutToken,
  verifyGitUsernameCheckoutToken,
} from "../git-username-checkout-token";
import {
  GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS,
  GIT_WORKSPACE_RETURN_PATH_MAX_LENGTH,
  signGitWorkspaceCheckoutToken,
  verifyGitWorkspaceCheckoutToken,
} from "../git-workspace-checkout-token";

const KEY = "k".repeat(40);
const NOW = 1_800_000_000_000;
const CLAIMS = {
  organizationId: "0b0e1c1e-6d0f-4d0c-9a52-0a4c6f1f6f11",
  userId: "user_01",
  name: "Ada's workspace",
  returnPath: "/onboarding/username?username=ada-lovelace",
};

const encode = (body: unknown) =>
  btoa(JSON.stringify(body)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("workspace checkout token", () => {
  it("round-trips the organisation, its owner, its name and the page to return to", async () => {
    const token = await signGitWorkspaceCheckoutToken(KEY, CLAIMS, NOW);
    expect(token.startsWith("iww_")).toBe(true);
    expect(await verifyGitWorkspaceCheckoutToken(KEY, token, NOW)).toEqual({
      ok: true,
      claims: { ...CLAIMS, expiresAt: NOW / 1000 + GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS },
    });
  });

  it("carries the longest name and return path, in any script", async () => {
    const claims = {
      ...CLAIMS,
      name: "組".repeat(GIT_WORKSPACE_NAME_MAX_LENGTH),
      returnPath: `/${"é".repeat(GIT_WORKSPACE_RETURN_PATH_MAX_LENGTH - 1)}`,
    };
    const token = await signGitWorkspaceCheckoutToken(KEY, claims, NOW);
    const verified = await verifyGitWorkspaceCheckoutToken(KEY, token, NOW);
    expect(verified.ok && verified.claims.name).toBe(claims.name);
    expect(verified.ok && verified.claims.returnPath).toBe(claims.returnPath);
  });

  it("expires", async () => {
    const token = await signGitWorkspaceCheckoutToken(KEY, CLAIMS, NOW);
    const justBefore = NOW + (GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS - 1) * 1000;
    expect((await verifyGitWorkspaceCheckoutToken(KEY, token, justBefore)).ok).toBe(true);
    const later = NOW + GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS * 1000;
    expect(await verifyGitWorkspaceCheckoutToken(KEY, token, later)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses another key, a changed payload and junk", async () => {
    const token = await signGitWorkspaceCheckoutToken(KEY, CLAIMS, NOW);
    expect(await verifyGitWorkspaceCheckoutToken("x".repeat(40), token, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    const signature = token.slice(4).split(".")[1];
    // The same request for someone else, under the first one's signature.
    const forged = encode({
      v: 1,
      org: CLAIMS.organizationId,
      user: "user_02",
      name: CLAIMS.name,
      back: CLAIMS.returnPath,
      exp: NOW / 1000 + 60,
    });
    expect(await verifyGitWorkspaceCheckoutToken(KEY, `iww_${forged}.${signature}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    for (const junk of ["", "iww_", "iww_nope", "iww_a.b.c", `iww_${"a".repeat(5000)}.b`]) {
      expect(await verifyGitWorkspaceCheckoutToken(KEY, junk, NOW)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("is not a job token or a username token, and neither is one of these", async () => {
    const job = await signGitJobToken(
      KEY,
      { repositoryId: "r", access: "read", runId: "run", expiresAt: NOW / 1000 + 60 },
      NOW,
    );
    const username = await signGitUsernameCheckoutToken(KEY, { holdId: "h1", userId: "u1" }, NOW);
    const workspace = await signGitWorkspaceCheckoutToken(KEY, CLAIMS, NOW);

    for (const other of [job, username]) {
      expect((await verifyGitWorkspaceCheckoutToken(KEY, other, NOW)).ok).toBe(false);
      // The same payload and signature under this prefix: the labels differ.
      expect(await verifyGitWorkspaceCheckoutToken(KEY, `iww_${other.slice(4)}`, NOW)).toEqual({
        ok: false,
        reason: "signature",
      });
    }
    expect((await verifyGitUsernameCheckoutToken(KEY, workspace, NOW)).ok).toBe(false);
    expect(await verifyGitUsernameCheckoutToken(KEY, `iwu_${workspace.slice(4)}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("never signs a return path that leaves the forge, or a name the app would refuse", async () => {
    const sign = (over: Partial<typeof CLAIMS>) =>
      signGitWorkspaceCheckoutToken(KEY, { ...CLAIMS, ...over }, NOW);
    for (const returnPath of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "onboarding",
      "/a\nb",
      `/${"a".repeat(GIT_WORKSPACE_RETURN_PATH_MAX_LENGTH)}`,
    ]) {
      await expect(sign({ returnPath })).rejects.toThrow();
    }
    for (const name of [
      "",
      "   ",
      " Ada",
      "a".repeat(GIT_WORKSPACE_NAME_MAX_LENGTH + 1),
      "a\u0000b",
    ]) {
      await expect(sign({ name })).rejects.toThrow();
    }
    await expect(sign({ organizationId: "not an id" })).rejects.toThrow();
  });
});

describe("gitWorkspaceNameProblem", () => {
  it("takes a name as people write them", () => {
    expect(gitWorkspaceNameProblem("Ada's workspace")).toBeNull();
    expect(gitWorkspaceNameProblem("Acme, Inc.")).toBeNull();
    expect(gitWorkspaceNameProblem("a".repeat(GIT_WORKSPACE_NAME_MAX_LENGTH))).toBeNull();
  });

  it("says what is wrong with one it refuses", () => {
    expect(gitWorkspaceNameProblem("")).toBe("Give the organisation a name");
    expect(gitWorkspaceNameProblem("  ")).toBe("Give the organisation a name");
    expect(gitWorkspaceNameProblem("Acme ")).toMatch(/space/);
    expect(gitWorkspaceNameProblem("a".repeat(GIT_WORKSPACE_NAME_MAX_LENGTH + 1))).toMatch(/100/);
  });
});
