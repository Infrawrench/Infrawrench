import { describe, expect, it } from "vitest";
import {
  type ProtectedBranchRule,
  combinedState,
  matchesBranchPattern,
  protectionFor,
} from "../../db/policy-rules";
import { toBase64 } from "../encoding";
import { principalActor, toCaller } from "../principal";
import { parsePublicKey, sshFingerprint } from "../ssh-keys";

/** An SSH wire string: a four-byte big-endian length, then the bytes. */
const field = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const text = (value: string) => new TextEncoder().encode(value);

const ed25519Blob = (fill = 7) =>
  concat(field(text("ssh-ed25519")), field(new Uint8Array(32).fill(fill)));

const rsaBlob = (bits: number) => {
  const modulus = new Uint8Array(bits / 8 + 1);
  modulus[1] = 0x80;
  return concat(field(text("ssh-rsa")), field(new Uint8Array([1, 0, 1])), field(modulus));
};

describe("SSH public keys", () => {
  it("parses a .pub line and fingerprints its blob", async () => {
    const blob = ed25519Blob();
    const parsed = await parsePublicKey(`ssh-ed25519 ${toBase64(blob)} astrid@laptop\n`);
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.key.algorithm).toBe("ssh-ed25519");
    expect(parsed.key.comment).toBe("astrid@laptop");
    expect(parsed.key.publicKey).toBe(toBase64(blob));
    expect(parsed.key.fingerprint).toBe(await sshFingerprint(blob));
    expect(parsed.key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("fingerprints the way ssh-keygen does", async () => {
    // `ssh-keygen -lf` of the key below prints this fingerprint.
    const line =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH example";
    const parsed = await parsePublicKey(line);
    if (!parsed.ok) throw new Error(parsed.problem);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", parsed.key.blob));
    expect(parsed.key.fingerprint).toBe(`SHA256:${toBase64(digest).replace(/=+$/, "")}`);
    expect(parsed.key.blob).toEqual(ed25519Blob());
  });

  it("keeps a comment with spaces and tolerates none", async () => {
    const encoded = toBase64(ed25519Blob());
    const spaced = await parsePublicKey(`ssh-ed25519 ${encoded} work laptop key`);
    expect(spaced.ok && spaced.key.comment).toBe("work laptop key");
    const bare = await parsePublicKey(`ssh-ed25519 ${encoded}`);
    expect(bare.ok && bare.key.comment).toBe("");
  });

  it("refuses what is not a key, or not one of the accepted types", async () => {
    expect(await parsePublicKey("")).toEqual({ ok: false, problem: "format" });
    expect(await parsePublicKey("ssh-ed25519")).toEqual({ ok: false, problem: "format" });
    expect(await parsePublicKey("ssh-ed25519 not*base64")).toEqual({
      ok: false,
      problem: "format",
    });
    expect(await parsePublicKey(`ssh-dss ${toBase64(ed25519Blob())}`)).toEqual({
      ok: false,
      problem: "algorithm",
    });
    expect(
      await parsePublicKey(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toMatchObject({ ok: false });
    // Truncated blob.
    expect(await parsePublicKey(`ssh-ed25519 ${toBase64(ed25519Blob().slice(0, 6))}`)).toEqual({
      ok: false,
      problem: "format",
    });
  });

  it("refuses a key stored under a type it is not", async () => {
    expect(await parsePublicKey(`ecdsa-sha2-nistp256 ${toBase64(ed25519Blob())}`)).toEqual({
      ok: false,
      problem: "mismatch",
    });
  });

  it("refuses short RSA keys", async () => {
    expect(await parsePublicKey(`ssh-rsa ${toBase64(rsaBlob(1024))}`)).toEqual({
      ok: false,
      problem: "weak",
    });
    expect((await parsePublicKey(`ssh-rsa ${toBase64(rsaBlob(2048))}`)).ok).toBe(true);
    expect((await parsePublicKey(`ssh-rsa ${toBase64(rsaBlob(4096))}`)).ok).toBe(true);
  });
});

describe("principals", () => {
  it("projects onto the contract's caller without leaking who owns a key", () => {
    expect(toCaller({ kind: "anonymous" }, null)).toEqual({
      userId: null,
      username: null,
      via: "anonymous",
    });
    expect(
      toCaller(
        { kind: "user", userId: "u", via: "token", scopes: ["repo:read"], credentialId: "t" },
        "astrid",
      ),
    ).toEqual({ userId: "u", username: "astrid", via: "token" });
    expect(
      toCaller(
        { kind: "api-key", apiKeyId: "k", organizationId: "o", userId: "u", permissions: [] },
        "astrid",
      ),
    ).toEqual({ userId: null, username: null, via: "api-key" });
  });

  it("names the actor of a push", () => {
    expect(principalActor({ kind: "anonymous" })).toBe(null);
    expect(
      principalActor({ kind: "deploy-key", keyId: "dk", repositoryId: "r", readOnly: false }),
    ).toEqual({ kind: "deploy-key", userId: null, credentialId: "dk" });
    expect(principalActor({ kind: "job", repositoryId: "r", write: true, runId: "run" })).toEqual({
      kind: "job",
      userId: null,
      credentialId: "run",
    });
  });
});

describe("protected-branch patterns", () => {
  it("matches names literally", () => {
    expect(matchesBranchPattern("main", "main")).toBe(true);
    expect(matchesBranchPattern("main", "main2")).toBe(false);
    expect(matchesBranchPattern("main", "feature/main")).toBe(false);
    // Regex characters in a branch name are only themselves.
    expect(matchesBranchPattern("release-1.0", "release-1x0")).toBe(false);
    expect(matchesBranchPattern("a+b", "a+b")).toBe(true);
    expect(matchesBranchPattern("(main)", "main")).toBe(false);
  });

  it("stops * at a slash and lets ** cross it", () => {
    expect(matchesBranchPattern("release/*", "release/1.0")).toBe(true);
    expect(matchesBranchPattern("release/*", "release/1.0/hotfix")).toBe(false);
    expect(matchesBranchPattern("release/**", "release/1.0/hotfix")).toBe(true);
    expect(matchesBranchPattern("*", "main")).toBe(true);
    expect(matchesBranchPattern("*", "feature/x")).toBe(false);
    expect(matchesBranchPattern("**", "feature/x")).toBe(true);
    expect(matchesBranchPattern("*-stable", "v2-stable")).toBe(true);
  });
});

describe("combined protection", () => {
  const rule = (overrides: Partial<ProtectedBranchRule>): ProtectedBranchRule => ({
    pattern: "main",
    requirePullRequest: false,
    requiredApprovals: 0,
    dismissStaleApprovals: false,
    requiredStatusContexts: [],
    allowForcePush: false,
    allowDeletion: false,
    restrictPushers: false,
    pusherUserIds: [],
    enforceAdmins: false,
    ...overrides,
  });

  it("is null for a branch no rule matches", () => {
    expect(protectionFor([rule({ pattern: "main" })], "develop")).toBe(null);
    expect(protectionFor([], "main")).toBe(null);
  });

  it("takes the strictest of each setting across the rules that match", () => {
    const protection = protectionFor(
      [
        rule({
          pattern: "release/*",
          requiredApprovals: 1,
          requiredStatusContexts: ["ci / test"],
          allowForcePush: true,
          allowDeletion: true,
        }),
        rule({
          pattern: "**",
          requiredApprovals: 2,
          requirePullRequest: true,
          requiredStatusContexts: ["ci / lint", "ci / test"],
          allowForcePush: false,
          allowDeletion: true,
          enforceAdmins: true,
        }),
        rule({ pattern: "main", requiredApprovals: 5 }),
      ],
      "release/1.0",
    );
    expect(protection).toEqual({
      patterns: ["release/*", "**"],
      requirePullRequest: true,
      requiredApprovals: 2,
      dismissStaleApprovals: false,
      requiredStatusContexts: ["ci / test", "ci / lint"],
      allowForcePush: false,
      allowDeletion: true,
      restrictPushers: false,
      pusherUserIds: [],
      enforceAdmins: true,
    });
  });

  it("lets only people every restricting rule lists push", () => {
    const protection = protectionFor(
      [
        rule({ pattern: "main", restrictPushers: true, pusherUserIds: ["a", "b"] }),
        rule({ pattern: "ma*", restrictPushers: true, pusherUserIds: ["b", "c"] }),
        rule({ pattern: "**", pusherUserIds: ["z"] }),
      ],
      "main",
    );
    expect(protection?.restrictPushers).toBe(true);
    expect(protection?.pusherUserIds).toEqual(["b"]);
  });
});

describe("combined status", () => {
  it("adds statuses up", () => {
    expect(combinedState([])).toBe(null);
    expect(combinedState(["success", "success"])).toBe("success");
    expect(combinedState(["success", "pending"])).toBe("pending");
    expect(combinedState(["pending", "failure", "success"])).toBe("failure");
    expect(combinedState(["error"])).toBe("failure");
  });
});
